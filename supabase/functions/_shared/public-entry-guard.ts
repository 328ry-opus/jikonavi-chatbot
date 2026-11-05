// Guards for the public entry points of the chat widget and the LINE form.
// These endpoints accept anonymous traffic and either call a paid AI API or create
// a patient record, so every limit is counted in the database, not in worker memory.

export const MAX_ENTRY_BODY_BYTES = 32 * 1024;

const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_MESSAGE_CHARS = 2000;
const MAX_HISTORY_TOTAL_CHARS = 8000;
const MAX_FORM_FIELDS = 30;
const MAX_FORM_FIELD_CHARS = 500;
const FORM_FIELD_CHARS: Record<string, number> = {
  name: 100,
  name_kana: 100,
  phone: 30,
  pref: 10,
  area: 100,
  contact_time: 30,
  inquiry_type: 50,
  accident_type: 50,
  accident_situation: 50,
  accident_date: 20,
  injury_status: 50,
  symptoms: 200,
};

export interface EntryLimit {
  label: string;
  limit: number;
  windowSeconds: number;
  /** false = one shared bucket for all senders, which caps the total damage. */
  perClient: boolean;
}

export const CHAT_AI_LIMITS: EntryLimit[] = [
  { label: "client", limit: 20, windowSeconds: 3600, perClient: true },
  { label: "all", limit: 300, windowSeconds: 86400, perClient: false },
];

export const FORM_SUBMIT_LIMITS: EntryLimit[] = [
  { label: "client", limit: 5, windowSeconds: 3600, perClient: true },
  { label: "all", limit: 100, windowSeconds: 86400, perClient: false },
];

// One message from a LINE user triggers one AI extraction while their details are incomplete.
export const LINE_TALK_AI_LIMITS: EntryLimit[] = [
  { label: "client", limit: 30, windowSeconds: 3600, perClient: true },
  { label: "all", limit: 500, windowSeconds: 86400, perClient: false },
];

export type ConsumeLimit = (
  args: { p_scope: string; p_key: string; p_limit: number; p_window_seconds: number },
) => PromiseLike<{ data: unknown; error: unknown }>;

export function clientAddress(req: Request): string {
  const direct = req.headers.get("cf-connecting-ip")?.trim();
  if (direct) return direct;
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

async function hashedClient(req: Request, pepper: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${pepper}:${clientAddress(req)}`),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Returns true when the request is over a limit. The per-client limit is checked first
 * and stops there, so one noisy sender cannot use up the shared allowance.
 * When the counter cannot be read, `whenUnavailable` decides: the AI call fails closed
 * because it costs money, and the forms fail open because a lost lead costs more.
 */
export async function isOverEntryLimit(input: {
  consume: ConsumeLimit;
  req: Request;
  scope: string;
  limits: EntryLimit[];
  pepper: string;
  whenUnavailable: "allow" | "block";
}): Promise<boolean> {
  const client = await hashedClient(input.req, input.pepper);
  for (const limit of input.limits) {
    const { data, error } = await input.consume({
      p_scope: `${input.scope}:${limit.label}`,
      p_key: limit.perClient ? client : "all",
      p_limit: limit.limit,
      p_window_seconds: limit.windowSeconds,
    });
    if (error || typeof data !== "boolean") {
      console.error("Entry limit unavailable:", input.scope, limit.label);
      return input.whenUnavailable === "block";
    }
    if (!data) {
      console.warn("Entry limit reached:", input.scope, limit.label);
      return true;
    }
  }
  return false;
}

/** Same check for callers identified by a verified id instead of a network address. */
export async function isOverIdentifiedLimit(input: {
  consume: ConsumeLimit;
  subject: string;
  scope: string;
  limits: EntryLimit[];
  pepper: string;
}): Promise<boolean> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${input.pepper}:${input.subject}`),
  );
  const client = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  for (const limit of input.limits) {
    const { data, error } = await input.consume({
      p_scope: `${input.scope}:${limit.label}`,
      p_key: limit.perClient ? client : "all",
      p_limit: limit.limit,
      p_window_seconds: limit.windowSeconds,
    });
    if (error || typeof data !== "boolean") {
      console.error("Entry limit unavailable:", input.scope, limit.label);
      return true;
    }
    if (!data) {
      console.warn("Entry limit reached:", input.scope, limit.label);
      return true;
    }
  }
  return false;
}

export class EntryBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super(status === 413 ? "Payload too large" : "Invalid JSON");
  }
}

export async function readEntryJson(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_ENTRY_BODY_BYTES) {
    throw new EntryBodyError(413);
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_ENTRY_BODY_BYTES) {
    throw new EntryBodyError(413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EntryBodyError(400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EntryBodyError(400);
  }
  return parsed as Record<string, unknown>;
}

export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

export function sanitizeConversationHistory(
  value: unknown,
): Array<{ role: string; content: string }> {
  if (!Array.isArray(value)) return [];
  const messages: Array<{ role: string; content: string }> = [];
  let total = 0;
  // Walk from the newest message so the budget keeps the recent context.
  for (const item of value.slice(-MAX_HISTORY_MESSAGES).reverse()) {
    const role = (item as { role?: unknown })?.role;
    const content = (item as { content?: unknown })?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const clipped = content.slice(0, MAX_HISTORY_MESSAGE_CHARS);
    if (total + clipped.length > MAX_HISTORY_TOTAL_CHARS) break;
    total += clipped.length;
    messages.unshift({ role, content: clipped });
  }
  return messages;
}

/** Clips free-form widget fields. Control characters are removed so a name cannot add lines to an AI prompt. */
export function sanitizeFormData(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_FORM_FIELDS) return null;
  const clean: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (key.length > 50) return null;
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const limit = FORM_FIELD_CHARS[key] ?? MAX_FORM_FIELD_CHARS;
    clean[key] = String(raw)
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ")
      .slice(0, limit);
    if (key === "name") clean[key] = clean[key].replace(/\n/g, " ");
  }
  return clean;
}
