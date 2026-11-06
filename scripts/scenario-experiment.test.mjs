import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../widget.js", import.meta.url), "utf8");
const load = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));

test("the served experiment files exist and carry matching meta", async () => {
  const id = source.match(/const EXPERIMENT = \{\s*id: '([^']+)'/u)?.[1];
  assert.equal(id, "privacy_note");
  const files = [...source.matchAll(/\{ key: '([ab])', weight: [\d.]+, file: '([^']+)' \}/gu)];
  assert.equal(files.length, 2);
  for (const [, key, file] of files) {
    const scenario = await load(file);
    assert.equal(scenario._meta.experiment_id, id);
    assert.equal(scenario._meta.variant, key);
    assert.equal(scenario._meta.scenario_version, "2026-11-06c");
  }
});

test("variant b differs from a only by the privacy note on the first screens and the contact step", async () => {
  const a = await load("scenario.json");
  const b = await load("scenario_privacy_note.json");
  const notes = [];
  const pick = (s, path) => path.reduce((o, k) => o[k], s);
  for (const path of [["root"], ["clinic_entry", "root"], ["step3_contact"]]) {
    const { privacy_note: note, ...rest } = pick(b, path);
    assert.deepEqual(rest, pick(a, path));
    assert.equal(pick(a, path).privacy_note, undefined);
    assert.equal(note.link_url, "https://jiko-navi.jp/policy/");
    assert.equal(note.link_label, "個人情報の取り扱い");
    notes.push(note.text);
  }
  assert.equal(new Set(notes).size, 1);
  assert.match(notes[0], /のためにのみ使用いたします。$/u);
  const strip = (s) => ({ ...s, _meta: { ...s._meta, variant: "" }, root: null, step3_contact: null,
    clinic_entry: { ...s.clinic_entry, root: null } });
  assert.deepEqual(strip(b), strip(a));
});

test("clinic pages get a greeting and choices with the clinic name that fit the stored inquiry type", async () => {
  for (const file of ["scenario.json", "scenario_privacy_note.json"]) {
    const { clinic_entry: entry } = await load(file);
    assert.match(entry.greeting, /^\{clinic\}への通院をお考えの方へ/u);
    assert.match(entry.greeting, /院への確認や予約を無料でお手伝いします。$/u);
    const labels = entry.root.options.map(o => o.label);
    assert.deepEqual(labels, ["この院に通いたい", "近くのほかの院も知りたい", "その他のご相談（慰謝料・診断書について）", "すぐに電話で相談したい"]);
    assert.equal(entry.root.options[0].form_value, "この院を希望：{clinic}");
    assert.equal(entry.root.options.at(-1).next, "phone");
  }
  assert.match(source, /if \(!document\.querySelector\('\.clinic-hero-contact'\)\) return null;/u);
  assert.match(source, /form_value: fillClinic\(opt\.form_value, clinic\.name, INQUIRY_TYPE_MAX\)/u);
  assert.match(source, /const INQUIRY_TYPE_MAX = 50;/u);
});

test("accident date offers one-tap choices and defaults to the local today; contact time starts at いつでもOK", async () => {
  for (const file of ["scenario.json", "scenario_privacy_note.json"]) {
    const s = await load(file);
    const date = s.step1_accident.fields.find(f => f.field === "accident_date");
    assert.deepEqual(date.quick.map(q => q.days), [0, 1, 2, undefined]);
    assert.deepEqual(date.quick.map(q => q.label), ["今日", "昨日", "一昨日（おととい）", "それより前"]);
    const time = s.step3_contact.fields.find(f => f.field === "contact_time");
    assert.equal(time.default, "いつでもOK");
    assert.ok(time.options.some(o => o.value === time.default));
  }
  assert.doesNotMatch(source, /new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/u);
  assert.match(source, /const today = localDateString\(new Date\(\)\);/u);
  // Choosing "それより前" clears the date so the required check waits for a calendar pick.
  assert.match(source, /\} else \{\s*\/\/ Earlier date[^\n]*\n\s*input\.value = '';\s*formState\[field\.field\] = '';/u);
});

test("chat header shows the Jikonavi logo mark instead of an emoji", () => {
  assert.match(source, /const LOGO_MARK_SRC = 'data:image\/webp;base64,[A-Za-z0-9+/=]+';/u);
  assert.match(source, /<div class="jn-header-avatar"><img src="\$\{LOGO_MARK_SRC\}" alt="" width="28" height="28"><\/div>/u);
  assert.doesNotMatch(source, /🏥/u);
});

test("bot messages use the receptionist photo from the site hero as the avatar", () => {
  assert.match(source, /const OPERATOR_PHOTO_SRC = 'data:image\/png;base64,[A-Za-z0-9+/=]+';/u);
  assert.match(source, /const ICON_OPERATOR = `<img src="\$\{OPERATOR_PHOTO_SRC\}" alt="" width="32" height="32">`;/u);
  assert.match(source, /\.jn-msg-avatar img \{ width: 100%; height: 100%; object-fit: cover; display: block; \}/u);
});

test("the phone guidance matches the 24-hour line", async () => {
  for (const file of ["scenario.json", "scenario_privacy_note.json"]) {
    const scenario = await load(file);
    assert.match(scenario.phone.message, /受付時間：24時間365日（通話無料）/u);
    assert.doesNotMatch(scenario.phone.message, /9:00〜21:00/u);
  }
});
