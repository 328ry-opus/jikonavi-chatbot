import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  fallbackRequestId,
  type FallbackDeps,
  fieldsForIntake,
  intakeMedicineFallback,
  isMedicineFallback,
  MEDICINE_FALLBACK_HEADER,
  parseMedicineFallback,
  receivedReply,
  staffDetail,
  staffMemo,
  STORE_FAILED_REPLY,
  UNIDENTIFIED_REPLY,
} from "./site-form-fallback.ts";

// Exactly what formSummary() in jikonavi-site (src/scripts/site-forms.ts) copies
// for the condolence form, with made-up values. If the site changes its header
// or a label in SiteForm.astro, this text and the label table must follow.
const FULL = [
  "【お見舞金の申請】フォームから送信できなかったため、LINEでお送りします。",
  "お名前：山田花子",
  "電話番号：09000001111",
  "メールアドレス：Hanako.Sample@Example.com",
  "郵便番号：1000001",
  "お見舞金の送付先住所：東京都千代田区千代田1―1",
  "通院先の整骨院・接骨院名：サンプル整骨院",
  "通院した整形外科名：サンプル整形外科",
  "通院開始日：2026年5月14日",
  "通院終了日：2026年8月31日",
  "整骨院への通院回数：80",
  "後遺障害の認定：認定されていない",
  "性別：女性",
  "事故なびを知ったきっかけ：インターネットで検索して",
  "備考：通院開始日をはっきり憶えていない",
  "体験談インタビューに協力してもよい：はい",
  "エラーコード：600010",
].join("\n");

Deno.test("only the condolence fallback header is recognised", () => {
  assert(isMedicineFallback(FULL));
  assert(isMedicineFallback(`\n  ${FULL}`));
  // The consultation fallback and ordinary talk keep their current handling.
  assert(!isMedicineFallback("【ご相談】フォームから送信できなかったため、LINEでお送りします。\nお名前：山田花子"));
  assert(!isMedicineFallback("お見舞金の申請をしたいです"));
  assert(!isMedicineFallback(`こんにちは\n${FULL}`));
  assertEquals(MEDICINE_FALLBACK_HEADER, FULL.split("\n")[0]);
});

Deno.test("a complete message becomes the site form's fields", () => {
  const parsed = parseMedicineFallback(FULL);
  assertEquals(parsed.fields, {
    name: "山田花子",
    phone: "09000001111",
    email: "hanako.sample@example.com",
    postal_code: "100-0001",
    address: "東京都千代田区千代田1―1",
    clinic_name: "サンプル整骨院",
    orthopaedic_name: "サンプル整形外科",
    visit_start: "2026-05-14",
    visit_end: "2026-08-31",
    visit_count: "80",
    disability_certified: "認定されていない",
    gender: "女性",
    referral_source: "インターネットで検索して",
    notes: "通院開始日をはっきり憶えていない",
    interview_consent: "協力できる",
  });
  assertEquals(parsed.errorCode, "600010");
  assertEquals(parsed.unreadable, []);
  assert(parsed.identified);
  // The consent tick is never part of the pasted text.
  assert(!("privacy_agree" in parsed.fields));
});

Deno.test("the stored notes carry the staff memo after the applicant's words", () => {
  const parsed = parseMedicineFallback(FULL);
  assertEquals(
    fieldsForIntake(parsed).notes,
    "通院開始日をはっきり憶えていない【事務局メモ：フォームの確認エラー（600010）のためLINEで受付。規約同意のチェックは未取得】",
  );
  const noCode = parseMedicineFallback(FULL.replace("\nエラーコード：600010", ""));
  assertEquals(staffMemo(noCode), "【事務局メモ：フォームの確認エラーのためLINEで受付。規約同意のチェックは未取得】");
});

Deno.test("values the database would refuse are dropped and reported", () => {
  const text = FULL
    .replace("通院開始日：2026年5月14日", "通院開始日：5月の中ごろ")
    .replace("通院終了日：2026年8月31日", "通院終了日：2026年2月30日")
    .replace("整骨院への通院回数：80", "整骨院への通院回数：80回くらい")
    .replace("後遺障害の認定：認定されていない", "後遺障害の認定：たぶんない")
    .replace("郵便番号：1000001", "郵便番号：100")
    .replace("メールアドレス：Hanako.Sample@Example.com", "メールアドレス：なし");
  const parsed = parseMedicineFallback(text);
  assertEquals(parsed.fields.visit_start, "");
  assertEquals(parsed.fields.visit_end, "");
  assertEquals(parsed.fields.visit_count, "");
  assertEquals(parsed.fields.disability_certified, "");
  assertEquals(parsed.fields.postal_code, "");
  assertEquals(parsed.fields.email, "");
  assertEquals(parsed.unreadable, [
    "メールアドレス「なし」",
    "郵便番号「100」",
    "通院開始日「5月の中ごろ」",
    "通院終了日「2026年2月30日」",
    "整骨院への通院回数「80回くらい」",
    "後遺障害の認定「たぶんない」",
  ]);
  assert(parsed.identified);
  assert(staffMemo(parsed).includes("読み取れなかった項目：メールアドレス「なし」、郵便番号「100」"));
});

Deno.test("hand-edited formats are still read", () => {
  const text = FULL
    .replace("電話番号：09000001111", "電話番号: ０９０-００００-１１１１")
    .replace("通院開始日：2026年5月14日", "通院開始日：2026/5/14")
    .replace("整骨院への通院回数：80", "整骨院への通院回数：８０回")
    .replace("郵便番号：1000001", "郵便番号：〒100-0001")
    .replace("備考：通院開始日をはっきり憶えていない", "備考：一行目\n二行目です");
  const parsed = parseMedicineFallback(text);
  assertEquals(parsed.fields.phone, "09000001111");
  assertEquals(parsed.fields.visit_start, "2026-05-14");
  assertEquals(parsed.fields.visit_count, "80");
  assertEquals(parsed.fields.postal_code, "100-0001");
  assertEquals(parsed.fields.notes, "一行目\n二行目です");
  assertEquals(parsed.unreadable, []);
});

Deno.test("an unfilled copy is not treated as an application", () => {
  const blank = FULL.split("\n").map((line, i) => {
    if (i === 0 || line.startsWith("エラーコード")) return line;
    const label = line.slice(0, line.indexOf("："));
    return label === "体験談インタビューに協力してもよい" ? `${label}：いいえ` : `${label}：`;
  }).join("\n");
  const parsed = parseMedicineFallback(blank);
  assert(!parsed.identified);
  assertEquals(parsed.fields.name, "");
  assertEquals(parsed.fields.phone, "");
  assert(!("interview_consent" in parsed.fields));
  assertEquals(parsed.unreadable, []);
  // A name without a usable phone number cannot be matched to a patient either.
  assert(!parseMedicineFallback(FULL.replace("電話番号：09000001111", "電話番号：あとで")).identified);
});

Deno.test("a repeated label cannot overwrite the first value", () => {
  const parsed = parseMedicineFallback(`${FULL}\nお名前：別の名前\n電話番号：08099998888`);
  assertEquals(parsed.fields.name, "山田花子");
  assertEquals(parsed.fields.phone, "09000001111");
});

Deno.test("long pasted text is cut to the column sizes", () => {
  const parsed = parseMedicineFallback(
    FULL.replace("備考：通院開始日をはっきり憶えていない", `備考：${"あ".repeat(3000)}`)
      .replace("お名前：山田花子", `お名前：${"山".repeat(500)}`),
  );
  assertEquals(parsed.fields.notes.length, 1000);
  assertEquals(parsed.fields.name.length, 100);
});

Deno.test("the staff detail names the route and lists the form's items", () => {
  const detail = staffDetail(fieldsForIntake(parseMedicineFallback(FULL)));
  const lines = detail.split("\n");
  assertEquals(lines[0], "※フォームで送信できず、LINEで届いた申請です。");
  assert(lines.includes("通院先の整骨院・接骨院: サンプル整骨院"));
  assert(lines.includes("整骨院への通院回数: 80"));
  assert(lines.includes("体験談インタビュー: 協力できる"));
  assertEquals(lines.at(-1), "規約同意: （LINEで受付のため未取得）");
});

Deno.test("the receipt number is stable for one LINE event", async () => {
  // 2026-11-18 15:30 UTC is already 11/19 in Japan.
  const at = new Date("2026-11-18T15:30:00Z");
  const first = await fallbackRequestId("01HZX8K3QJ5V7W9Y2B4D6F8H0M", at);
  assert(/^S261119-[0-9A-F]{8}$/.test(first));
  assertEquals(await fallbackRequestId("01HZX8K3QJ5V7W9Y2B4D6F8H0M", at), first);
  assert(await fallbackRequestId("01HZX8K3QJ5V7W9Y2B4D6F8H0N", at) !== first);
  assert(/^S261119-[0-9A-F]{8}$/.test(await fallbackRequestId(null, at)));
});

// ── Intake ──

type Recorded = {
  inserts: Record<string, unknown>[];
  routes: string[];
  notices: Record<string, string>[];
  replies: string[];
  logs: string[];
};

function fakeDeps(options: {
  overLimit?: boolean;
  insertError?: { code?: string; message?: string } | null;
  route?: { data: unknown; error: { message?: string } | null } | Error;
} = {}): { deps: FallbackDeps; seen: Recorded } {
  const seen: Recorded = { inserts: [], routes: [], notices: [], replies: [], logs: [] };
  const deps: FallbackDeps = {
    insertSubmission: (row) => {
      seen.inserts.push(row);
      return Promise.resolve({ error: options.insertError ?? null });
    },
    route: (requestId) => {
      seen.routes.push(requestId);
      if (options.route instanceof Error) return Promise.reject(options.route);
      return Promise.resolve(options.route ?? { data: { ok: true, crm_status: "routed" }, error: null });
    },
    overLimit: () => Promise.resolve(options.overLimit === true),
    notifyStaff: (payload) => {
      seen.notices.push(payload);
      return Promise.resolve();
    },
    reply: (text) => {
      seen.replies.push(text);
      return Promise.resolve();
    },
    log: (message) => seen.logs.push(message),
  };
  return { deps, seen };
}

const EVENT = "01HZX8K3QJ5V7W9Y2B4D6F8H0M";
const AT = new Date("2026-11-18T10:19:00Z");

Deno.test("a complete application is stored, routed, announced and acknowledged", async () => {
  const { deps, seen } = fakeDeps();
  const result = await intakeMedicineFallback(FULL, EVENT, AT, deps);
  const requestId = await fallbackRequestId(EVENT, AT);
  assertEquals(result, { outcome: "registered", requestId });

  assertEquals(seen.inserts.length, 1);
  const row = seen.inserts[0];
  assertEquals(row.request_id, requestId);
  assertEquals(row.form_type, "medicine");
  assertEquals(row.user_agent, "line-fallback");
  assertEquals(row.client_ip, null);
  assertEquals(row.fields, fieldsForIntake(parseMedicineFallback(FULL)));

  assertEquals(seen.routes, [requestId]);
  assertEquals(seen.notices.length, 1);
  assertEquals(seen.notices[0].source, "site-medicine");
  assertEquals(seen.notices[0].request_id, requestId);
  assertEquals(seen.notices[0].name, "山田花子");
  assert(seen.notices[0].detail.startsWith("※フォームで送信できず、LINEで届いた申請です。"));
  assertEquals(seen.replies, [receivedReply(requestId)]);
  assert(seen.replies[0].includes(requestId));
  assertEquals(seen.logs, []);
});

Deno.test("a redelivered LINE event does not notify or reply twice", async () => {
  const { deps, seen } = fakeDeps({ insertError: { code: "23505" } });
  const result = await intakeMedicineFallback(FULL, EVENT, AT, deps);
  assertEquals(result.outcome, "duplicate");
  // Routing is repeated on purpose: it completes a row an earlier crash left unrouted.
  assertEquals(seen.routes.length, 1);
  assertEquals(seen.notices, []);
  assertEquals(seen.replies, []);
});

Deno.test("without a name and phone nothing is stored and the sender is asked again", async () => {
  const { deps, seen } = fakeDeps();
  const result = await intakeMedicineFallback(
    FULL.replace("電話番号：09000001111", "電話番号："),
    EVENT,
    AT,
    deps,
  );
  assertEquals(result, { outcome: "unidentified" });
  assertEquals(seen.inserts, []);
  assertEquals(seen.routes, []);
  assertEquals(seen.replies, [UNIDENTIFIED_REPLY]);
  assertEquals(seen.notices.length, 1);
  assertEquals(seen.notices[0].request_id, "");
  assert(seen.notices[0].detail.includes("申請としては登録していません"));
});

Deno.test("over the limit nothing is stored, sent or answered", async () => {
  const { deps, seen } = fakeDeps({ overLimit: true });
  assertEquals(await intakeMedicineFallback(FULL, EVENT, AT, deps), { outcome: "limited" });
  assertEquals(seen, { inserts: [], routes: [], notices: [], replies: [], logs: [] });
});

Deno.test("a storage failure reaches staff and never claims a receipt", async () => {
  const { deps, seen } = fakeDeps({ insertError: { code: "57014", message: "timeout" } });
  const result = await intakeMedicineFallback(FULL, EVENT, AT, deps);
  assertEquals(result, { outcome: "store_failed" });
  assertEquals(seen.routes, []);
  assertEquals(seen.replies, [STORE_FAILED_REPLY]);
  assertEquals(seen.notices[0].request_id, "");
  assert(seen.notices[0].detail.includes("自動での登録に失敗"));
  // The log line carries the error code only, never the applicant's details.
  assertEquals(seen.logs, ["Condolence fallback was not stored: 57014"]);
});

Deno.test("a routing failure keeps the stored row and still tells staff", async () => {
  for (const route of [
    { data: { ok: false, crm_status: "error" }, error: null },
    { data: null, error: { message: "rpc failed" } },
    new Error("network"),
  ]) {
    const { deps, seen } = fakeDeps({ route });
    const result = await intakeMedicineFallback(FULL, EVENT, AT, deps);
    assertEquals(result.outcome, "registered");
    assertEquals(seen.inserts.length, 1);
    assertEquals(seen.notices.length, 1);
    assertEquals(seen.logs, [`Condolence fallback was stored but not routed: ${result.requestId}`]);
  }
});
