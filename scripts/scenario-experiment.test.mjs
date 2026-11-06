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
    assert.equal(scenario._meta.scenario_version, "2026-11-06");
  }
});

test("variant b differs from a only by the privacy note on the contact step", async () => {
  const a = await load("scenario.json");
  const b = await load("scenario_privacy_note.json");
  const { privacy_note: note, ...bStep3 } = b.step3_contact;
  assert.deepEqual(bStep3, a.step3_contact);
  assert.equal(note.link_url, "https://jiko-navi.jp/policy/");
  assert.equal(note.link_label, "個人情報の取り扱い");
  assert.ok(note.text.length > 0);
  const strip = (s) => ({ ...s, _meta: { ...s._meta, variant: "" }, step3_contact: null });
  assert.deepEqual(strip(b), strip(a));
});

test("the phone guidance matches the 24-hour line", async () => {
  for (const file of ["scenario.json", "scenario_privacy_note.json"]) {
    const scenario = await load(file);
    assert.match(scenario.phone.message, /受付時間：24時間365日（通話無料）/u);
    assert.doesNotMatch(scenario.phone.message, /9:00〜21:00/u);
  }
});
