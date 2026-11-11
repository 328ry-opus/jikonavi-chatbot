import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildLineFollowupNote, normalizeEventId, recordLineFollowup, type RpcResult } from "./line-followup.ts";

type Call = { name: string; args: Record<string, unknown> };
type Answer = RpcResult | Error;

// Each RPC name answers from its own queue; the last answer repeats.
function fakeRpc(answers: Record<string, Answer | Answer[]>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(answers).map(([name, a]) => [name, Array.isArray(a) ? [...a] : [a]]));
  const rpc = (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const queue = queues.get(name);
    if (!queue) return Promise.resolve({ data: null, error: { code: "PGRST202", message: `unexpected rpc ${name}` } });
    const answer = queue.length > 1 ? queue.shift()! : queue[0];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  };
  return { rpc, calls };
}

function logs() {
  const lines: string[] = [];
  return { lines, log: (message: string) => lines.push(message) };
}

const NOTE = "\n【LINE追加メッセージ 11/11 08:05】また相談したいです";
const ok = (data: unknown): RpcResult => ({ data, error: null });
const recorded = ok({ patient_status: "キャンセル", recontact: true, opened: true, duplicate: false });
const noAnswer: RpcResult = { data: null, error: { message: "TypeError: error sending request", code: "" } };

Deno.test("the note is stamped in Japan time", () => {
  // 2026-11-10 23:05 UTC is 2026-11-11 08:05 in Japan.
  assertEquals(buildLineFollowupNote("また相談したいです", new Date("2026-11-10T23:05:00Z")), NOTE);
  // Midnight and year boundaries do not shift the day the wrong way.
  assertEquals(buildLineFollowupNote("x", new Date("2026-12-31T15:00:00Z")), "\n【LINE追加メッセージ 1/1 00:00】x");
});

Deno.test("only a plausible LINE event id is passed on", () => {
  assertEquals(normalizeEventId("01HZX8K3QJ5V7W9Y2B4D6F8H0M"), "01HZX8K3QJ5V7W9Y2B4D6F8H0M");
  assertEquals(normalizeEventId("  01HZX8K3  "), "01HZX8K3");
  for (const value of [undefined, null, "", "   ", 123, {}, "e".repeat(101)]) {
    assertEquals(normalizeEventId(value), null);
  }
});

Deno.test("a closed patient's message is recorded as a recontact in one call, with the event id", async () => {
  const { rpc, calls } = fakeRpc({ record_line_followup: recorded });
  const l = logs();
  const result = await recordLineFollowup(rpc, "p123", NOTE, "evt-1", l.log);
  assertEquals(result, { saved: true, recontact: true, opened: true, duplicate: false, usedFallback: false });
  assertEquals(calls, [{
    name: "record_line_followup",
    args: { p_patient_id: "p123", p_note: NOTE, p_event_id: "evt-1" },
  }]);
  assertEquals(l.lines, []);
});

Deno.test("a later message is merged, and a patient in progress is not a recontact", async () => {
  const merged = fakeRpc({
    record_line_followup: ok({ patient_status: "キャンセル", recontact: true, opened: false, duplicate: false }),
  });
  assertEquals(
    await recordLineFollowup(merged.rpc, "p123", "note", "evt-2"),
    { saved: true, recontact: true, opened: false, duplicate: false, usedFallback: false },
  );

  const active = fakeRpc({
    record_line_followup: ok({ patient_status: "送客調整中", recontact: false, opened: false, duplicate: false }),
  });
  assertEquals(
    await recordLineFollowup(active.rpc, "p123", "note", "evt-3"),
    { saved: true, recontact: false, opened: false, duplicate: false, usedFallback: false },
  );
  assertEquals(active.calls.length, 1);
});

Deno.test("an event the database already processed is reported as a duplicate and counts as saved", async () => {
  const { rpc, calls } = fakeRpc({
    record_line_followup: ok({ patient_status: "キャンセル", recontact: true, opened: false, duplicate: true }),
  });
  assertEquals(
    await recordLineFollowup(rpc, "p123", NOTE, "evt-1"),
    { saved: true, recontact: true, opened: false, duplicate: true, usedFallback: false },
  );
  assertEquals(calls.length, 1);
});

Deno.test("a 'success' that is not the function's answer is not trusted: retry, then save the previous way", async () => {
  // The function always answers with an object carrying a boolean `duplicate`.
  for (const data of [null, "ok", [], {}, { recontact: true, opened: true, duplicate: "no" }]) {
    const { rpc, calls } = fakeRpc({
      record_line_followup: ok(data),
      append_patient_note: ok({ id: "p123" }),
    });
    const l = logs();
    assertEquals(
      await recordLineFollowup(rpc, "p123", "note", "evt-1", l.log),
      { saved: true, recontact: false, opened: false, duplicate: false, usedFallback: true },
    );
    assertEquals(calls.map((c) => c.name), ["record_line_followup", "record_line_followup", "append_patient_note"]);
    assertEquals(l.lines.length, 2);
  }
  // Flags of the wrong type never turn into a recontact.
  const odd = fakeRpc({ record_line_followup: ok({ recontact: "yes", opened: 1, duplicate: false }) });
  assertEquals(
    await recordLineFollowup(odd.rpc, "p123", "note", "evt-1"),
    { saved: true, recontact: false, opened: false, duplicate: false, usedFallback: false },
  );
});

Deno.test("PostgREST's own connection errors count as no answer", async () => {
  for (const code of ["PGRST000", "PGRST001", "PGRST002", "PGRST003"]) {
    const { rpc, calls } = fakeRpc({
      record_line_followup: [{ data: null, error: { code, message: "connection" } }, recorded],
    });
    const result = await recordLineFollowup(rpc, "p123", NOTE, "evt-1", () => {});
    assertEquals(result.usedFallback, false);
    assertEquals(calls.map((c) => c.name), ["record_line_followup", "record_line_followup"]);
  }
});

Deno.test("when the database rejects the call (function missing, permission), the note is saved the previous way without a retry", async () => {
  for (
    const rejection of [
      { data: null, error: { code: "PGRST202", message: "Could not find the function public.record_line_followup" } },
      { data: null, error: { code: "42501", message: "permission denied for function record_line_followup" } },
      { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } },
    ]
  ) {
    const { rpc, calls } = fakeRpc({
      record_line_followup: rejection,
      append_patient_note: ok({ id: "p123" }),
    });
    const l = logs();
    const result = await recordLineFollowup(rpc, "p123", "note", "evt-1", l.log);
    assertEquals(result, { saved: true, recontact: false, opened: false, duplicate: false, usedFallback: true });
    assertEquals(calls.map((c) => c.name), ["record_line_followup", "append_patient_note"]);
    assertEquals(calls[1].args, { p_patient_id: "p123", p_note: "note" });
    assertEquals(l.lines.length, 1);
  }
});

Deno.test("when there is no answer, the same event is retried once instead of writing the note a second way", async () => {
  // The first call was written but its response was lost; the retry sees the event as a duplicate.
  for (const lost of [noAnswer, new Error("network down")]) {
    const { rpc, calls } = fakeRpc({
      record_line_followup: [lost, ok({ patient_status: "キャンセル", recontact: true, opened: false, duplicate: true })],
    });
    const l = logs();
    const result = await recordLineFollowup(rpc, "p123", NOTE, "evt-1", l.log);
    assertEquals(result, { saved: true, recontact: true, opened: false, duplicate: true, usedFallback: false });
    assertEquals(calls.map((c) => c.name), ["record_line_followup", "record_line_followup"]);
    assertEquals(calls[0].args, calls[1].args);
    assertEquals(l.lines.length, 1);
  }

  // The first call never reached the database; the retry records it normally.
  const fresh = fakeRpc({ record_line_followup: [noAnswer, recorded] });
  assertEquals(
    await recordLineFollowup(fresh.rpc, "p123", NOTE, "evt-1", () => {}),
    { saved: true, recontact: true, opened: true, duplicate: false, usedFallback: false },
  );
});

Deno.test("still no answer after the retry: the note is saved the previous way rather than lost", async () => {
  const { rpc, calls } = fakeRpc({
    record_line_followup: noAnswer,
    append_patient_note: ok({ id: "p123" }),
  });
  const l = logs();
  const result = await recordLineFollowup(rpc, "p123", "note", "evt-1", l.log);
  assertEquals(result, { saved: true, recontact: false, opened: false, duplicate: false, usedFallback: true });
  assertEquals(calls.map((c) => c.name), ["record_line_followup", "record_line_followup", "append_patient_note"]);
  assertEquals(l.lines.length, 2);
});

Deno.test("without an event id there is no retry (it would not be safe), only the fallback", async () => {
  const { rpc, calls } = fakeRpc({
    record_line_followup: noAnswer,
    append_patient_note: ok({ id: "p123" }),
  });
  const result = await recordLineFollowup(rpc, "p123", "note", null, () => {});
  assertEquals(result.usedFallback, true);
  assertEquals(calls.map((c) => c.name), ["record_line_followup", "append_patient_note"]);
  assertEquals(calls[0].args, { p_patient_id: "p123", p_note: "note", p_event_id: null });
});

Deno.test("a lock conflict is retried once, even without an event id", async () => {
  for (const code of ["40P01", "40001", "55P03"]) {
    const { rpc, calls } = fakeRpc({
      record_line_followup: [{ data: null, error: { code, message: "deadlock detected" } }, recorded],
    });
    const l = logs();
    const result = await recordLineFollowup(rpc, "p123", NOTE, null, l.log);
    assertEquals(result, { saved: true, recontact: true, opened: true, duplicate: false, usedFallback: false });
    assertEquals(calls.map((c) => c.name), ["record_line_followup", "record_line_followup"]);
    assertEquals(l.lines.length, 1);
  }
  // Still conflicting after the retry: the note is saved the previous way.
  const stuck = fakeRpc({
    record_line_followup: { data: null, error: { code: "40P01", message: "deadlock detected" } },
    append_patient_note: ok({ id: "p123" }),
  });
  const result = await recordLineFollowup(stuck.rpc, "p123", NOTE, "evt-1", () => {});
  assertEquals(result.usedFallback, true);
  assertEquals(stuck.calls.map((c) => c.name), ["record_line_followup", "record_line_followup", "append_patient_note"]);
});

Deno.test("a lost connection counts as no answer, not as a rejection", async () => {
  for (const code of ["08006", "08P01", "57P01"]) {
    const withId = fakeRpc({
      record_line_followup: [
        { data: null, error: { code, message: "connection failure" } },
        ok({ patient_status: "キャンセル", recontact: true, opened: false, duplicate: true }),
      ],
    });
    const result = await recordLineFollowup(withId.rpc, "p123", NOTE, "evt-1", () => {});
    assertEquals(result, { saved: true, recontact: true, opened: false, duplicate: true, usedFallback: false });
    assertEquals(withId.calls.map((c) => c.name), ["record_line_followup", "record_line_followup"]);
  }
});

Deno.test("known limit: a redelivered event is appended again while the fallback is in use", async () => {
  // Before the migration (or while the new function is failing) the previous RPC saves the
  // note and keeps no record of event ids, so a redelivery by LINE cannot be recognised.
  const { rpc, calls } = fakeRpc({
    record_line_followup: { data: null, error: { code: "PGRST202", message: "Could not find the function" } },
    append_patient_note: ok({ id: "p123" }),
  });
  await recordLineFollowup(rpc, "p123", "note", "evt-1", () => {});
  await recordLineFollowup(rpc, "p123", "note", "evt-1", () => {});
  assertEquals(calls.filter((c) => c.name === "append_patient_note").length, 2);
});

Deno.test("when both calls fail it reports not saved and never throws", async () => {
  for (
    const fallback of [
      { data: null, error: { code: "P0002", message: "patient not found: p123" } },
      new Error("network down"),
    ]
  ) {
    const { rpc } = fakeRpc({
      record_line_followup: { data: null, error: { code: "XX000", message: "boom" } },
      append_patient_note: fallback,
    });
    const l = logs();
    assertEquals(
      await recordLineFollowup(rpc, "p123", "note", "evt-1", l.log),
      { saved: false, recontact: false, opened: false, duplicate: false, usedFallback: true },
    );
    assertEquals(l.lines.length, 2);
  }
});

Deno.test("error logs name the patient id only, not the message text", async () => {
  const { rpc } = fakeRpc({
    record_line_followup: noAnswer,
    append_patient_note: { data: null, error: { code: "XX000", message: "boom2" } },
  });
  const l = logs();
  await recordLineFollowup(rpc, "p123", "\n【LINE追加メッセージ 11/11 08:05】電話番号は090-0000-0000です", "evt-1", l.log);
  assertEquals(l.lines.length, 3);
  for (const line of l.lines) {
    assertEquals(line.includes("090-0000-0000"), false);
    assertEquals(line.includes("p123"), true);
  }
});
