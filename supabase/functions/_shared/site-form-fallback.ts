/**
 * Condolence applications that reach LINE because the site form could not be sent.
 *
 * When Turnstile fails on jiko-navi.jp, the form shows "copy your input and send
 * it by LINE". The copied text is built by formSummary() in jikonavi-site
 * (src/scripts/site-forms.ts) from the labels in src/components/SiteForm.astro.
 * The header and the labels below must stay identical to those two files.
 */

// `【${title}】フォームから送信できなかったため、LINEでお送りします。` with title "お見舞金の申請".
export const MEDICINE_FALLBACK_HEADER =
  "【お見舞金の申請】フォームから送信できなかったため、LINEでお送りします。";

// Label on the site form -> field name the site form posts.
export const MEDICINE_FALLBACK_LABELS: Record<string, string> = {
  "お名前": "name",
  "電話番号": "phone",
  "メールアドレス": "email",
  "郵便番号": "postal_code",
  "お見舞金の送付先住所": "address",
  "通院先の整骨院・接骨院名": "clinic_name",
  "通院した整形外科名": "orthopaedic_name",
  "通院開始日": "visit_start",
  "通院終了日": "visit_end",
  "整骨院への通院回数": "visit_count",
  "後遺障害の認定": "disability_certified",
  "性別": "gender",
  "事故なびを知ったきっかけ": "referral_source",
  "備考": "notes",
  "体験談インタビューに協力してもよい": "interview_consent",
  "エラーコード": "error_code",
};

const DISABILITY_VALUES = new Set(["認定されていない", "認定された", "申請中・結果待ち", "わからない"]);
const GENDER_VALUES = new Set(["男性", "女性"]);
const REFERRAL_VALUES = new Set([
  "インターネットで検索して",
  "SNSで見かけて",
  "通院先の整骨院・接骨院から聞いて",
  "知人・家族から聞いて",
  "広告を見て",
  "その他",
]);

// The whole LINE message is at most 5,000 characters; these keep one field from
// filling a CRM column with pasted text.
const MAX_SHORT = 200;
const MAX_NOTES = 1000;

export type MedicineFallback = {
  /** Same keys and value formats as the site form payload. */
  fields: Record<string, string>;
  /** Turnstile error code printed by the form, digits only. */
  errorCode: string;
  /** Labels whose value could not be used, with what was written. */
  unreadable: string[];
  /** Name and a usable phone number are both present. */
  identified: boolean;
  /** An item appears twice or out of the form's order: the answers cannot be trusted. */
  irregular: boolean;
};

function halfWidthDigits(value: string): string {
  return value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * True when a line starts with the form's header. A greeting typed above the
 * paste still makes it an application, not a consultation; the parser marks
 * that text irregular so staff read it.
 */
export function isMedicineFallback(text: string): boolean {
  return text.split(/\r\n|\r|\n/).some((line) => line.trimStart().startsWith(MEDICINE_FALLBACK_HEADER));
}

function parseDateValue(raw: string): string {
  const value = halfWidthDigits(raw).trim();
  const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(value) ||
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (!m) return "";
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 2000 || year > 2100) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return "";
  }
  return `${m[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Order in which formSummary() prints the items.
const FIELD_ORDER = Object.values(MEDICINE_FALLBACK_LABELS);
// Items where a second line is part of the answer.
const MULTILINE_KEYS = new Set(["notes", "address"]);

function splitLabel(line: string): { key: string; label: string; value: string } | null {
  const at = line.search(/[：:]/);
  if (at <= 0) return null;
  const label = line.slice(0, at).trim();
  const key = MEDICINE_FALLBACK_LABELS[label];
  if (!key) return null;
  return { key, label, value: line.slice(at + 1).trim() };
}

/**
 * Reads the pasted text into the site form's field names. Values the database
 * would refuse (dates, counts) are dropped and listed in `unreadable` so staff
 * can read what the applicant actually wrote.
 *
 * The form prints every item once, in a fixed order. The applicant can still
 * type a line that looks like an item into the notes or the address, and then
 * nothing in the text says which line is the real answer (or whether it is an
 * answer at all rather than a quote). Such a text is marked `irregular` and left
 * for staff to read instead of being guessed at.
 */
export function parseMedicineFallback(text: string): MedicineFallback {
  const raw: Record<string, string> = {};
  const labelOf: Record<string, string> = {};
  const loose: string[] = [];
  let current = "";
  let position = -1;
  const headerAt = text.indexOf(MEDICINE_FALLBACK_HEADER);
  // Anything written above the header is outside the form's layout.
  let irregular = headerAt < 0 || text.slice(0, headerAt).trim() !== "";
  const body = headerAt < 0 ? "" : text.slice(headerAt + MEDICINE_FALLBACK_HEADER.length);
  for (const line of body.split(/\r\n|\r|\n/)) {
    const found = splitLabel(line);
    if (found) {
      const order = FIELD_ORDER.indexOf(found.key);
      if (found.key in raw || order < position) {
        // Written twice, or not where the form prints it. The line stays out of
        // every item; staff read the original in the LINE talk.
        irregular = true;
        continue;
      }
      position = order;
      raw[found.key] = found.value;
      labelOf[found.key] = found.label;
      current = found.key;
    } else if (line.trim()) {
      if (MULTILINE_KEYS.has(current)) raw[current] = `${raw[current]}\n${line.trim()}`.trim();
      // A stray line under a one-line item is kept for staff rather than dropped.
      else loose.push(line.trim());
    }
  }
  if (loose.length) raw.notes = [raw.notes || "", ...loose].filter(Boolean).join("\n");

  const fields: Record<string, string> = {};
  const unreadable: string[] = [];
  const reject = (key: string) => {
    unreadable.push(`${labelOf[key]}「${raw[key].slice(0, 60)}」`);
  };
  const short = (key: string) => (raw[key] || "").replace(/\s+/g, " ").trim().slice(0, MAX_SHORT);

  fields.name = short("name").slice(0, 100);

  // Digits and the usual separators only: "090… ではありません" is not a number.
  const phoneText = halfWidthDigits(raw.phone || "").trim();
  const phoneDigits = /^[0-9\s\-‐-―−－()（）]+$/.test(phoneText) ? phoneText.replace(/[^0-9]/g, "") : "";
  if (/^0\d{9,10}$/.test(phoneDigits)) fields.phone = phoneDigits;
  else {
    fields.phone = "";
    if (raw.phone) reject("phone");
  }

  const email = short("email").toLowerCase();
  if (!email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = email;
  else {
    fields.email = "";
    reject("email");
  }

  let postal = halfWidthDigits(raw.postal_code || "").replace(/[^0-9]/g, "");
  if (/^\d{7}$/.test(postal)) postal = `${postal.slice(0, 3)}-${postal.slice(3)}`;
  if (!postal || /^\d{3}-\d{4}$/.test(postal)) fields.postal_code = postal;
  else {
    fields.postal_code = "";
    reject("postal_code");
  }

  fields.address = short("address");
  fields.clinic_name = short("clinic_name");
  fields.orthopaedic_name = short("orthopaedic_name");

  for (const key of ["visit_start", "visit_end"]) {
    const date = raw[key] ? parseDateValue(raw[key]) : "";
    fields[key] = date;
    if (raw[key] && !date) reject(key);
  }

  const count = halfWidthDigits(raw.visit_count || "").trim().replace(/回$/, "");
  if (/^\d{1,4}$/.test(count)) fields.visit_count = String(Number(count));
  else {
    fields.visit_count = "";
    if (raw.visit_count) reject("visit_count");
  }

  const choice = (key: string, allowed: Set<string>) => {
    const value = short(key);
    if (!value || allowed.has(value)) fields[key] = value;
    else {
      fields[key] = "";
      reject(key);
    }
  };
  choice("disability_certified", DISABILITY_VALUES);
  choice("gender", GENDER_VALUES);
  choice("referral_source", REFERRAL_VALUES);

  fields.notes = (raw.notes || "").trim().slice(0, MAX_NOTES);

  // The form prints the checkbox as はい / いいえ; the site posts "協力できる" only when ticked.
  if ((raw.interview_consent || "").trim() === "はい") fields.interview_consent = "協力できる";

  const errorCode = halfWidthDigits(raw.error_code || "").replace(/[^0-9]/g, "").slice(0, 10);

  return {
    fields,
    errorCode,
    unreadable,
    identified: Boolean(fields.name && fields.phone),
    irregular,
  };
}

/**
 * Staff memo appended to the applicant's notes. The pasted text carries no
 * consent tick (the form leaves that checkbox out of the copy), so say so.
 */
export function staffMemo(parsed: MedicineFallback): string {
  const parts = [
    `フォームの確認エラー${parsed.errorCode ? `（${parsed.errorCode}）` : ""}のためLINEで受付`,
    "規約同意のチェックは未取得",
  ];
  if (parsed.unreadable.length) parts.push(`読み取れなかった項目：${parsed.unreadable.join("、")}`);
  return `【事務局メモ：${parts.join("。")}】`;
}

/** Fields to store: the applicant's notes followed by the staff memo. */
export function fieldsForIntake(parsed: MedicineFallback): Record<string, string> {
  return { ...parsed.fields, notes: `${parsed.fields.notes}${staffMemo(parsed)}` };
}

const DETAIL_ORDER: [string, string][] = [
  ["postal_code", "郵便番号"],
  ["address", "送付先住所"],
  ["clinic_name", "通院先の整骨院・接骨院"],
  ["orthopaedic_name", "通院した整形外科"],
  ["visit_start", "通院開始日"],
  ["visit_end", "通院終了日"],
  ["visit_count", "整骨院への通院回数"],
  ["disability_certified", "後遺障害の認定"],
  ["gender", "性別"],
  ["referral_source", "事故なびを知ったきっかけ"],
  ["notes", "備考"],
];

/** Body of the staff e-mail, in the same order as the site form's notification. */
export function staffDetail(fields: Record<string, string>): string {
  const lines = ["※フォームで送信できず、LINEで届いた申請です。"];
  for (const [key, label] of DETAIL_ORDER) lines.push(`${label}: ${fields[key] || "（未入力）"}`);
  lines.push(`体験談インタビュー: ${fields.interview_consent === "協力できる" ? "協力できる" : "希望なし"}`);
  lines.push("規約同意: （LINEで受付のため未取得）");
  return lines.join("\n");
}

/**
 * Receipt number in the site form's shape (S + yymmdd + "-" + 8 hex). It is
 * derived from the LINE event id, so a redelivered event maps to the same row.
 */
export async function fallbackRequestId(eventId: string, now: Date = new Date()): Promise<string> {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const ymd = jst.toISOString().slice(2, 10).replace(/-/g, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`line-fallback:${eventId}`));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `S${ymd}-${hex.slice(0, 8).toUpperCase()}`;
}

// ── Intake ──

// Replies to the applicant in the LINE talk (reply message, not counted as a push).
export function receivedReply(requestId: string): string {
  return [
    `お見舞金の申請内容を受け取りました。受付番号は ${requestId} です。`,
    "",
    "この受付は支給の決定ではありません。担当者が申請内容を確認し、支給条件を満たすことを確認できた場合、申請月の翌月末ごろを目安にJCBギフトカードを発送します。",
    "",
    "内容に不明点があるときだけ、お電話・メール・LINEのいずれかでご連絡します。",
  ].join("\n");
}
export const UNIDENTIFIED_REPLY = [
  "メッセージを受け取りました。お名前と電話番号を確認できなかったため、まだ申請として受け付けが完了しておりません。",
  "",
  "お手数ですが、先ほどの文章の「お名前：」「電話番号：」の後ろにご記入のうえ、全文をもう一度お送りください。",
].join("\n");
// Also used when the text cannot be read reliably: no receipt is claimed.
export const STORE_FAILED_REPLY = "メッセージを受け取りました。担当者が内容を確認し、必要な場合はご連絡します。";

export type FallbackOutcome =
  | "registered"
  | "resumed"
  | "duplicate"
  | "unidentified"
  | "irregular"
  | "limited"
  | "store_failed";

export type FallbackDeps = {
  /** Insert into site_form_submissions. */
  insertSubmission: (row: Record<string, unknown>) => PromiseLike<{ error: { code?: string; message?: string } | null }>;
  /** route_site_form_submission, the same call the site form makes. */
  route: (requestId: string) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
  /** true when this LINE user (or everyone together) has sent too many. */
  overLimit: () => Promise<boolean>;
  /** Keeps the message in the LINE talk log. Called only once the limit has passed. */
  keepMessage: () => Promise<void>;
  /** Resolves true when the notice was accepted. */
  notifyStaff: (payload: Record<string, string>) => Promise<boolean>;
  reply: (text: string) => Promise<void>;
  /** The row an earlier delivery of the same LINE event stored, if any. */
  findStored: (requestId: string) => Promise<{ announced: boolean } | null>;
  markAnnounced: (requestId: string) => Promise<void>;
  log?: (message: string) => void;
};

/**
 * Stores a condolence application that arrived as pasted text, through the same
 * table and routing function as the site form. Never creates a patient.
 */
export async function intakeMedicineFallback(
  text: string,
  eventId: string | null,
  receivedAt: Date,
  deps: FallbackDeps,
): Promise<{ outcome: FallbackOutcome; requestId?: string }> {
  const log = deps.log ?? ((message: string) => console.error(message));

  // The same LINE event again (redelivery). It finishes what the first run
  // left undone and is not counted against the sender: only LINE can replay an
  // event, and a run that died after storing must still reach staff.
  const requestId = eventId ? await fallbackRequestId(eventId, receivedAt) : "";
  const stored = requestId ? await deps.findStored(requestId) : null;
  if (stored) {
    await routeStored(requestId, deps, log);
    if (stored.announced) return { outcome: "duplicate", requestId };
    const fields = fieldsForIntake(parseMedicineFallback(text));
    await announce(requestId, fields, deps, log);
    return { outcome: "resumed", requestId };
  }

  // Checked before anything is written: it caps everything one sender can
  // cause, including the talk log entry, the replies and the staff e-mails.
  if (await deps.overLimit()) return { outcome: "limited" };
  await deps.keepMessage();

  const parsed = parseMedicineFallback(text);
  // Without an id for the event a redelivery could not be told apart and would
  // be stored twice, so it goes to staff as well. LINE sends one on every event.
  if (parsed.irregular || !requestId) {
    await deps.notifyStaff({
      source: "site-medicine",
      request_id: "",
      name: "",
      phone: "",
      email: "",
      page_url: "",
      detail:
        "※LINEで届いたお見舞金の申請です。同じ項目が2回書かれているなど、自動では読み取れない形だったため、申請としては登録していません。LINEのトークをご確認ください。",
    });
    await deps.reply(STORE_FAILED_REPLY);
    return { outcome: "irregular" };
  }

  if (!parsed.identified) {
    await deps.notifyStaff({
      source: "site-medicine",
      request_id: "",
      name: parsed.fields.name,
      phone: parsed.fields.phone,
      email: "",
      page_url: "",
      detail:
        "※LINEで届いたお見舞金の申請です。お名前または電話番号を読み取れなかったため、申請としては登録していません。LINEのトークをご確認ください。",
    });
    await deps.reply(UNIDENTIFIED_REPLY);
    return { outcome: "unidentified" };
  }

  const fields = fieldsForIntake(parsed);
  const { error: insertError } = await deps.insertSubmission({
    request_id: requestId,
    form_type: "medicine",
    fields,
    page_url: null,
    client_ip: null,
    user_agent: "line-fallback",
  });

  // Two deliveries of one event racing each other: the other one finishes it.
  if (insertError?.code === "23505") return { outcome: "duplicate", requestId };
  if (insertError) {
    log(`Condolence fallback was not stored: ${insertError.code || "unknown"}`);
    await deps.notifyStaff({
      source: "site-medicine",
      request_id: "",
      name: fields.name,
      phone: fields.phone,
      email: fields.email,
      page_url: "",
      detail:
        "※LINEで届いたお見舞金の申請です。自動での登録に失敗したため、申請としては登録していません。LINEのトークをご確認ください。",
    });
    await deps.reply(STORE_FAILED_REPLY);
    return { outcome: "store_failed" };
  }

  await routeStored(requestId, deps, log);
  await announce(requestId, fields, deps, log);
  return { outcome: "registered", requestId };
}

// The routing function is safe to repeat: a row that is already routed is
// returned as-is, and a row left unrouted by an earlier crash is completed.
async function routeStored(requestId: string, deps: FallbackDeps, log: (message: string) => void) {
  try {
    const routed = await deps.route(requestId);
    const data = routed.data as { ok?: boolean } | null;
    if (!routed.error && data?.ok !== false) return;
  } catch {
    // Reported below.
  }
  // The row stays in site_form_submissions, where the CRM shows it for a staff retry.
  log(`Condolence fallback was stored but not routed: ${requestId}`);
}

// Same as the site form: when the staff e-mail cannot be sent the application is
// still in the CRM's condolence list (with its menu count), so nothing is lost;
// the row simply keeps notified_at empty.
async function announce(
  requestId: string,
  fields: Record<string, string>,
  deps: FallbackDeps,
  log: (message: string) => void,
) {
  const accepted = await deps.notifyStaff({
    source: "site-medicine",
    request_id: requestId,
    name: fields.name,
    phone: fields.phone,
    email: fields.email,
    page_url: "",
    detail: staffDetail(fields),
  });
  if (accepted) await deps.markAnnounced(requestId);
  else log(`Condolence fallback staff notice was not accepted: ${requestId}`);
  await deps.reply(receivedReply(requestId));
}
