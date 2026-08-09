/**
 * Jikonavi LIFF consultation form Edge Function.
 * Receives structured LINE form submissions and registers patients in CRM.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";

import { generateHmacSignature } from "../_shared/auth-utils.ts";
import {
  cleanPatientName,
  resolveNameKana,
  sanitizeKana,
} from "../_shared/name-utils.ts";
import { normalizePhone } from "../_shared/phone-utils.ts";

const ALLOWED_ORIGINS = [
  "https://328ry-opus.github.io",
  "https://jiko-navi.jp",
  "https://www.jiko-navi.jp",
  "http://localhost",
  "http://127.0.0.1",
];
const MAX_PAYLOAD_BYTES = 32 * 1024;

const PREFECTURES = new Set([
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
]);

const ACCIDENT_SITUATIONS = new Set([
  "追突（被害者）",
  "出合い頭",
  "加害者",
  "不明",
]);
const SYMPTOMS = new Set([
  "首・肩",
  "腰・背中",
  "頭痛・めまい",
  "手足",
  "症状なし",
  "その他",
]);
const CONTACT_TIMES = new Set([
  "午前",
  "午後",
  "夕方以降",
  "いつでもOK",
]);

const BLOCKED_PHONE_DIGITS = new Set(
  (Deno.env.get("CHAT_FORM_BLOCKED_PHONES") || "")
    .split(",")
    .map((value) => value.replace(/\D/g, ""))
    .filter(Boolean),
);

type LineFormPayload = {
  accident_situation?: unknown;
  accident_date?: unknown;
  symptoms?: unknown;
  pref?: unknown;
  area?: unknown;
  name?: unknown;
  phone?: unknown;
  contact_time?: unknown;
  line_user_id?: unknown;
  liff_context_type?: unknown;
};

type ValidatedPayload = {
  accidentSituation: string;
  accidentDate: string;
  symptoms: string[];
  pref: string;
  area: string;
  name: string;
  phoneDigits: string;
  contactTime: string;
  lineUserId: string | null;
  liffContextType: string | null;
};

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return true;
    }
    return ALLOWED_ORIGINS.some((allowed) => {
      try {
        return parsed.origin === new URL(allowed).origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin)
      ? origin
      : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function normalizePhoneDigits(value: unknown): string {
  return String(value ?? "")
    .replace(
      /[０-９]/g,
      (character) => String.fromCharCode(character.charCodeAt(0) - 0xFEE0),
    )
    .replace(/\D/g, "");
}

function stringValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function validatePayload(payload: LineFormPayload):
  | { data: ValidatedPayload; error: null }
  | { data: null; error: string } {
  const accidentSituation = stringValue(payload.accident_situation, 50);
  const accidentDate = stringValue(payload.accident_date, 10);
  const area = stringValue(payload.area, 100);
  const name = cleanPatientName(stringValue(payload.name, 100));
  const phoneDigits = normalizePhoneDigits(payload.phone);
  const contactTime = stringValue(payload.contact_time, 30);
  const prefValue = stringValue(payload.pref, 10);
  const pref = PREFECTURES.has(prefValue) ? prefValue : "";
  const lineUserId = stringValue(payload.line_user_id, 255) || null;
  const liffContextType = stringValue(payload.liff_context_type, 50) || null;
  const symptoms = Array.isArray(payload.symptoms)
    ? [...new Set(payload.symptoms.map((value) => stringValue(value, 30)))]
    : [];

  if (name.length < 2) return { data: null, error: "Invalid name" };
  if (!/^0\d{9,10}$/.test(phoneDigits)) {
    return { data: null, error: "Invalid phone number" };
  }
  if (!ACCIDENT_SITUATIONS.has(accidentSituation)) {
    return { data: null, error: "Invalid accident situation" };
  }
  if (!isValidDate(accidentDate)) {
    return { data: null, error: "Invalid accident date" };
  }
  if (symptoms.length === 0 || symptoms.some((value) => !SYMPTOMS.has(value))) {
    return { data: null, error: "Invalid symptoms" };
  }
  if (!area) return { data: null, error: "Invalid area" };
  if (!CONTACT_TIMES.has(contactTime)) {
    return { data: null, error: "Invalid contact time" };
  }

  return {
    data: {
      accidentSituation,
      accidentDate,
      symptoms,
      pref,
      area,
      name,
      phoneDigits,
      contactTime,
      lineUserId,
      liffContextType,
    },
    error: null,
  };
}

async function linkLineMessageLog(
  supabase: SupabaseClient,
  lineUserId: string,
  patientId: string,
): Promise<void> {
  const { data: existing, error: selectError } = await supabase
    .from("line_message_log")
    .select("id")
    .eq("line_user_id", lineUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectError) throw selectError;

  if (existing) {
    const { error } = await supabase.from("line_message_log").update({
      status: "registered",
      patient_id: patientId,
      updated_at: new Date().toISOString(),
    }).eq("id", existing.id);
    if (error) throw error;
    return;
  }

  const { error } = await supabase.from("line_message_log").insert({
    line_user_id: lineUserId,
    status: "registered",
    messages: [],
    patient_id: patientId,
  });
  if (error) throw error;
}

async function notifyStaff(
  payload: ValidatedPayload,
  formattedPhone: string,
  address: string,
  patientId: string,
): Promise<void> {
  const webhookUrl = Deno.env.get("GAS_NOTIFY_WEBHOOK_URL");
  const webhookSecret = Deno.env.get("GAS_WEBHOOK_SECRET");
  if (!webhookUrl) return;

  const body = JSON.stringify({
    source: "line-form",
    type: "new_patient",
    name: payload.name,
    phone: formattedPhone,
    area: address,
    accident_type: payload.accidentSituation,
    accident_date: payload.accidentDate,
    symptoms: payload.symptoms.join("、"),
    contact_time: payload.contactTime,
    patient_id: patientId,
  });

  try {
    let fetchUrl = webhookUrl;
    if (webhookSecret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = await generateHmacSignature(
        `${timestamp}.${body}`,
        webhookSecret,
      );
      const separator = webhookUrl.includes("?") ? "&" : "?";
      fetchUrl = `${webhookUrl}${separator}ts=${timestamp}&sig=${
        encodeURIComponent(signature)
      }`;
    }

    const response = await fetch(fetchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
      },
      redirect: "follow",
      body,
    });
    const responseBody = await response.text();
    console.log("GAS webhook response:", {
      status: response.status,
      body: responseBody.slice(0, 300),
    });
    if (!response.ok) {
      console.error("GAS webhook non-2xx:", response.status);
    }
  } catch (error) {
    console.error("GAS notification failed:", error);
  }
}

serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  const headers = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, headers);
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_PAYLOAD_BYTES) {
    return jsonResponse({ error: "Payload too large" }, 413, headers);
  }

  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch {
    return jsonResponse({ error: "Unable to read request body" }, 400, headers);
  }

  if (new TextEncoder().encode(rawBody).byteLength > MAX_PAYLOAD_BYTES) {
    return jsonResponse({ error: "Payload too large" }, 413, headers);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, headers);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return jsonResponse({ error: "Invalid payload" }, 400, headers);
  }

  const validated = validatePayload(parsed as LineFormPayload);
  if (!validated.data) {
    return jsonResponse(
      { success: false, error: validated.error },
      400,
      headers,
    );
  }

  const payload = validated.data;
  if (BLOCKED_PHONE_DIGITS.has(payload.phoneDigits)) {
    // Silent block, same intent as chat-form: the sender sees the normal
    // completion screen so they do not retry; nothing is registered.
    console.warn("Blocked line-form submission (phone blocklist):", {
      phone: payload.phoneDigits,
      has_line_user_id: Boolean(payload.lineUserId),
    });
    return jsonResponse(
      { success: true, patient_id: null, blocked: true },
      200,
      headers,
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    console.error("Supabase credentials not set");
    return jsonResponse(
      { success: false, error: "Internal server error" },
      500,
      headers,
    );
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const formattedPhone = normalizePhone(payload.phoneDigits);
  const address = payload.pref + payload.area;
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY") || "";
  const resolvedName = geminiApiKey
    ? await resolveNameKana(geminiApiKey, payload.name)
    : {
      nameKana: sanitizeKana(payload.name),
      nameKanji: "",
      kanaPredicted: false,
    };

  let duplicateNote = "";
  try {
    const { data: duplicates, error } = await supabase.rpc(
      "find_duplicate_patients",
      {
        p_phone: formattedPhone || null,
        p_name_kana: resolvedName.nameKana || null,
        p_exclude_id: null,
      },
    );
    if (error) {
      console.warn("Duplicate check failed:", error.message);
    } else if (duplicates?.length) {
      duplicateNote = `\n【重複の可能性】既存患者: ${
        duplicates.map((
          duplicate: { name_kanji?: string; id: string; status?: string },
        ) =>
          `${duplicate.name_kanji || duplicate.id}(${duplicate.status || ""})`
        ).join(", ")
      }`;
    }
  } catch (error) {
    console.warn("Duplicate check failed:", error);
  }

  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const today = jst.toISOString().slice(0, 10);
  const time = jst.toISOString().slice(11, 16);
  const symptomText = payload.symptoms.join("、");
  const notes = [
    "【LINE経由・フォーム】",
    `事故状況: ${payload.accidentSituation}`,
    `症状: ${symptomText}`,
    `希望エリア: ${address}`,
    `連絡希望: ${payload.contactTime}`,
    payload.lineUserId ? `LINE User ID: ${payload.lineUserId}` : "",
    payload.liffContextType ? `LIFF Context: ${payload.liffContextType}` : "",
    resolvedName.kanaPredicted
      ? `ふりがな「${resolvedName.nameKana}」はAI予測です（要確認）`
      : "",
  ].filter(Boolean).join("\n") + duplicateNote;

  const patientId = "p" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const { error: patientError } = await supabase.from("patients").insert({
    id: patientId,
    name_kanji: resolvedName.nameKanji || payload.name,
    name_kana: resolvedName.nameKana || "",
    phone: formattedPhone,
    pref: payload.pref || null,
    area: payload.area,
    address,
    channel: "line",
    status: "問合せ受付",
    staff: "ボット",
    inquiry_date: today,
    inquiry_time: time,
    accident_date: payload.accidentDate,
    injury_part: symptomText,
    next_date: today,
    notes,
    check_permission: false,
    check_clinic: false,
    check_contacted: false,
    check_sent: false,
  });

  if (patientError) {
    console.error("Patient insert error:", patientError.message);
    return jsonResponse(
      { success: false, error: "Patient registration failed" },
      500,
      headers,
    );
  }

  if (payload.lineUserId) {
    // This value is client-provided and is not authenticated. The risk is
    // equivalent to the existing unauthenticated public chat form.
    try {
      await linkLineMessageLog(supabase, payload.lineUserId, patientId);
    } catch (error) {
      console.error("LINE message log link failed:", error);
    }
  }

  await notifyStaff(payload, formattedPhone, address, patientId);

  return jsonResponse({ success: true, patient_id: patientId }, 200, headers);
});
