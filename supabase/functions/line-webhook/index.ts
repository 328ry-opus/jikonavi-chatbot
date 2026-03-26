/**
 * LINE Webhook Edge Function
 * Receives LINE message events, accumulates conversation per user,
 * and auto-registers patients in CRM when enough info is gathered.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Line-Signature",
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
    const channelSecret = Deno.env.get("LINE_CHANNEL_SECRET");
    const channelAccessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
    if (!channelSecret || !channelAccessToken) throw new Error("LINE credentials not set");

    // ── Signature verification ──
    const body = await req.text();
    const signature = req.headers.get("X-Line-Signature") || "";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(channelSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const expectedSig = btoa(String.fromCharCode(...new Uint8Array(sig)));

    if (signature !== expectedSig) {
      console.error("Signature mismatch");
      return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401, headers });
    }

    const payload = JSON.parse(body);
    const events = payload.events || [];

    if (events.length === 0) {
      // Webhook verification request from LINE
      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) throw new Error("Supabase credentials not set");
    const supabase = createClient(supabaseUrl, supabaseKey);

    const apiKey = Deno.env.get("GEMINI_API_KEY");

    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") continue;

      const userId = event.source?.userId;
      const text = event.message.text;
      const timestamp = event.timestamp;

      if (!userId || !text) continue;

      console.log(`LINE message from ${userId}: ${text.substring(0, 100)}`);

      // ── Check if this user already has a recent patient record ──
      const { data: existing } = await supabase
        .from("line_message_log")
        .select("id, patient_id, status, messages")
        .eq("line_user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing?.status === "registered") {
        // Already registered — append message to log but don't re-register
        const messages = [...(existing.messages || []), { text, timestamp, role: "user" }];
        await supabase.from("line_message_log").update({ messages, updated_at: new Date().toISOString() }).eq("id", existing.id);
        console.log(`User ${userId} already registered as ${existing.patient_id}, appending message`);
        continue;
      }

      if (existing?.status === "collecting") {
        // Accumulating messages — add this one and re-evaluate
        const messages = [...(existing.messages || []), { text, timestamp, role: "user" }];
        await supabase.from("line_message_log").update({ messages, updated_at: new Date().toISOString() }).eq("id", existing.id);

        // Try to extract patient info from accumulated messages
        if (apiKey) {
          const allText = messages.filter((m: any) => m.role === "user").map((m: any) => m.text).join("\n");
          const result = await tryExtractPatientInfo(apiKey, allText);

          if (result && result.has_enough_info) {
            const patientId = await registerPatient(supabase, apiKey, result, userId);
            if (patientId) {
              await supabase.from("line_message_log").update({
                status: "registered",
                patient_id: patientId,
                parsed_data: result,
                updated_at: new Date().toISOString(),
              }).eq("id", existing.id);
              console.log(`Registered patient ${patientId} from LINE user ${userId}`);
              await notifyStaff(result, patientId);
            }
          }
        }
        continue;
      }

      // ── New user — create log entry and evaluate first message ──
      const messages = [{ text, timestamp, role: "user" }];
      let status = "collecting";
      let patientId = null;
      let parsedData = null;

      if (apiKey) {
        const result = await tryExtractPatientInfo(apiKey, text);
        if (result && result.has_enough_info) {
          patientId = await registerPatient(supabase, apiKey, result, userId);
          if (patientId) {
            status = "registered";
            parsedData = result;
            console.log(`Registered patient ${patientId} from first LINE message`);
            await notifyStaff(result, patientId);
          }
        }
      }

      await supabase.from("line_message_log").insert({
        line_user_id: userId,
        status,
        patient_id: patientId,
        messages,
        parsed_data: parsedData,
      });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err) {
    console.error("LINE webhook error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers });
  }
});

// ── Gemini: extract patient info from message(s) ──
async function tryExtractPatientInfo(apiKey: string, text: string): Promise<any> {
  const prompt = `以下はLINE公式アカウント「事故なび」に届いた交通事故の問い合わせメッセージです。
患者情報を抽出してください。JSONのみで回答してください。

メッセージ:
${text}

以下のJSON形式で出力:
{
  "has_enough_info": true/false,
  "patient_name": "名前（わかれば）",
  "phone": "電話番号（わかれば）",
  "accident_date": "事故日（わかれば。例: 3/25）",
  "accident_detail": "事故状況（わかれば）",
  "preferred_area": "希望エリア・住所（わかれば）",
  "injury_parts": "受傷部位（わかれば）",
  "extra_notes": "その他重要な情報"
}

判定基準（has_enough_info）:
- true: 名前と電話番号の両方がある場合
- false: どちらかが欠けている場合（挨拶だけ、状況説明だけ等）`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 500,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
    );

    if (!res.ok) {
      console.error("Gemini error:", res.status);
      return null;
    }

    const json = await res.json();
    const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return JSON.parse(rawText || "{}");
  } catch (e) {
    console.error("Gemini parse failed:", e);
    return null;
  }
}

// ── Register patient in CRM ──
async function registerPatient(supabase: any, apiKey: string, info: any, lineUserId: string): Promise<string | null> {
  const patientName = (info.patient_name || "").replace(/様$/, "").trim();
  const rawPhone = info.phone || "";

  // Normalize phone
  const phone = normalizePhone(rawPhone);

  // Resolve furigana
  const { nameKana, nameKanji, kanaPredicted } = await resolveNameKana(apiKey, patientName);

  // Parse dates
  const accidentDate = parseDate(info.accident_date);
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);

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

  const notes = [
    "【LINE経由】",
    info.accident_detail ? `事故状況: ${info.accident_detail}` : "",
    info.preferred_area ? `希望エリア: ${info.preferred_area}` : "",
    info.injury_parts ? `受傷部位: ${info.injury_parts}` : "",
    info.extra_notes ? `備考: ${info.extra_notes}` : "",
    kanaPredicted ? `ふりがな「${nameKana}」はAI予測です（要確認）` : "",
    `LINE User ID: ${lineUserId}`,
  ].filter(Boolean).join("\n") + dupNote;

  const patientId = "p" + Date.now();
  const { error } = await supabase.from("patients").insert({
    id: patientId,
    name_kanji: nameKanji || patientName || "",
    name_kana: nameKana || "",
    phone,
    address: info.preferred_area || "",
    channel: "line",
    status: "問合せ受付",
    staff: "ボット",
    inquiry_date: todayStr,
    inquiry_time: timeStr,
    accident_date: accidentDate,
    next_date: todayStr,
    notes,
    check_permission: false,
    check_clinic: false,
    check_contacted: false,
    check_sent: false,
  });

  if (error) {
    console.error("Patient insert error:", error.message);
    return null;
  }
  return patientId;
}

// ── Notify staff via GAS webhook ──
async function notifyStaff(info: any, patientId: string) {
  const GAS_WEBHOOK_URL = Deno.env.get("GAS_NOTIFY_WEBHOOK_URL");
  if (!GAS_WEBHOOK_URL) return;

  try {
    await fetch(GAS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      redirect: "follow",
      body: JSON.stringify({
        source: "line",
        type: "new_patient",
        name: info.patient_name || "",
        phone: info.phone || "",
        area: info.preferred_area || "",
        accident_detail: info.accident_detail || "",
        patient_id: patientId,
      }),
    });
  } catch (e) {
    console.error("GAS notification failed:", e);
  }
}

// ── Helper: normalize phone ──
function normalizePhone(raw: string): string {
  let phone = raw.replace(/[\s\-\u2010-\u2015\u2212\uFF0D]/g, "").replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
  if (/^0[789]0\d{8}$/.test(phone)) {
    phone = phone.slice(0, 3) + "-" + phone.slice(3, 7) + "-" + phone.slice(7);
  } else if (/^0120\d{6}$/.test(phone)) {
    phone = phone.slice(0, 4) + "-" + phone.slice(4, 7) + "-" + phone.slice(7);
  } else if (/^0\d{9}$/.test(phone)) {
    const p2 = phone.slice(0, 2);
    if (p2 === "03" || p2 === "06") {
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

  const directKana = sanitizeKana(name);
  if (directKana) return { nameKana: directKana, nameKanji: "", kanaPredicted: false };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `以下の人名について、2行で回答してください。他の文字や説明は一切不要です。\n1行目: 読みをカタカナのみで出力（姓と名の間に半角スペース1つ）\n2行目: 漢字表記を姓と名の間に半角スペース1つ入れて出力\n${name}` }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
    );
    if (!res.ok) return { nameKana: "", nameKanji: "", kanaPredicted: false };

    const json = await res.json();
    const predicted = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    const lines = (predicted || "").split("\n").map((l: string) => l.trim()).filter(Boolean);

    let nameKana = "", nameKanji = "", kanaPredicted = false;
    const cleanKana = sanitizeKana(lines[0] || "");
    if (cleanKana) { nameKana = cleanKana; kanaPredicted = true; }
    if (lines[1]) {
      const kanjiLine = lines[1].trim();
      const orig = name.replace(/\s/g, "");
      const gemini = kanjiLine.replace(/\s/g, "");
      if (gemini === orig && kanjiLine.includes(" ")) nameKanji = kanjiLine;
    }
    return { nameKana, nameKanji, kanaPredicted };
  } catch (e) {
    console.error("Gemini name resolution failed:", e);
    return { nameKana: "", nameKanji: "", kanaPredicted: false };
  }
}

// ── Helper: parse date "3/25" → "YYYY-MM-DD" ──
function parseDate(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "") return null;
  const now = new Date();
  const m = raw.match(/(?:(\d{4})\/)??(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  let year = m[1] ? parseInt(m[1]) : now.getFullYear();
  const month = parseInt(m[2]);
  const day = parseInt(m[3]);
  if (!m[1] && month === 12 && now.getMonth() === 0) year = now.getFullYear() - 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
