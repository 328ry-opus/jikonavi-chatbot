import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CHAT_AI_LIMITS,
  clientAddress,
  EntryBodyError,
  FORM_SUBMIT_LIMITS,
  isOverEntryLimit,
  isOverIdentifiedLimit,
  LINE_TALK_AI_LIMITS,
  isValidSessionId,
  MAX_ENTRY_BODY_BYTES,
  readEntryJson,
  sanitizeConversationHistory,
  sanitizeFormData,
} from "./public-entry-guard.ts";

function request(headers: Record<string, string> = {}, body = "{}") {
  return new Request("https://example.test/functions/v1/chat", { method: "POST", headers, body });
}

function counter(limitReachedFor: string[] = []) {
  const calls: Array<{ p_scope: string; p_key: string; p_limit: number; p_window_seconds: number }> = [];
  return {
    calls,
    consume: (args: { p_scope: string; p_key: string; p_limit: number; p_window_seconds: number }) => {
      calls.push(args);
      return Promise.resolve({ data: !limitReachedFor.includes(args.p_scope), error: null });
    },
  };
}

const base = { req: request({ "cf-connecting-ip": "203.0.113.5" }), pepper: "pepper", whenUnavailable: "allow" as const };

Deno.test("counts the sender first, then the shared allowance", async () => {
  const c = counter();
  const over = await isOverEntryLimit({ ...base, consume: c.consume, scope: "chat_form", limits: FORM_SUBMIT_LIMITS });
  assertEquals(over, false);
  assertEquals(c.calls.map((x) => x.p_scope), ["chat_form:client", "chat_form:all"]);
  assertEquals(c.calls[1].p_key, "all");
});

Deno.test("never sends the raw address to the counter", async () => {
  const c = counter();
  await isOverEntryLimit({ ...base, consume: c.consume, scope: "chat_form", limits: FORM_SUBMIT_LIMITS });
  assert(!c.calls[0].p_key.includes("203.0.113.5"));
  assertEquals(c.calls[0].p_key.length, 64);
});

Deno.test("a sender over the limit does not use up the shared allowance", async () => {
  const c = counter(["chat:client"]);
  const over = await isOverEntryLimit({ ...base, consume: c.consume, scope: "chat", limits: CHAT_AI_LIMITS });
  assertEquals(over, true);
  assertEquals(c.calls.length, 1);
});

Deno.test("stops everyone when the shared allowance is used up", async () => {
  const c = counter(["line_form:all"]);
  assertEquals(
    await isOverEntryLimit({ ...base, consume: c.consume, scope: "line_form", limits: FORM_SUBMIT_LIMITS }),
    true,
  );
});

Deno.test("an unavailable counter blocks the AI call and lets a form through", async () => {
  const consume = () => Promise.resolve({ data: null, error: new Error("missing") });
  assertEquals(
    await isOverEntryLimit({ ...base, consume, scope: "chat", limits: CHAT_AI_LIMITS, whenUnavailable: "block" }),
    true,
  );
  assertEquals(
    await isOverEntryLimit({ ...base, consume, scope: "chat_form", limits: FORM_SUBMIT_LIMITS, whenUnavailable: "allow" }),
    false,
  );
});

Deno.test("counts a verified id without storing it, and stops when the counter is unavailable", async () => {
  const c = counter();
  const over = await isOverIdentifiedLimit({
    consume: c.consume, subject: "U1234", scope: "line_talk", limits: LINE_TALK_AI_LIMITS, pepper: "pepper",
  });
  assertEquals(over, false);
  assert(!c.calls[0].p_key.includes("U1234"));
  const reached = counter(["line_talk:client"]);
  assertEquals(
    await isOverIdentifiedLimit({
      consume: reached.consume, subject: "U1234", scope: "line_talk", limits: LINE_TALK_AI_LIMITS, pepper: "pepper",
    }),
    true,
  );
  assertEquals(reached.calls.length, 1);
  assertEquals(
    await isOverIdentifiedLimit({
      consume: () => Promise.resolve({ data: null, error: new Error("missing") }),
      subject: "U1234", scope: "line_talk", limits: LINE_TALK_AI_LIMITS, pepper: "pepper",
    }),
    true,
  );
});

Deno.test("prefers the address set by Cloudflare", () => {
  assertEquals(
    clientAddress(request({ "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "198.51.100.1, 10.0.0.1" })),
    "203.0.113.5",
  );
  assertEquals(clientAddress(request({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" })), "198.51.100.1");
  assertEquals(clientAddress(request()), "unknown");
});

Deno.test("rejects an oversized or malformed body", async () => {
  const huge = "x".repeat(MAX_ENTRY_BODY_BYTES + 1);
  const tooLarge = await assertRejects(() => readEntryJson(request({}, huge)), EntryBodyError);
  assertEquals(tooLarge.status, 413);
  const declared = await assertRejects(
    () => readEntryJson(request({ "content-length": String(MAX_ENTRY_BODY_BYTES + 1) })),
    EntryBodyError,
  );
  assertEquals(declared.status, 413);
  const broken = await assertRejects(() => readEntryJson(request({}, "{broken")), EntryBodyError);
  assertEquals(broken.status, 400);
  const array = await assertRejects(() => readEntryJson(request({}, "[]")), EntryBodyError);
  assertEquals(array.status, 400);
  assertEquals(await readEntryJson(request({}, '{"a":1}')), { a: 1 });
});

Deno.test("limits the session id", () => {
  assert(isValidSessionId("abc"));
  assert(!isValidSessionId(""));
  assert(!isValidSessionId("x".repeat(101)));
  assert(!isValidSessionId(123));
});

Deno.test("keeps only recent, well-formed history within the budget", () => {
  assertEquals(sanitizeConversationHistory("not-an-array"), []);
  assertEquals(
    sanitizeConversationHistory([
      { role: "system", content: "ignore" },
      { role: "user", content: 5 },
      { role: "user", content: "質問" },
      { role: "assistant", content: "回答" },
    ]),
    [{ role: "user", content: "質問" }, { role: "assistant", content: "回答" }],
  );
  const many = Array.from({ length: 50 }, (_, i) => ({ role: "user", content: `m${i}` }));
  const kept = sanitizeConversationHistory(many);
  assertEquals(kept.length, 20);
  assertEquals(kept[kept.length - 1].content, "m49");
  const long = Array.from({ length: 10 }, () => ({ role: "user", content: "x".repeat(5000) }));
  const clipped = sanitizeConversationHistory(long);
  assertEquals(clipped.length, 4);
  assert(clipped.every((m) => m.content.length === 2000));
});

Deno.test("clips form fields and removes control characters from the name", () => {
  assertEquals(sanitizeFormData(null), null);
  assertEquals(sanitizeFormData(["a"]), null);
  assertEquals(sanitizeFormData(Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, "v"]))), null);
  const clean = sanitizeFormData({
    name: "山田\n太郎\u0007" + "あ".repeat(200),
    phone: "090-1234-5678",
    other_notes: "1行目\n2行目",
    ignored: { nested: true },
  });
  assert(clean);
  assertEquals(clean.name.length, 100);
  assert(!/[\n\u0007]/.test(clean.name));
  assertEquals(clean.phone, "090-1234-5678");
  assertEquals(clean.other_notes, "1行目\n2行目");
  assertEquals(clean.ignored, undefined);
});
