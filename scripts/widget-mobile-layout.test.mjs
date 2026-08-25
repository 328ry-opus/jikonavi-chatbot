import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../widget.js", import.meta.url), "utf8");
const mobileBlock = source.match(/@media \(max-width: 480px\) \{(?<body>[\s\S]*?)\n    \}\n\n    \/\* Multi-field form \*\//u)?.groups?.body ?? "";

test("mobile chat trigger remains accessible without covering card CTA labels", () => {
  assert.match(mobileBlock, /\.jn-trigger-label \{ display: none; \}/u);
  assert.match(mobileBlock, /\.jn-trigger \{ width: 56px; height: 56px; \}/u);
  assert.match(mobileBlock, /\.jn-trigger svg \{ width: 26px; height: 26px; \}/u);
  assert.ok(56 >= 44, "mobile trigger must retain a 44px touch target");
});

test("desktop trigger and label remain unchanged", () => {
  const desktopSource = source.slice(0, source.indexOf("@media (max-width: 480px)"));
  assert.match(desktopSource, /\.jn-trigger-label \{/u);
  assert.match(desktopSource, /\.jn-trigger \{[\s\S]*?width: 84px; height: 84px;/u);
});

test("site mobile bottom bar replaces only the floating trigger", () => {
  assert.match(source, /document\.querySelector\('\[data-mobile-chat-trigger\]'\)/u);
  assert.match(source, /triggerWrap\.hidden = Boolean\(hasExternalMobileTrigger\);/u);
  assert.match(source, /triggerWrap\.style\.display = hasExternalMobileTrigger \? 'none' : '';/u);
  assert.match(source, /document\.addEventListener\('DOMContentLoaded', syncExternalMobileTrigger, \{ once: true \}\);/u);
  assert.match(source, /window\.jikonautoChat = \{ toggle, open:/u);
  assert.doesNotMatch(source, /window_\.hidden = Boolean\(hasExternalMobileTrigger\)/u);
});
