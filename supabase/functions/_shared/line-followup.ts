/**
 * Follow-up LINE messages from a user who is already registered as a patient.
 *
 * The message is appended to the patient's notes, as before. In addition, when the
 * patient is already closed in the CRM (キャンセル / 完了 / ゴミ箱), the database records
 * an open "LINE recontact" so staff see it on the dashboard instead of it sitting
 * unnoticed in the notes. The patient's status is never changed here.
 *
 * Both happen in one database call (record_line_followup, jikonavi-crm migration
 * 20261111093000). The LINE webhook event id goes along, and the database writes each
 * event only once, so a retry can never double the note.
 *
 * Failure handling, in order:
 *  1. The database answered with an error (function missing before the migration,
 *     permission, constraint …): nothing was written, so the note is saved through the
 *     previous RPC (append_patient_note). The message is never lost; only the dashboard
 *     record is missing, and reconcile_line_recontacts can pick it up later from the log.
 *  2. No answer at all (network error, timeout, connection lost): the outcome is unknown.
 *     With an event id the same call is retried once — safe, because the event is written
 *     only once. A lock conflict (deadlock, lock timeout) was rolled back and is retried
 *     once as well, with or without an event id.
 *  3. Still no answer, or no event id to make a retry safe: fall back as in 1.
 *
 * Where the note can still end up twice (accepted, because losing it is worse):
 *  - the fallback is used after a call whose answer was lost but which had in fact been
 *    written (path 3, or a retry that was then rejected);
 *  - any note saved through the fallback, if LINE later redelivers the same event: the
 *    previous RPC keeps no record of event ids, so it cannot recognise the redelivery
 *    (this is how the webhook has always behaved).
 * The fallback also writes to whichever patient the LINE user is linked to at that moment;
 * record_line_followup keeps a redelivered event with the patient it was first received for.
 */

export type RpcError = { message?: string; code?: string };
export type RpcResult = { data: unknown; error: RpcError | null };
export type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;

export type LineFollowupResult = {
  /** The note is saved (by either RPC, now or by an earlier delivery of the same event). */
  saved: boolean;
  /** The patient is closed and the message counts as a recontact. */
  recontact: boolean;
  /** This message opened a new recontact (false when merged into an open one). */
  opened: boolean;
  /** The database had already processed this event id; nothing was written again. */
  duplicate: boolean;
  /** The previous RPC was used because record_line_followup failed. */
  usedFallback: boolean;
};

/** Note line appended to the patient, stamped in Japan time (M/D HH:mm). */
export function buildLineFollowupNote(text: string, now: Date = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const timeStr = `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${jst.toISOString().slice(11, 16)}`;
  return `\n【LINE追加メッセージ ${timeStr}】${text}`;
}

/** LINE's webhookEventId, when it looks like one (the database rejects longer ids). */
export function normalizeEventId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 100 ? trimmed : null;
}

type Attempt =
  | { kind: "ok"; data: unknown }
  | { kind: "rejected"; reason: string } // the database answered: nothing was written
  | { kind: "transient"; reason: string } // rolled back by a lock conflict: safe to repeat
  | { kind: "unknown"; reason: string }; // no answer: it may or may not have been written

// Deadlock, serialization failure, lock timeout: the transaction was rolled back and the
// same call is expected to succeed when repeated.
const TRANSIENT_CODES = new Set(["40P01", "40001", "55P03"]);

function classify(error: RpcError): "rejected" | "transient" | "unknown" {
  const code = typeof error.code === "string" ? error.code : "";
  if (TRANSIENT_CODES.has(code)) return "transient";
  // Connection lost / server shutting down (Postgres class 08 and 57P, PostgREST's own
  // connection errors PGRST000–003): whether the call was committed is not known, so it is
  // treated like "no answer".
  if (/^(08|57P|PGRST00[0-3]$)/.test(code)) return "unknown";
  // Any other PostgREST ("PGRST…") or Postgres (5-character SQLSTATE) error means the
  // request was answered and nothing was written. Everything else is a transport failure.
  return /^(PGRST\d+|[0-9A-Z]{5})$/.test(code) ? "rejected" : "unknown";
}

async function attempt(rpc: Rpc, name: string, args: Record<string, unknown>): Promise<Attempt> {
  try {
    const { data, error } = await rpc(name, args);
    if (!error) return { kind: "ok", data };
    return { kind: classify(error), reason: error.message || error.code || "unknown error" };
  } catch (e) {
    return { kind: "unknown", reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function recordLineFollowup(
  rpc: Rpc,
  patientId: string,
  note: string,
  eventId: string | null = null,
  logError: (message: string) => void = (message) => console.error(message),
): Promise<LineFollowupResult> {
  const recordArgs = { p_patient_id: patientId, p_note: note, p_event_id: eventId };
  // record_line_followup always answers with an object that carries `duplicate`. A "success"
  // without it did not come from the function, so nothing is known to be saved.
  const attemptRecord = async (): Promise<Attempt> => {
    const answer = await attempt(rpc, "record_line_followup", recordArgs);
    if (answer.kind !== "ok") return answer;
    const data = answer.data as Record<string, unknown> | null;
    return data && typeof data === "object" && typeof data.duplicate === "boolean"
      ? answer
      : { kind: "unknown", reason: "unexpected answer" };
  };

  let result = await attemptRecord();
  // One retry: always after a lock conflict (nothing was written), and after "no answer"
  // only when the event id makes repeating safe.
  if (result.kind === "transient" || (result.kind === "unknown" && eventId)) {
    logError(`record_line_followup did not complete for patient ${patientId}, retrying: ${result.reason}`);
    result = await attemptRecord();
  }

  if (result.kind === "ok") {
    const row = result.data as Record<string, unknown>;
    return {
      saved: true,
      recontact: row.recontact === true,
      opened: row.opened === true,
      duplicate: row.duplicate === true,
      usedFallback: false,
    };
  }
  logError(`record_line_followup failed for patient ${patientId}: ${result.reason}`);

  // Fallback: save the note the way it was saved before, so the message is not lost.
  const fallback = await attempt(rpc, "append_patient_note", { p_patient_id: patientId, p_note: note });
  if (fallback.kind === "ok") {
    return { saved: true, recontact: false, opened: false, duplicate: false, usedFallback: true };
  }
  logError(`append_patient_note failed for patient ${patientId}: ${fallback.reason}`);
  return { saved: false, recontact: false, opened: false, duplicate: false, usedFallback: true };
}
