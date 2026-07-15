/**
 * Jikonavi Chat Form Edge Function
 * Receives form submissions from the chat widget and stores them in Supabase.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── CORS ──────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://jiko-navi.jp",
  "https://www.jiko-navi.jp",
  "http://jiko-navi.sakura.ne.jp",
  "https://328ry-opus.github.io",
  "http://localhost",
  "http://127.0.0.1",
];

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return true;
    }
    const normalized = parsed.origin;
    return ALLOWED_ORIGINS.some((o) => {
      try {
        return normalized === new URL(o).origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin)
      ? origin
      : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

const UNSUPPORTED_BROWSER_MESSAGE =
  "このブラウザからはチャット送信を受け付けていません。お手数ですが、お電話（0120-911-427）でご相談ください。";

// Silent phone blocklist: known non-inquiry senders. Submissions are kept in
// chat_messages for audit, but no patient record / no notification is created,
// and the sender still sees the normal success screen.
// Numbers live in the CHAT_FORM_BLOCKED_PHONES secret (comma-separated,
// digits only) — never hardcode them here (this repo is public).
const BLOCKED_PHONE_DIGITS = new Set(
  (Deno.env.get("CHAT_FORM_BLOCKED_PHONES") || "")
    .split(",")
    .map((v) => v.replace(/\D/g, ""))
    .filter(Boolean),
);

function normalizePhoneDigits(value: unknown): string {
  return String(value ?? "")
    .replace(
      /[０-９]/g,
      (c: string) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0),
    )
    .replace(/\D/g, "");
}
const DB_RETRY_DELAY_MS = 700;
type DbRetryResult = {
  error?: unknown | null;
  data?: unknown;
};
type DuplicateInsertRecovery<T extends DbRetryResult> = {
  knownId: string;
  verifyExisting: () => PromiseLike<T>;
};

function isNintendoSwitchBrowser(
  ...userAgents: Array<string | null | undefined>
): boolean {
  return userAgents.some((ua) => {
    const value = ua || "";
    return /Nintendo Switch|NintendoBrowser/i.test(value) ||
      (/WifiWebAuthApplet/i.test(value) && /Nintendo/i.test(value));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeError(error: unknown) {
  if (!error) return null;
  if (error instanceof Error) return { message: error.message };
  if (typeof error === "object") {
    const value = error as { message?: unknown; code?: unknown };
    return {
      message: typeof value.message === "string"
        ? value.message
        : String(error),
      code: typeof value.code === "string" ? value.code : undefined,
    };
  }
  return { message: String(error) };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  const message = typeof value.message === "string" ? value.message : "";
  return value.code === "23505" ||
    message.includes("duplicate") ||
    message.includes("unique");
}

async function verifyDuplicateRecovery<T extends DbRetryResult>(
  label: string,
  context: Record<string, string | null>,
  duplicateInsertRecovery: DuplicateInsertRecovery<T>,
): Promise<T> {
  try {
    const first = await duplicateInsertRecovery.verifyExisting();
    if (!first.error) return first;
    console.warn(`${label} duplicate recovery verification failed; retrying once`, {
      ...context,
      known_id: duplicateInsertRecovery.knownId,
      error: safeError(first.error),
    });
  } catch (error) {
    console.warn(`${label} duplicate recovery verification threw; retrying once`, {
      ...context,
      known_id: duplicateInsertRecovery.knownId,
      error: safeError(error),
    });
  }

  await sleep(DB_RETRY_DELAY_MS);
  return duplicateInsertRecovery.verifyExisting();
}

async function withSingleDbRetry<T extends DbRetryResult>(
  label: string,
  context: Record<string, string | null>,
  operation: () => PromiseLike<T>,
  duplicateInsertRecovery?: DuplicateInsertRecovery<T>,
): Promise<T> {
  let firstWasUniqueViolation = false;
  try {
    const first = await operation();
    if (!first.error) return first;
    firstWasUniqueViolation = isUniqueViolation(first.error);
    if (firstWasUniqueViolation && duplicateInsertRecovery) {
      return first;
    }
    console.warn(`${label} failed; retrying once`, {
      ...context,
      error: safeError(first.error),
    });
  } catch (error) {
    console.warn(`${label} threw; retrying once`, {
      ...context,
      error: safeError(error),
    });
  }

  await sleep(DB_RETRY_DELAY_MS);

  try {
    const second = await operation();
    if (second.error) {
      if (
        duplicateInsertRecovery &&
        !firstWasUniqueViolation &&
        isUniqueViolation(second.error)
      ) {
        const verified = await verifyDuplicateRecovery(
          label,
          context,
          duplicateInsertRecovery,
        );
        if (!verified.error && verified.data) {
          console.warn(`${label} retry duplicate matched known id`, {
            ...context,
            known_id: duplicateInsertRecovery.knownId,
          });
          return { ...second, data: verified.data, error: null } as T;
        }
        console.warn(`${label} duplicate recovery verification failed`, {
          ...context,
          known_id: duplicateInsertRecovery.knownId,
          error: safeError(verified.error),
        });
      }
      console.warn(`${label} retry failed`, {
        ...context,
        error: safeError(second.error),
      });
    }
    return second;
  } catch (error) {
    console.warn(`${label} retry threw`, {
      ...context,
      error: safeError(error),
    });
    throw error;
  }
}

// ── Main handler ──────────────────────────────────────────
serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const headers = corsHeaders(origin);
  const requestUserAgent = req.headers.get("user-agent") || "";

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers });
  }

  try {
    const body = await req.json();
    const {
      session_id,
      form_data,
      variant,
      experiment_id,
      scenario_version,
      page_url,
      user_agent,
      device_type,
    } = body;

    if (!session_id || !form_data) {
      return new Response(
        JSON.stringify({ error: "session_id and form_data are required" }),
        {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        },
      );
    }

    if (isNintendoSwitchBrowser(requestUserAgent, user_agent)) {
      console.warn("Blocked chat-form submission from unsupported browser:", {
        session_id,
        user_agent: requestUserAgent.slice(0, 160),
        reported_user_agent: String(user_agent || "").slice(0, 160),
      });
      return new Response(
        JSON.stringify({
          success: false,
          code: "unsupported_browser",
          message: UNSUPPORTED_BROWSER_MESSAGE,
        }),
        {
          status: 403,
          headers: { ...headers, "Content-Type": "application/json" },
        },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase credentials not set");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Update session with form data
    const { error: sessionError } = await supabase.from("chat_sessions").upsert(
      {
        session_id,
        user_name: form_data.name || "",
        started_at: new Date().toISOString(),
        message_count: 0,
        used_ai: false,
        user_agent: user_agent || null,
        device_type: device_type || null,
      },
      { onConflict: "session_id", ignoreDuplicates: false },
    );
    if (sessionError) {
      console.error("Session upsert error:", sessionError.message);
    }

    // Store form submission as a message
    const { error: msgError } = await supabase.from("chat_messages").insert({
      session_id,
      role: "system",
      content: JSON.stringify({
        type: "form_submission",
        inquiry_type: form_data.inquiry_type || "",
        accident_type: form_data.accident_type || "",
        name: form_data.name || "",
        phone: form_data.phone || "",
        area: form_data.area || "",
        contact_time: form_data.contact_time || "",
        page_url: page_url || "",
        submitted_at: new Date().toISOString(),
      }),
      message_type: "form_submission",
    });
    if (msgError) console.error("Message insert error:", msgError.message);

    // ── Silent phone blocklist ───────────────────────────
    // Return the same success response the widget expects (it only checks
    // response.ok), so the sender sees the normal completion screen.
    if (BLOCKED_PHONE_DIGITS.has(normalizePhoneDigits(form_data.phone))) {
      console.warn("Blocked chat-form submission (phone blocklist):", {
        session_id,
        phone: normalizePhoneDigits(form_data.phone),
        page_url: page_url || "",
      });
      return new Response(
        JSON.stringify({ success: true, patient_id: null, blocked: true }),
        {
          status: 200,
          headers: { ...headers, "Content-Type": "application/json" },
        },
      );
    }

    // ── Normalize area input ─────────────────────────────
    let area = (form_data.area || "").trim();
    // Add "駅" suffix if it looks like a station name without it
    if (
      area && !area.endsWith("駅") && !area.endsWith("市") &&
      !area.endsWith("区") && !area.endsWith("町") && !area.endsWith("村") &&
      !area.endsWith("県") && !area.endsWith("府") && !area.endsWith("都") &&
      !area.endsWith("道") && area.length <= 15
    ) {
      // Check if it's likely a station name (short text without address-like suffixes)
      if (!/[0-9０-９丁目番地号]/.test(area)) {
        area = area + "駅";
      }
    }

    // ── Normalize phone number ──────────────────────────
    let phone = (form_data.phone || "").replace(
      /[\s\-‐-―−－]/g,
      "",
    ).replace(
      /[０-９]/g,
      (c: string) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0),
    );
    if (/^0[789]0\d{8}$/.test(phone)) {
      // Mobile: 090-1234-5678
      phone = phone.slice(0, 3) + "-" + phone.slice(3, 7) + "-" +
        phone.slice(7);
    } else if (/^0120\d{6}$/.test(phone)) {
      // Toll-free: 0120-123-456
      phone = phone.slice(0, 4) + "-" + phone.slice(4, 7) + "-" +
        phone.slice(7);
    } else if (/^0\d{9}$/.test(phone)) {
      // Landline: detect area code length by prefix
      // 2-digit area: 03, 06
      // 3-digit area: 011, 022, 025, 027, 028, 029, 042, 043, 044, 045, 046, 047, 048, 052, 053, 054, 055, 058, 072, 073, 075, 076, 077, 078, 079, 082, 083, 084, 086, 087, 088, 089, 092, 093, 095, 096, 097, 098, 099
      const prefix2 = phone.slice(0, 2);
      if (prefix2 === "03" || prefix2 === "06") {
        phone = phone.slice(0, 2) + "-" + phone.slice(2, 6) + "-" +
          phone.slice(6);
      } else {
        // 3-digit area code (most common for landlines)
        phone = phone.slice(0, 3) + "-" + phone.slice(3, 6) + "-" +
          phone.slice(6);
      }
    }

    // ── Resolve furigana (name_kana) — always katakana ────
    const KANA_RE = /^[ぁ-ゖァ-ヺー 　]+$/u;
    const HAS_KANJI = /\p{Script=Han}/u;

    function toKatakana(s: string): string {
      return s.replace(
        /[ぁ-ゖ]/g,
        (c) => String.fromCharCode(c.charCodeAt(0) + 0x60),
      );
    }

    function sanitizeKana(v: unknown): string {
      if (typeof v !== "string") return "";
      const s = v.normalize("NFKC").replace(/[ \t\r\n　]+/g, " ").trim();
      if (!s || !KANA_RE.test(s) || HAS_KANJI.test(s)) return "";
      return toKatakana(s);
    }

    let nameKana = sanitizeKana(form_data.name_kana);
    let kanaPredicted = false;
    let nameKanjiFormatted = ""; // Gemini-formatted kanji name with space between family/given

    if (!nameKana && form_data.name) {
      const name = form_data.name.trim();

      // If name is already all kana, convert to katakana
      const directKana = sanitizeKana(name);
      if (directKana) {
        nameKana = directKana;
      } else {
        // If name already has a space, use it as-is for kanji formatting
        if (/\s/.test(name)) {
          nameKanjiFormatted = name.replace(/\s+/g, " ").trim();
        }
        // Name contains kanji/etc — predict furigana + split kanji name via Gemini
        try {
          const apiKey = Deno.env.get("GEMINI_API_KEY");
          if (apiKey) {
            const res = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{
                    parts: [{
                      text:
                        `以下の人名について、2行で回答してください。他の文字や説明は一切不要です。\n1行目: 読みをカタカナのみで出力（姓と名の間に半角スペース1つ）\n2行目: 漢字表記を姓と名の間に半角スペース1つ入れて出力\n${name}`,
                    }],
                  }],
                  generationConfig: {
                    temperature: 0,
                    maxOutputTokens: 200,
                    thinkingConfig: { thinkingBudget: 0 },
                  },
                }),
              },
            );
            if (res.ok) {
              const json = await res.json();
              const predicted = json?.candidates?.[0]?.content?.parts?.[0]?.text
                ?.trim();
              const lines = (predicted || "").split("\n").map((l: string) =>
                l.trim()
              ).filter(Boolean);

              // Line 1: furigana
              const cleanKana = sanitizeKana(lines[0]);
              if (cleanKana) {
                nameKana = cleanKana;
                kanaPredicted = true;
              } else {
                console.error("Gemini returned non-kana:", lines[0]);
              }

              // Line 2: kanji name with space (skip if user already provided space)
              if (lines[1] && !nameKanjiFormatted) {
                const kanjiLine = lines[1].trim();
                // Validate: all original characters (minus spaces) should be present
                const origChars = name.replace(/\s/g, "");
                const geminiChars = kanjiLine.replace(/\s/g, "");
                if (geminiChars === origChars && kanjiLine.includes(" ")) {
                  nameKanjiFormatted = kanjiLine;
                } else {
                  console.error("Gemini kanji mismatch:", {
                    original: name,
                    gemini: kanjiLine,
                  });
                }
              }
            } else {
              console.error("Gemini API error:", res.status, await res.text());
            }
          } else {
            console.error("GEMINI_API_KEY not set for chat-form");
          }
        } catch (e) {
          console.error("Furigana prediction failed:", e);
        }
      }
    }

    // ── Check for duplicate patients ────────────────────
    let dupNote = "";
    try {
      const { data: dups, error: dupError } = await withSingleDbRetry(
        "find_duplicate_patients",
        { session_id },
        () =>
          supabase.rpc("find_duplicate_patients", {
            p_phone: phone || null,
            p_name_kana: null,
            p_exclude_id: null,
          }),
      );
      if (dupError) {
        console.warn("Duplicate check skipped after retry failure", {
          session_id,
          error: safeError(dupError),
        });
      } else if (dups && dups.length > 0) {
        dupNote = `\n【重複の可能性】既存患者: ${
          dups.map((d: any) => `${d.name_kanji || d.id}(${d.status})`).join(
            ", ",
          )
        }`;
      }
    } catch (e) {
      console.warn("Duplicate check skipped after retry exception", {
        session_id,
        error: safeError(e),
      });
    }

    // ── Create patient record in CRM ──────────────────────
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const todayStr = jst.toISOString().slice(0, 10);
    const timeStr = jst.toISOString().slice(11, 16);
    const patientId = "p" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

    // Normalize fields across A/B scenario variants
    const accidentSituation = form_data.accident_situation ||
      form_data.accident_type || "";
    const symptoms = form_data.symptoms || "";
    const injuryStatus = form_data.injury_status || "";
    // Browsers without <input type="date"> support (e.g. Nintendo Switch)
    // fall back to free text. Reject non-dates to avoid Postgres date-cast
    // errors (insert would 500 and lose the lead); keep raw text in notes.
    const rawAccidentDate = String(form_data.accident_date || "").trim();
    const accidentDate = /^\d{4}-\d{2}-\d{2}$/.test(rawAccidentDate) &&
        !isNaN(Date.parse(rawAccidentDate))
      ? rawAccidentDate
      : null;
    const accidentDateNote = !accidentDate && rawAccidentDate
      ? `事故日(入力原文): ${rawAccidentDate}`
      : "";

    const notes = [
      "【チャットbot経由】",
      form_data.inquiry_type ? `相談内容: ${form_data.inquiry_type}` : "",
      accidentSituation ? `事故状況: ${accidentSituation}` : "",
      symptoms ? `症状: ${symptoms}` : "",
      injuryStatus ? `けがの状況: ${injuryStatus}` : "",
      accidentDateNote,
      area ? `希望エリア: ${area}` : "",
      form_data.contact_time ? `連絡希望: ${form_data.contact_time}` : "",
      kanaPredicted ? `ふりがな「${nameKana}」はAI予測です（要確認）` : "",
    ].filter(Boolean).join("\n") + dupNote;

    let patientError: unknown = null;
    try {
      const insertResult = await withSingleDbRetry(
        "patients insert",
        { session_id },
        () =>
          supabase.from("patients").insert({
            id: patientId,
            name_kanji: nameKanjiFormatted || form_data.name || "",
            name_kana: nameKana,
            phone,
            address: area,
            channel: "chat",
            status: "問合せ受付",
            staff: "ボット",
            inquiry_date: todayStr,
            inquiry_time: timeStr,
            accident_date: accidentDate,
            injury_part: symptoms,
            next_date: todayStr,
            notes,
            check_permission: false,
            check_clinic: false,
            check_contacted: false,
            check_sent: false,
          }),
        {
          knownId: patientId,
          verifyExisting: () =>
            supabase
              .from("patients")
              .select("id")
              .eq("id", patientId)
              .maybeSingle(),
        },
      );
      patientError = insertResult.error;
    } catch (error) {
      patientError = error;
    }

    if (patientError) {
      console.error("Patient insert error after retry:", {
        session_id,
        error: safeError(patientError),
      });
      return new Response(
        JSON.stringify({
          success: false,
          error: "Patient registration failed",
        }),
        {
          status: 500,
          headers: { ...headers, "Content-Type": "application/json" },
        },
      );
    }

    // Link patient to chat session (include A/B variant)
    const { error: linkError } = await supabase.from("chat_sessions").update({
      patient_id: patientId,
      converted: true,
      variant: variant || "a",
      experiment_id: experiment_id || null,
      scenario_version: scenario_version || null,
    }).eq("session_id", session_id);
    if (linkError) console.error("Session link error:", linkError.message);

    // ── Send email notification via GAS webhook ─────────
    const GAS_WEBHOOK_URL = Deno.env.get("GAS_NOTIFY_WEBHOOK_URL");
    const GAS_SECRET = Deno.env.get("GAS_WEBHOOK_SECRET");
    try {
      const gasBody = JSON.stringify({
        source: "chatbot",
        name: form_data.name || "",
        phone,
        area,
        inquiry_type: form_data.inquiry_type || "",
        accident_type: accidentSituation,
        accident_date: accidentDate || rawAccidentDate || "",
        symptoms: symptoms,
        contact_time: form_data.contact_time || "",
        page_url: page_url || "",
      });

      // HMAC signature for GAS webhook auth
      let gasUrl = GAS_WEBHOOK_URL!;
      if (GAS_SECRET) {
        const ts = Math.floor(Date.now() / 1000).toString();
        const signedPayload = ts + "." + gasBody;
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(GAS_SECRET),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const sigBuf = await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(signedPayload),
        );
        const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
        gasUrl += (gasUrl.includes("?") ? "&" : "?") +
          `sig=${encodeURIComponent(sig)}&ts=${ts}`;
      }

      const gasRes = await fetch(gasUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Accept": "application/json",
        },
        redirect: "follow",
        body: gasBody,
      });
      const gasResBody = await gasRes.text();
      console.log("GAS webhook response:", {
        status: gasRes.status,
        body: gasResBody.slice(0, 300),
      });
      if (!gasRes.ok) {
        console.error("GAS webhook non-2xx:", gasRes.status);
      }
    } catch (e) {
      console.error("GAS notification failed:", e);
    }

    return new Response(
      JSON.stringify({ success: true, patient_id: patientId }),
      {
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("Chat form error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }
});
