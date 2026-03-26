/**
 * Phone Service Intake Edge Function
 * Receives parsed email data from GAS trigger, classifies via Gemini,
 * and creates patient records in CRM for new inquiries.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Shared-Secret",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  const headers = { ...CORS_HEADERS, "Content-Type": "application/json" };

  try {
    // ── Auth: shared secret ──
    const secret = Deno.env.get("PHONE_SERVICE_SECRET");
    const provided = req.headers.get("X-Shared-Secret");
    if (!secret || provided !== secret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const body = await req.json();
    const { message_id, email_body, received_at } = body;

    if (!message_id || !email_body) {
      return new Response(
        JSON.stringify({ error: "message_id and email_body are required" }),
        { status: 400, headers },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) throw new Error("Supabase credentials not set");

    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── Dedup check ──
    const { data: existing } = await supabase
      .from("phone_service_log")
      .select("id")
      .eq("message_id", message_id)
      .maybeSingle();

    if (existing) {
      return new Response(
        JSON.stringify({ success: true, skipped: true, reason: "already_processed" }),
        { status: 200, headers },
      );
    }

    // ── Gemini: parse email + classify ──
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");

    const parsePrompt = `以下は電話代行サービスからの受電通知メールです。JSONで回答してください。他の文字や説明は一切不要です。

メール本文:
${email_body}

以下のJSON形式で出力してください:
{
  "type": "new_patient" または "existing_inquiry",
  "received_at": "受電日時（メール本文から抽出）",
  "requirement": "要件の内容",
  "accident_date": "事故日（あれば）",
  "accident_detail": "事故状況（あれば）",
  "preferred_area": "通院エリア（あれば）",
  "patient_name": "名前（「様」は除く）",
  "phone": "電話番号",
  "callback_time": "折り返し希望時間帯（あれば）",
  "extra_notes": "上記に含まれないが重要な情報（あれば）"
}

判定基準:
- "new_patient": 交通事故に遭って通院先を探している、新規の問い合わせ
- "existing_inquiry": 既存の患者や院についての連絡、問い合わせ、確認事項`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: parsePrompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 500,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini parse error:", geminiRes.status, errText);
      await logEntry(supabase, message_id, null, "parse_error", email_body, null, `Gemini API error: ${geminiRes.status}`);
      await notifyStaff("parse_error", null, email_body);
      return new Response(JSON.stringify({ success: false, error: "Gemini parse failed" }), { status: 500, headers });
    }

    const geminiJson = await geminiRes.json();
    const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    let parsed: any;
    try {
      parsed = JSON.parse(rawText || "{}");
    } catch {
      console.error("Failed to parse Gemini JSON:", rawText);
      await logEntry(supabase, message_id, null, "parse_error", email_body, null, `Invalid JSON: ${rawText?.slice(0, 200)}`);
      await notifyStaff("parse_error", null, email_body);
      return new Response(JSON.stringify({ success: false, error: "Parse failed" }), { status: 500, headers });
    }

    // ── existing_inquiry: notify only, no CRM registration ──
    if (parsed.type === "existing_inquiry") {
      await logEntry(supabase, message_id, null, "skipped_existing", email_body, parsed, null);
      await notifyStaff("existing_inquiry", parsed, email_body);
      return new Response(
        JSON.stringify({ success: true, type: "existing_inquiry", notified: true }),
        { status: 200, headers },
      );
    }

    // ── new_patient: normalize + register ──
    const patientName = (parsed.patient_name || "").replace(/様$/, "").trim();
    const rawPhone = parsed.phone || "";

    // Normalize phone
    const phone = normalizePhone(rawPhone);

    // Resolve furigana via Gemini
    const { nameKana, nameKanji, kanaPredicted } = await resolveNameKana(apiKey, patientName);

    // Parse received_at to date/time
    const { date: inquiryDate, time: inquiryTime } = parseReceivedAt(parsed.received_at || received_at);

    // Parse accident date
    const accidentDate = parseAccidentDate(parsed.accident_date);

    // Duplicate check
    let dupNote = "";
    try {
      const { data: dups } = await supabase.rpc("find_duplicate_patients", {
        p_phone: phone || null,
        p_name_kana: nameKana || null,
        p_exclude_id: null,
      });
      if (dups && dups.length > 0) {
        dupNote = `\n【重複の可能性】既存患者: ${dups.map((d: any) => `${d.name_kanji || d.id}(${d.status})`).join(", ")}`;
      }
    } catch (e) {
      console.error("Duplicate check failed:", e);
    }

    // Build notes
    const notes = [
      "【電話代行経由】",
      parsed.requirement ? `要件: ${parsed.requirement}` : "",
      parsed.accident_detail ? `事故状況: ${parsed.accident_detail}` : "",
      parsed.preferred_area ? `希望エリア: ${parsed.preferred_area}` : "",
      parsed.callback_time ? `折り返し希望: ${parsed.callback_time}` : "",
      parsed.extra_notes ? `備考: ${parsed.extra_notes}` : "",
      kanaPredicted ? `ふりがな「${nameKana}」はAI予測です（要確認）` : "",
    ].filter(Boolean).join("\n") + dupNote;

    // Insert patient
    const patientId = "p" + Date.now();
    const { error: patientError } = await supabase.from("patients").insert({
      id: patientId,
      name_kanji: nameKanji || patientName || "",
      name_kana: nameKana || "",
      phone,
      address: parsed.preferred_area || "",
      channel: "phone-service",
      status: "問合せ受付",
      staff: "ボット",
      inquiry_date: inquiryDate,
      inquiry_time: inquiryTime,
      accident_date: accidentDate,
      next_date: inquiryDate,
      notes,
      check_permission: false,
      check_clinic: false,
      check_contacted: false,
      check_sent: false,
    });

    if (patientError) {
      console.error("Patient insert error:", patientError.message);
      await logEntry(supabase, message_id, null, "parse_error", email_body, parsed, patientError.message);
      return new Response(JSON.stringify({ success: false, error: "Patient insert failed" }), { status: 500, headers });
    }

    // Log success
    await logEntry(supabase, message_id, patientId, "success", email_body, parsed, null);

    // Notify staff
    await notifyStaff("new_patient", { ...parsed, patient_id: patientId, name_kana: nameKana }, email_body);

    return new Response(
      JSON.stringify({ success: true, patient_id: patientId, type: "new_patient" }),
      { status: 200, headers },
    );
  } catch (err) {
    console.error("Phone service intake error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  }
});

// ── Helper: log to phone_service_log ──
async function logEntry(
  supabase: any, messageId: string, patientId: string | null,
  status: string, rawBody: string, parsedData: any, errorMessage: string | null,
) {
  try {
    await supabase.from("phone_service_log").insert({
      message_id: messageId,
      patient_id: patientId,
      status,
      raw_body: rawBody,
      parsed_data: parsedData,
      error_message: errorMessage,
    });
  } catch (e) {
    console.error("Log entry failed:", e);
  }
}

// ── Helper: GAS webhook notification ──
async function notifyStaff(type: string, parsed: any, rawBody: string) {
  const GAS_WEBHOOK_URL = Deno.env.get("GAS_NOTIFY_WEBHOOK_URL");
  if (!GAS_WEBHOOK_URL) {
    console.error("GAS_NOTIFY_WEBHOOK_URL not set");
    return;
  }

  try {
    const payload: any = { source: "phone-service", type };

    if (type === "new_patient" && parsed) {
      payload.name = parsed.patient_name || "";
      payload.phone = parsed.phone || "";
      payload.area = parsed.preferred_area || "";
      payload.requirement = parsed.requirement || "";
      payload.accident_detail = parsed.accident_detail || "";
      payload.callback_time = parsed.callback_time || "";
      payload.patient_id = parsed.patient_id || "";
    } else if (type === "existing_inquiry" && parsed) {
      payload.name = parsed.patient_name || "";
      payload.phone = parsed.phone || "";
      payload.requirement = parsed.requirement || "";
      payload.raw_body = rawBody;
    } else {
      // parse_error
      payload.raw_body = rawBody;
    }

    const res = await fetch(GAS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json" },
      redirect: "follow",
      body: JSON.stringify(payload),
    });
    console.log("GAS notify:", { status: res.status });
  } catch (e) {
    console.error("GAS notification failed:", e);
  }
}

// ── Helper: normalize phone number ──
function normalizePhone(raw: string): string {
  let phone = raw.replace(/[\s\-\u2010-\u2015\u2212\uFF0D]/g, "").replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );

  if (/^0[789]0\d{8}$/.test(phone)) {
    phone = phone.slice(0, 3) + "-" + phone.slice(3, 7) + "-" + phone.slice(7);
  } else if (/^0120\d{6}$/.test(phone)) {
    phone = phone.slice(0, 4) + "-" + phone.slice(4, 7) + "-" + phone.slice(7);
  } else if (/^0\d{9}$/.test(phone)) {
    const prefix2 = phone.slice(0, 2);
    if (prefix2 === "03" || prefix2 === "06") {
      phone = phone.slice(0, 2) + "-" + phone.slice(2, 6) + "-" + phone.slice(6);
    } else {
      phone = phone.slice(0, 3) + "-" + phone.slice(3, 6) + "-" + phone.slice(6);
    }
  }
  return phone;
}

// ── Helper: resolve name kana via Gemini ──
async function resolveNameKana(apiKey: string, name: string): Promise<{ nameKana: string; nameKanji: string; kanaPredicted: boolean }> {
  if (!name) return { nameKana: "", nameKanji: "", kanaPredicted: false };

  const KANA_RE = /^[ぁ-ゖァ-ヺー 　]+$/u;
  const HAS_KANJI = /\p{Script=Han}/u;

  function toKatakana(s: string): string {
    return s.replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  }

  function sanitizeKana(v: string): string {
    const s = v.normalize("NFKC").replace(/[ \t\r\n　]+/g, " ").trim();
    if (!s || !KANA_RE.test(s) || HAS_KANJI.test(s)) return "";
    return toKatakana(s);
  }

  // If name is already all kana, just convert to katakana
  const directKana = sanitizeKana(name);
  if (directKana) {
    return { nameKana: directKana, nameKanji: "", kanaPredicted: false };
  }

  // If name has kanji, use Gemini to predict furigana + split
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `以下の人名について、2行で回答してください。他の文字や説明は一切不要です。\n1行目: 読みをカタカナのみで出力（姓と名の間に半角スペース1つ）\n2行目: 漢字表記を姓と名の間に半角スペース1つ入れて出力\n${name}`,
            }],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
    );

    if (!res.ok) {
      console.error("Gemini name API error:", res.status);
      return { nameKana: "", nameKanji: "", kanaPredicted: false };
    }

    const json = await res.json();
    const predicted = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    const lines = (predicted || "").split("\n").map((l: string) => l.trim()).filter(Boolean);

    let nameKana = "";
    let nameKanji = "";
    let kanaPredicted = false;

    // Line 1: furigana
    const cleanKana = sanitizeKana(lines[0] || "");
    if (cleanKana) {
      nameKana = cleanKana;
      kanaPredicted = true;
    }

    // Line 2: kanji with space
    if (lines[1]) {
      const kanjiLine = lines[1].trim();
      const origChars = name.replace(/\s/g, "");
      const geminiChars = kanjiLine.replace(/\s/g, "");
      if (geminiChars === origChars && kanjiLine.includes(" ")) {
        nameKanji = kanjiLine;
      }
    }

    return { nameKana, nameKanji, kanaPredicted };
  } catch (e) {
    console.error("Gemini name resolution failed:", e);
    return { nameKana: "", nameKanji: "", kanaPredicted: false };
  }
}

// ── Helper: parse "3/26 11:11" → { date, time } ──
function parseReceivedAt(raw: string): { date: string; time: string } {
  const now = new Date();
  const fallbackDate = now.toISOString().slice(0, 10);
  const fallbackTime = now.toTimeString().slice(0, 5);

  if (!raw) return { date: fallbackDate, time: fallbackTime };

  // Match patterns like "3/26 11:11" or "2026/3/26 11:11"
  const m = raw.match(/(?:(\d{4})\/)??(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return { date: fallbackDate, time: fallbackTime };

  let year = m[1] ? parseInt(m[1]) : now.getFullYear();
  const month = parseInt(m[2]);
  const day = parseInt(m[3]);
  const hour = parseInt(m[4]);
  const min = parseInt(m[5]);

  // Year-end edge case: if month is 12 but we're in January, use previous year
  if (!m[1] && month === 12 && now.getMonth() === 0) {
    year = now.getFullYear() - 1;
  }

  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const time = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;

  return { date, time };
}

// ── Helper: parse accident date "3/22" → "YYYY-MM-DD" ──
function parseAccidentDate(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "") return null;

  const now = new Date();
  const m = raw.match(/(?:(\d{4})\/)??(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;

  let year = m[1] ? parseInt(m[1]) : now.getFullYear();
  const month = parseInt(m[2]);
  const day = parseInt(m[3]);

  if (!m[1] && month === 12 && now.getMonth() === 0) {
    year = now.getFullYear() - 1;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
