import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../widget.js", import.meta.url), "utf8");
const mobileBlock = source.match(/@media \(max-width: 480px\) \{(?<body>[\s\S]*?)\n    \}\n\n    \/\* Multi-field form \*\//u)?.groups?.body ?? "";

test("mobile chat trigger shows a compact label like desktop", () => {
  assert.match(mobileBlock, /\.jn-trigger-label \{\s*font-size: 13px;/u);
  assert.match(source, /\.jn-trigger-wrap\.jn-peek-on \{ display: none !important; \}/u);
  assert.match(mobileBlock, /\.jn-trigger \{ width: 72px; height: 72px; \}/u);
  assert.match(mobileBlock, /\.jn-trigger svg \{ width: 34px; height: 34px; \}/u);
  assert.match(mobileBlock, /\.jn-option-btn \{ font-size: 15px; padding: 12px 16px;/u);
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

test("site bottom bar drops its chat slot on mobile and returns to two columns", () => {
  assert.match(source, /\.sp-bar \[data-mobile-chat-trigger\] \{ display: none !important; \}/u);
  assert.match(source, /\.sp-bar:not\(\.sp-bar--clinic\) \{ grid-template-columns: 1fr 1fr !important; \}/u);
  assert.doesNotMatch(source, /bar\.appendChild\(button\);/u);
});

test("mobile opens the full-screen chat 1 second after landing, once per session", () => {
  const block = source.slice(source.indexOf("if (window.innerWidth <= 480 && !labelOff) {"), source.indexOf("// ── Init"));
  assert.ok(block.length > 0);
  assert.match(block, /state\.autoOpened = true;\s*window\.jikonautoChat\.open\(\);/u);
  assert.match(block, /sessionStorage\.setItem\('jn_auto_open_done', '1'\);/u);
  assert.match(block, /\}, CONFIG\.autoOpenDelayMs\);/u);
  assert.match(source, /autoOpenDelayMs: 1000,/u);
  assert.doesNotMatch(block, /showPeek\(\);/u);
  assert.match(block, /!document\.querySelector\('dialog\[open\]'\)/u);
});

test("mobile hero puts a chat button beside the phone button until the site does it itself", () => {
  const block = source.slice(source.indexOf("function mountHeroChat() {"), source.indexOf("mountHeroChat();\n"));
  assert.ok(block.length > 0);
  assert.match(block, /if \(document\.querySelector\('\[data-hero-chat\]'\)\) return;/u);
  assert.match(block, /\.home-phone-first \.hero-cta/u);
  assert.match(block, /\.clinic-hero-contact/u);
  assert.match(block, /order: -1;/u);
  assert.match(block, /window\.jikonautoChat\.open\(\);/u);
  assert.match(source, /const HERO_CHAT_MEDIA = '\(max-width: 760px\)';/u);
  assert.match(source, /document\.addEventListener\('DOMContentLoaded', mountHeroChat, \{ once: true \}\);/u);
});

test("privacy note is built with text nodes and only links to jiko-navi.jp", () => {
  const block = source.slice(source.indexOf("function renderPrivacyNote(note) {"), source.indexOf("function renderMultiFieldForm(node) {"));
  assert.ok(block.length > 0);
  assert.match(block, /document\.createTextNode\(note\.text\)/u);
  assert.match(block, /url\.protocol === 'https:' && url\.hostname === 'jiko-navi\.jp'/u);
  assert.doesNotMatch(block, /innerHTML = note/u);
});

test("form pages that set the label-off meta never auto-open", () => {
  assert.match(source, /const labelOff = document\.querySelector\('meta\[name="jikonavi-chat-label"\]\[content="off"\]'\) !== null;/u);
  assert.match(source, /if \(window\.innerWidth <= 480 && !labelOff\) \{/u);
});
