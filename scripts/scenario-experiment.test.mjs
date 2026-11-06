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
    assert.equal(scenario._meta.scenario_version, "2026-11-06b");
  }
});

test("variant b differs from a only by the privacy note on the first screen and the contact step", async () => {
  const a = await load("scenario.json");
  const b = await load("scenario_privacy_note.json");
  const notes = [];
  for (const node of ["root", "step3_contact"]) {
    const { privacy_note: note, ...rest } = b[node];
    assert.deepEqual(rest, a[node]);
    assert.equal(a[node].privacy_note, undefined);
    assert.equal(note.link_url, "https://jiko-navi.jp/policy/");
    assert.equal(note.link_label, "個人情報の取り扱い");
    notes.push(note.text);
  }
  assert.equal(notes[0], notes[1]);
  assert.match(notes[0], /のためにのみ使用いたします。$/u);
  const strip = (s) => ({ ...s, _meta: { ...s._meta, variant: "" }, root: null, step3_contact: null });
  assert.deepEqual(strip(b), strip(a));
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
