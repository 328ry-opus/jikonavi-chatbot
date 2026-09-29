import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../widget.js", import.meta.url), "utf8");
const mobileBlock = source.match(/@media \(max-width: 480px\) \{(?<body>[\s\S]*?)\n    \}\n\n    \/\* Multi-field form \*\//u)?.groups?.body ?? "";

test("mobile chat trigger shows a compact label like desktop", () => {
  assert.match(mobileBlock, /\.jn-trigger-label \{\s*font-size: 13px;/u);
  assert.match(source, /\.jn-trigger-wrap\.jn-label-off \.jn-trigger-label \{ display: none; \}/u);
  assert.match(mobileBlock, /\.jn-trigger \{ width: 56px; height: 56px; \}/u);
  assert.match(mobileBlock, /\.jn-trigger svg \{ width: 26px; height: 26px; \}/u);
});

test("desktop trigger and label remain unchanged", () => {
  const desktopSource = source.slice(0, source.indexOf("@media (max-width: 480px)"));
  assert.match(desktopSource, /\.jn-trigger-label \{/u);
  assert.match(desktopSource, /\.jn-trigger \{[\s\S]*?width: 84px; height: 84px;/u);
});

test("mobile floating trigger stays visible above the site bottom bar", () => {
  assert.match(source, /document\.querySelector\('\[data-mobile-chat-trigger\]'\)/u);
  assert.match(source, /triggerWrap\.hidden = false;/u);
  assert.match(source, /triggerWrap\.style\.bottom = window\.innerWidth <= 480/u);
  assert.match(source, /document\.addEventListener\('DOMContentLoaded', mountMobileBottomBarTrigger, \{ once: true \}\);/u);
  assert.match(source, /window\.jikonautoChat = \{ toggle, open:/u);
});

test("legacy two-column production bar receives one compact chat control", () => {
  assert.match(source, /\.sp-bar:not\(\.sp-bar--clinic\)/u);
  assert.match(source, /\.sp-bar\.jn-has-chat \{ grid-template-columns: 1fr 1fr 58px !important; \}/u);
  assert.match(source, /button\.setAttribute\('data-mobile-chat-trigger', ''\);/u);
  assert.match(source, /bar\.appendChild\(button\);/u);
  assert.match(source, /if \(existing\) \{[\s\S]*?return;/u);
});

test("mobile auto nudge shows a small peek instead of opening the full-screen chat", () => {
  const block = source.slice(source.indexOf("if (window.innerWidth <= 480) {\n    try {"), source.indexOf("// ── Init"));
  assert.match(block, /showPeek\(\);/u);
  assert.doesNotMatch(block, /window\.jikonautoChat\.open\(\)/u);
  assert.match(source, /container\.appendChild\(peek\);/u);
  assert.match(source, /\.jn-peek \{[\s\S]*?position: fixed;/u);
});
