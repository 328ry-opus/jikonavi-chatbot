/**
 * Jikonavi Chat Widget
 * Self-contained chat widget with scenario + AI modes.
 * Embed: <script src="widget.js" defer></script>
 */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────
  const CONFIG = {
    edgeFunctionUrl: 'https://dxbdqldfqlggsrpcjuwg.supabase.co/functions/v1/chat',
    trackUrl: 'https://dxbdqldfqlggsrpcjuwg.supabase.co/functions/v1/chat-track',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4YmRxbGRmcWxnZ3NycGNqdXdnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2ODczNDgsImV4cCI6MjA4ODI2MzM0OH0.19yhx6Emt3xD4h5goRRQf5Ga4rom3cSur1G5ZRY_FMs',
    brandColor: '#2563eb', // same blue as the site (aoi --blue)
    accentColor: '#027c96',
    widgetWidth: 380,
    widgetHeight: 640,
    maxInputLength: 500,
    botName: '事故なび',
    // Mobile auto-open delay. 11/6: 4000 -> 1000 (Matsumoto request: open sooner so
    // fewer visitors leave before the chat appears; the page still shows for a moment).
    autoOpenDelayMs: 1000,
    greeting: '交通事故に遭われた方へ\n\n通院前に事故なびへ無料相談すると、お見舞金 最大50,000円をお受け取りいただけます。\nまずはお気軽にご相談ください。',
  };

  // Experiment config (max 2 variants at a time)
  // 11/6: contact_friction ended (7/4-11/6: contact step -> submit A 38.4% vs B 34.1%,
  // B did not win), so A stays and the new B adds a note on how the contact details are handled.
  const EXPERIMENT = {
    id: 'privacy_note',
    variants: [
      { key: 'a', weight: 0.5, file: 'scenario.json' },
      { key: 'b', weight: 0.5, file: 'scenario_privacy_note.json' },
    ],
  };

  // ── State ───────────────────────────────────────────────
  const state = {
    isOpen: false,
    mode: 'scenario', // scenario | form_input | ai
    scenarioData: null,
    messages: [],
    sessionId: crypto.randomUUID(),
    uid: null,
    internal: false,
    abVariant: 'a',
    experimentId: EXPERIMENT.id,
    scenarioVersion: 'unknown',
    userName: '',
    conversationHistory: [],
    isLoading: false,
    messageCount: 0,
    formData: {},
    currentFormField: null,
    currentFormNext: null,
    currentNodeId: null,
    inputStartTracked: false,
    nodeHistory: [],
    closeTracked: false,
    openTracked: false,
    autoOpened: false,
  };

  // ── Styles ──────────────────────────────────────────────
  const STYLES = `
    :host { all: initial; font-family: 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    .jn-trigger-wrap {
      position: fixed; bottom: 100px; right: 24px; z-index: 99999;
      display: flex; align-items: center; gap: 0;
    }

    .jn-trigger-label {
      background: #fff; color: ${CONFIG.brandColor};
      font-size: 15px; font-weight: 600; line-height: 1.4;
      padding: 10px 24px 10px 16px; border-radius: 22px;
      margin-right: -12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
      white-space: nowrap;
      animation: jn-labelSlideIn 0.6s ease 1s both;
    }
    .jn-trigger-wrap.open .jn-trigger-label { display: none; }
    /* Tablet and small PC: the label covers page content, so show the round button only (2026-10-19) */
    @media (min-width: 481px) and (max-width: 1199px) { .jn-trigger-label { display: none; } }
    /* Pages that set <meta name="jikonavi-chat-label" content="off"> (forms) show the round button only */
    .jn-trigger-wrap.jn-no-label .jn-trigger-label { display: none; }
    .jn-trigger-wrap.jn-peek-on { display: none !important; }

    .jn-trigger {
      width: 84px; height: 84px; border-radius: 50%;
      background: ${CONFIG.brandColor}; color: #fff;
      border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      transition: transform 0.2s, box-shadow 0.2s;
      position: relative; flex-shrink: 0;
    }
    .jn-trigger:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,0,0,0.25); }
    .jn-trigger svg { width: 36px; height: 36px; }
    .jn-trigger.open svg.icon-chat { display: none; }
    .jn-trigger:not(.open) svg.icon-close { display: none; }

    .jn-badge {
      position: absolute; top: -2px; right: -2px;
      width: 18px; height: 18px; border-radius: 50%;
      background: #e74c3c; border: 2px solid #fff;
    }
    .jn-trigger.open .jn-badge { display: none; }

    @keyframes jn-labelSlideIn {
      from { opacity: 0; transform: translateX(20px); }
      to { opacity: 1; transform: translateX(0); }
    }

    .jn-window {
      position: fixed; bottom: 108px; right: 24px; z-index: 99998;
      width: ${CONFIG.widgetWidth}px; height: ${CONFIG.widgetHeight}px;
      background: #fff; border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      display: flex; flex-direction: column;
      overflow: hidden; opacity: 0; transform: translateY(16px) scale(0.95);
      pointer-events: none;
      transition: opacity 0.25s, transform 0.25s;
    }
    .jn-window.visible {
      opacity: 1; transform: translateY(0) scale(1); pointer-events: auto;
    }
    /* Wide screens: the open trigger (x) sits over the window's bottom-right corner
       (about 84 x 76px), so keep a band free there; buttons and notes stay above it. */
    @media (min-width: 481px) {
      .jn-window { box-sizing: border-box; padding-bottom: 80px; }
    }

    /* Header */
    .jn-header {
      background: ${CONFIG.brandColor}; color: #fff;
      padding: 16px 20px; display: flex; align-items: center; gap: 12px;
      flex-shrink: 0;
    }
    .jn-header-avatar {
      width: 36px; height: 36px; border-radius: 50%; background: #fff;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .jn-header-avatar img { width: 28px; height: 28px; display: block; }
    .jn-header-info h3 { font-size: 15px; font-weight: 700; }
    .jn-header-info p { font-size: 11px; opacity: 0.8; }

    /* Messages */
    .jn-messages {
      flex: 1; overflow-y: auto; padding: 16px;
      display: flex; flex-direction: column; gap: 12px;
      scroll-behavior: smooth;
    }
    .jn-msg { display: flex; gap: 8px; max-width: 88%; animation: jn-fadeIn 0.3s ease; }
    .jn-msg.bot { align-self: flex-start; }
    .jn-msg.user { align-self: flex-end; flex-direction: row-reverse; }

    .jn-msg-avatar {
      width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
      background: ${CONFIG.brandColor}; color: #fff;
      display: flex; align-items: center; justify-content: center; font-size: 12px;
    }
    .jn-msg-avatar svg { width: 18px; height: 18px; }
    .jn-msg.bot .jn-msg-avatar { width: 32px; height: 32px; background: #e8effd; overflow: hidden; }
    .jn-msg-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .jn-msg.user .jn-msg-avatar { background: #95a5a6; }

    .jn-msg-bubble {
      padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.6;
      white-space: pre-wrap; word-break: break-word;
    }
    .jn-msg.bot .jn-msg-bubble { background: #f0f2f5; color: #2d3436; border-bottom-left-radius: 4px; }
    .jn-msg.user .jn-msg-bubble { background: ${CONFIG.brandColor}; color: #fff; border-bottom-right-radius: 4px; }

    /* Options (scenario buttons) */
    .jn-options { display: flex; flex-direction: column; gap: 6px; padding: 0 16px 8px; animation: jn-fadeIn 0.3s ease; }
    .jn-option-btn {
      background: #fff; border: 1.5px solid ${CONFIG.brandColor}; color: ${CONFIG.brandColor};
      padding: 7px 14px; border-radius: 10px; font-size: 13px; font-weight: 600;
      cursor: pointer; text-align: left; transition: all 0.15s;
    }
    .jn-option-btn:hover { background: ${CONFIG.brandColor}; color: #fff; }

    .jn-phone-btn {
      background: #27ae60; border: none; color: #fff;
      padding: 12px 16px; border-radius: 10px; font-size: 14px; font-weight: 700;
      cursor: pointer; text-align: center; display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    .jn-phone-btn:hover { background: #219a52; }

    /* Back button */
    .jn-back-btn {
      background: none; border: none; color: #888; font-size: 12px;
      cursor: pointer; padding: 4px 16px 0; display: block;
      font-family: inherit;
    }
    .jn-back-btn:hover { color: ${CONFIG.brandColor}; }

    /* Input */
    .jn-input-area {
      padding: 12px 16px; border-top: 1px solid #eee; display: flex; gap: 8px;
      flex-shrink: 0; background: #fff;
    }
    .jn-input {
      flex: 1; border: 1.5px solid #ddd; border-radius: 10px; padding: 10px 14px;
      font-size: 14px; outline: none; font-family: inherit; resize: none;
      min-height: 40px; max-height: 80px;
    }
    .jn-input:focus { border-color: ${CONFIG.brandColor}; }
    .jn-input::placeholder { color: #aaa; }
    .jn-send-btn {
      width: 40px; height: 40px; border-radius: 10px; border: none;
      background: ${CONFIG.brandColor}; color: #fff; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: background 0.15s;
    }
    .jn-send-btn:hover { background: ${CONFIG.accentColor}; }
    .jn-send-btn:disabled { background: #ccc; cursor: not-allowed; }
    .jn-send-btn svg { width: 18px; height: 18px; }

    /* Typing indicator */
    .jn-typing { display: flex; gap: 4px; padding: 10px 14px; }
    .jn-typing span {
      width: 8px; height: 8px; background: #bbb; border-radius: 50%;
      animation: jn-bounce 1.2s infinite;
    }
    .jn-typing span:nth-child(2) { animation-delay: 0.2s; }
    .jn-typing span:nth-child(3) { animation-delay: 0.4s; }

    /* AI mode banner */
    .jn-ai-banner {
      background: ${CONFIG.accentColor}; color: #fff; padding: 8px 16px;
      font-size: 12px; text-align: center; font-weight: 600;
    }

    /* Header close button (mobile only) */
    .jn-header-close {
      display: none;
      margin-left: auto;
      background: none; border: none; color: #fff;
      width: 32px; height: 32px; cursor: pointer;
      border-radius: 50%; flex-shrink: 0;
    }
    .jn-header-close:hover { background: rgba(255,255,255,0.2); }
    .jn-header-close svg { width: 20px; height: 20px; }

    /* Mobile */
    .jn-peek {
      position: fixed; left: 12px; right: 12px; z-index: 99997;
      display: grid; gap: 10px; align-items: center;
      padding: 14px 44px 14px 16px; background: #fff; color: #101b3a;
      border: 1px solid #dfe6f5; border-radius: 14px; box-shadow: 0 10px 30px rgba(16,27,58,0.18);
      font-family: inherit; animation: jn-peek-in .25s ease-out;
    }
    .jn-peek-text { margin: 0; font-size: 14px; line-height: 1.6; font-weight: 700; }
    .jn-peek-text span { display: inline-block; white-space: nowrap; }
    .jn-peek-open {
      justify-self: start; border: 0; border-radius: 999px; cursor: pointer;
      padding: 10px 18px; font: inherit; font-size: 14px; font-weight: 700; color: #fff; background: ${CONFIG.brandColor};
    }
    .jn-peek-close {
      position: absolute; top: 8px; right: 8px; width: 32px; height: 32px; border: 0; border-radius: 50%;
      background: transparent; color: #4a5575; cursor: pointer; display: grid; place-items: center;
    }
    .jn-peek-close svg { width: 18px; height: 18px; }
    @keyframes jn-peek-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .jn-peek { animation: none; } }

    @media (max-width: 480px) {
      .jn-window {
        bottom: 0; right: 0; left: 0; top: 0;
        width: 100%; height: 100%;
        border-radius: 0;
      }
      .jn-trigger-wrap { bottom: 95px; right: 16px; }
      .jn-trigger-wrap.open .jn-trigger { display: none; }
      .jn-trigger-label {
        font-size: 13px; padding: 8px 20px 8px 12px; margin-right: -10px; border-radius: 18px;
      }
      .jn-trigger { width: 64px; height: 64px; }
      .jn-trigger svg { width: 30px; height: 30px; }
      .jn-badge { width: 15px; height: 15px; }
      .jn-header-close { display: flex; align-items: center; justify-content: center; }
      .jn-input-area {
        padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
      }
      .jn-input { font-size: 16px; }
    }

    /* Multi-field form */
    .jn-form { padding: 8px 16px 12px; animation: jn-fadeIn 0.3s ease; }
    .jn-form-group { margin-bottom: 14px; }
    .jn-form-label {
      font-size: 12px; font-weight: 700; color: #555; margin-bottom: 6px; display: block;
    }
    .jn-form-label .jn-required { color: #e74c3c; margin-left: 2px; }

    .jn-radio-group, .jn-checkbox-group {
      display: flex; flex-wrap: wrap; gap: 6px;
    }
    .jn-radio-btn, .jn-checkbox-btn {
      background: #fff; border: 1.5px solid #ddd; color: #555;
      padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 500;
      cursor: pointer; transition: all 0.15s; user-select: none;
      font-family: inherit;
    }
    .jn-radio-btn:hover, .jn-checkbox-btn:hover { border-color: ${CONFIG.brandColor}; color: ${CONFIG.brandColor}; }
    .jn-radio-btn.selected {
      background: ${CONFIG.brandColor}; border-color: ${CONFIG.brandColor}; color: #fff;
    }
    .jn-checkbox-btn.selected {
      background: ${CONFIG.accentColor}; border-color: ${CONFIG.accentColor}; color: #fff;
    }

    .jn-form-input {
      width: 100%; border: 1.5px solid #ddd; border-radius: 8px; padding: 8px 12px;
      font-size: 13px; font-family: inherit; outline: none; box-sizing: border-box;
    }
    .jn-form-input:focus { border-color: ${CONFIG.brandColor}; }
    .jn-form-input::placeholder { color: #aaa; }
    select.jn-form-input {
      height: 40px; min-height: 40px; padding-right: 8px; background-color: #fff;
      font-size: 16px; -webkit-appearance: menulist; appearance: auto;
    }
    /* iOS Safari date input overflow fix */
    .jn-date-shell {
      display: flex; align-items: center; width: 100%; min-width: 0;
      padding: 8px 12px; border: 1.5px solid #ddd; border-radius: 8px;
      background: #fff; overflow: hidden; box-sizing: border-box;
    }
    .jn-date-shell:focus-within { border-color: ${CONFIG.brandColor}; }
    .jn-date-shell input[type="date"] {
      flex: 1 1 auto; width: 100%; min-width: 0;
      padding: 0; border: 0; background: transparent;
      font-size: 13px; font-family: inherit; outline: none;
      appearance: auto; -webkit-appearance: auto;
    }

    .jn-form-submit {
      width: 100%; padding: 12px; border: none; border-radius: 10px;
      background: ${CONFIG.brandColor}; color: #fff;
      font-size: 14px; font-weight: 700; cursor: pointer;
      font-family: inherit; transition: background 0.15s; margin-top: 4px;
    }
    .jn-form-submit:hover { background: ${CONFIG.accentColor}; }
    .jn-form-submit:disabled { background: #ccc; cursor: not-allowed; }

    .jn-form-privacy {
      display: flex; gap: 8px; align-items: flex-start;
      margin: 2px 0 10px; padding: 10px 12px; border-radius: 10px;
      background: #f1f5ff; border: 1px solid #dbe5ff; color: #334155;
      font-size: 12px; line-height: 1.65;
    }
    .jn-form-privacy svg { flex: 0 0 16px; width: 16px; height: 16px; margin-top: 2px; color: ${CONFIG.brandColor}; }
    .jn-form-privacy p { margin: 0; }
    .jn-form-privacy.jn-options-privacy { margin: 6px 0 0; }
    .jn-form-privacy a { color: ${CONFIG.brandColor}; text-decoration: underline; text-underline-offset: 2px; }

    .jn-form-error {
      font-size: 11px; color: #e74c3c; margin-top: 4px; display: none;
    }

    @keyframes jn-fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes jn-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-6px); }
    }
  `;

  // ── Icons ───────────────────────────────────────────────
  const ICON_CHAT = '<svg class="icon-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  const ICON_CLOSE = '<svg class="icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const ICON_SEND = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
  const ICON_PHONE = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24c1.12.37 2.33.57 3.57.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2z"/></svg>';
  // Jikonavi logo mark for the chat header (same file as the site's favicon: jikonavi-site public/assets/favicon-shield.webp, 128px).
  const LOGO_MARK_SRC = 'data:image/webp;base64,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';
  const ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  // Bot avatar: the receptionist from the site's hero photo (jikonavi-site public/assets/hero-person.webp,
  // face cropped to 64px PNG). 11/6 replaced the generic operator icon.
  const OPERATOR_PHOTO_SRC = 'data:image/png;base64,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';
  const ICON_OPERATOR = `<img src="${OPERATOR_PHOTO_SRC}" alt="" width="32" height="32">`;

  // ── DOM Setup ───────────────────────────────────────────
  const host = document.createElement('div');
  host.id = 'jikonavi-chat-widget';
  const shadow = host.attachShadow({ mode: 'closed' });

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLES;
  shadow.appendChild(styleEl);

  const container = document.createElement('div');
  shadow.appendChild(container);

  container.innerHTML = `
    <div class="jn-trigger-wrap">
      <div class="jn-trigger-label">お見舞金について<br>チャットで相談</div>
      <button class="jn-trigger" aria-label="チャットを開く">
        ${ICON_CHAT}${ICON_CLOSE}
        <div class="jn-badge"></div>
      </button>
    </div>
    <div class="jn-window">
      <div class="jn-header">
        <div class="jn-header-avatar"><img src="${LOGO_MARK_SRC}" alt="" width="28" height="28"></div>
        <div class="jn-header-info">
          <h3>${CONFIG.botName}</h3>
          <p>交通事故のご相談チャット</p>
        </div>
        <button class="jn-header-close" aria-label="閉じる">${ICON_CLOSE}</button>
      </div>
      <div class="jn-ai-banner" style="display:none;">✨ AI対応モード — 自由に質問できます</div>
      <div class="jn-messages"></div>
      <div class="jn-options-container"></div>
      <div class="jn-input-area">
        <input class="jn-input" type="text" placeholder="メッセージを入力..." maxlength="${CONFIG.maxInputLength}">
        <button class="jn-send-btn" aria-label="送信">${ICON_SEND}</button>
      </div>
    </div>
  `;

  // ── Element refs ────────────────────────────────────────
  const triggerWrap = container.querySelector('.jn-trigger-wrap');
  const labelOff = document.querySelector('meta[name="jikonavi-chat-label"][content="off"]') !== null;
  if (labelOff) triggerWrap.classList.add('jn-no-label');
  const trigger = container.querySelector('.jn-trigger');
  const badge = container.querySelector('.jn-badge');
  const window_ = container.querySelector('.jn-window');
  const messagesEl = container.querySelector('.jn-messages');
  const optionsContainer = container.querySelector('.jn-options-container');
  const aiBanner = container.querySelector('.jn-ai-banner');
  const inputEl = container.querySelector('.jn-input');
  const sendBtn = container.querySelector('.jn-send-btn');
  const inputArea = container.querySelector('.jn-input-area');

  // Mobile keeps the floating trigger and its label, same as desktop (9/30),
  // lifted just above the site's bottom phone/LINE bar when that bar exists.
  function syncExternalMobileTrigger() {
    triggerWrap.hidden = false;
    triggerWrap.style.display = '';
    triggerWrap.style.bottom = window.innerWidth <= 480
      ? `calc(${mobileBarOffset()}px + env(safe-area-inset-bottom, 0px))`
      : '';
  }
  window.addEventListener('resize', syncExternalMobileTrigger, { passive: true });

  // ── Helpers ─────────────────────────────────────────────
  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function addMessage(text, sender) {
    const avatar = sender === 'bot' ? ICON_OPERATOR : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
    const msg = document.createElement('div');
    msg.className = `jn-msg ${sender}`;
    msg.innerHTML = `
      <div class="jn-msg-avatar">${avatar}</div>
      <div class="jn-msg-bubble">${escapeHtml(text)}</div>
    `;
    messagesEl.appendChild(msg);
    state.messages.push({ role: sender === 'bot' ? 'assistant' : 'user', content: text });
    scrollToBottom();
    return msg;
  }

  function addStreamingMessage() {
    const msg = document.createElement('div');
    msg.className = 'jn-msg bot';
    msg.innerHTML = `
      <div class="jn-msg-avatar">${ICON_OPERATOR}</div>
      <div class="jn-msg-bubble"><div class="jn-typing"><span></span><span></span><span></span></div></div>
    `;
    messagesEl.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function updateStreamingMessage(msgEl, text) {
    const bubble = msgEl.querySelector('.jn-msg-bubble');
    bubble.textContent = text;
    scrollToBottom();
  }

  function showOptions(options, phoneNumber) {
    optionsContainer.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'jn-options';

    options.forEach(opt => {
      if (opt.next === 'phone' && phoneNumber) {
        // Phone CTA
        const btn = document.createElement('a');
        btn.className = 'jn-phone-btn';
        btn.href = `tel:${phoneNumber}`;
        btn.innerHTML = `${ICON_PHONE} ${opt.label}`;
        btn.addEventListener('click', () => trackEvent('phone_tap', state.currentNodeId));
        wrapper.appendChild(btn);
      } else {
        const btn = document.createElement('button');
        btn.className = 'jn-option-btn';
        btn.textContent = opt.label;
        btn.addEventListener('click', () => handleOptionClick(opt));
        wrapper.appendChild(btn);
      }
    });

    optionsContainer.appendChild(wrapper);
    scrollToBottom();
  }

  function clearOptions() {
    optionsContainer.innerHTML = '';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function setInputPlaceholder(text) {
    inputEl.placeholder = text;
  }

  function setLoadingState(loading) {
    state.isLoading = loading;
    sendBtn.disabled = loading;
    inputEl.disabled = loading;
  }

  function pickVariant() {
    const totalWeight = EXPERIMENT.variants.reduce((sum, variant) => sum + variant.weight, 0) || 1;
    const rand = Math.random();
    let cumulative = 0;
    for (const variant of EXPERIMENT.variants) {
      cumulative += variant.weight / totalWeight;
      if (rand < cumulative) return variant.key;
    }
    return EXPERIMENT.variants[0].key;
  }

  function initTrackingIdentity() {
    const params = new URLSearchParams(window.location.search || '');
    const internalParam = params.get('jn_internal');

    try {
      let uid = localStorage.getItem('jikonavi_uid');
      if (!uid) {
        uid = crypto.randomUUID();
        localStorage.setItem('jikonavi_uid', uid);
      }
      state.uid = uid;

      if (internalParam === '1') {
        localStorage.setItem('jikonavi_internal', '1');
      } else if (internalParam === '0') {
        localStorage.removeItem('jikonavi_internal');
      }
      state.internal = localStorage.getItem('jikonavi_internal') === '1';
    } catch (e) {
      state.uid = null;
      state.internal = internalParam === '1';
    }
  }

  function buildTrackingMetadata(metadata) {
    const merged = { ...(metadata || {}) };
    if (state.uid) merged.uid = state.uid;
    if (state.internal) merged.internal = true;
    return Object.keys(merged).length > 0 ? merged : null;
  }

  // ── Event tracking ────────────────────────────────────────
  function trackEvent(event, node, metadata) {
    try {
      const safeMetadata = buildTrackingMetadata(metadata);
      const payload = JSON.stringify({
        session_id: state.sessionId,
        event,
        node: node || state.currentNodeId || null,
        variant: state.abVariant,
        experiment_id: state.experimentId,
        scenario_version: state.scenarioVersion,
        metadata: safeMetadata,
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(CONFIG.trackUrl, payload);
      } else {
        fetch(CONFIG.trackUrl, { method: 'POST', body: payload, keepalive: true }).catch(() => {});
      }
    } catch (e) { /* tracking should never break the widget */ }
  }

  function trackClose(reason) {
    if (!state.openTracked || state.closeTracked) return;
    state.closeTracked = true;
    trackEvent('close', state.currentNodeId, reason ? { reason } : null);
  }

  function trackInputStart(nodeId) {
    if (state.inputStartTracked) return;
    state.inputStartTracked = true;
    trackEvent('input_start', nodeId);
  }

  // ── Scenario logic ──────────────────────────────────────
  function showScenarioNode(nodeId, skipHistory) {
    const node = state.scenarioData[nodeId];
    if (!node) return;

    // Track navigation event
    trackEvent('navigate', nodeId);

    // Track history for back navigation
    if (!skipHistory && nodeId !== 'root') {
      state.nodeHistory.push(nodeId);
    }

    // Handle submit action
    if (node.action === 'submit_form') {
      addMessage(node.message, 'bot');
      submitForm();
      return;
    }

    // Handle multi-field form nodes
    if (node.form_type === 'multi_field') {
      state.mode = 'form_input';
      state.currentNodeId = nodeId;
      aiBanner.style.display = 'none';
      inputArea.style.display = 'none';
      addMessage(node.message, 'bot');
      showBackButton();
      setInputPlaceholder('フォームに入力してください');
      inputEl.disabled = true;
      trackInputStart(nodeId);
      renderMultiFieldForm(node);
      return;
    }

    // Handle form input nodes (text/tel)
    if (node.input_type) {
      state.mode = 'form_input';
      state.currentFormField = node.form_field;
      state.currentFormNext = node.next;
      aiBanner.style.display = 'none';
      inputArea.style.display = 'flex';
      addMessage(node.message, 'bot');
      showBackButton();
      setInputPlaceholder(node.input_placeholder || 'ここに入力...');
      inputEl.type = node.input_type === 'tel' ? 'tel' : 'text';
      trackInputStart(nodeId);
      inputEl.focus();
      return;
    }

    // Normal scenario node with button options
    state.mode = 'scenario';
    state.currentNodeId = nodeId;
    aiBanner.style.display = 'none';
    inputArea.style.display = 'none';

    addMessage(node.message, 'bot');
    if (node.options) {
      showOptions(node.options, node.phone_number);
      // 11/6: variant b also shows the privacy note on the first screen, because most
      // visitors leave before answering (open -> start 6.6%), not only at the contact step.
      const note = renderPrivacyNote(node.privacy_note);
      const wrapper = optionsContainer.querySelector('.jn-options');
      if (note && wrapper) {
        note.classList.add('jn-options-privacy');
        wrapper.appendChild(note);
        scrollToBottom();
      }
    }
  }

  // Builds the note from scenario JSON with textContent only; the link must stay on jiko-navi.jp.
  function renderPrivacyNote(note) {
    if (!note || typeof note.text !== 'string' || !note.text) return null;
    const box = document.createElement('div');
    box.className = 'jn-form-privacy';
    box.innerHTML = ICON_LOCK;
    const p = document.createElement('p');
    p.appendChild(document.createTextNode(note.text));
    let linkUrl = null;
    try {
      const url = new URL(note.link_url || '', 'https://jiko-navi.jp/');
      if (url.protocol === 'https:' && url.hostname === 'jiko-navi.jp') linkUrl = url.href;
    } catch (e) { /* invalid url: no link */ }
    if (linkUrl && note.link_label) {
      p.appendChild(document.createTextNode(' '));
      const a = document.createElement('a');
      a.href = linkUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = note.link_label;
      p.appendChild(a);
    }
    box.appendChild(p);
    return box;
  }

  function renderMultiFieldForm(node) {
    optionsContainer.innerHTML = '';
    const form = document.createElement('div');
    form.className = 'jn-form';
    const formState = {};

    node.fields.forEach(field => {
      const group = document.createElement('div');
      group.className = 'jn-form-group';

      // Label
      const label = document.createElement('label');
      label.className = 'jn-form-label';
      label.textContent = field.label;
      if (field.required) {
        const req = document.createElement('span');
        req.className = 'jn-required';
        req.textContent = '*';
        label.appendChild(req);
      }
      group.appendChild(label);

      if (field.type === 'radio') {
        const radioGroup = document.createElement('div');
        radioGroup.className = 'jn-radio-group';
        formState[field.field] = null;
        field.options.forEach(opt => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'jn-radio-btn';
          btn.textContent = opt.label;
          btn.addEventListener('click', () => {
            radioGroup.querySelectorAll('.jn-radio-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            formState[field.field] = opt.value;
          });
          radioGroup.appendChild(btn);
        });
        group.appendChild(radioGroup);

      } else if (field.type === 'checkbox') {
        const cbGroup = document.createElement('div');
        cbGroup.className = 'jn-checkbox-group';
        formState[field.field] = [];
        field.options.forEach(opt => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'jn-checkbox-btn';
          btn.textContent = opt.label;
          btn.addEventListener('click', () => {
            btn.classList.toggle('selected');
            if (btn.classList.contains('selected')) {
              formState[field.field].push(opt.value);
            } else {
              formState[field.field] = formState[field.field].filter(v => v !== opt.value);
            }
          });
          cbGroup.appendChild(btn);
        });
        group.appendChild(cbGroup);

      } else if (field.type === 'date') {
        const shell = document.createElement('div');
        shell.className = 'jn-date-shell';
        const input = document.createElement('input');
        input.type = 'date';
        input.required = !!field.required;
        // Default to today
        input.value = new Date().toISOString().split('T')[0];
        formState[field.field] = input.value;
        input.addEventListener('change', () => { formState[field.field] = input.value; });
        shell.appendChild(input);
        group.appendChild(shell);

      } else if (field.type === 'textarea') {
        const textarea = document.createElement('textarea');
        textarea.className = 'jn-form-input';
        textarea.placeholder = field.placeholder || '';
        textarea.required = !!field.required;
        textarea.rows = 2;
        textarea.style.resize = 'vertical';
        formState[field.field] = '';
        textarea.addEventListener('input', () => { formState[field.field] = textarea.value; });
        group.appendChild(textarea);

      } else if (field.type === 'select') {
        const select = document.createElement('select');
        select.className = 'jn-form-input';
        select.required = !!field.required;

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '選択してください';
        select.appendChild(placeholder);

        (field.options || []).forEach(opt => {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          select.appendChild(option);
        });

        formState[field.field] = '';
        select.addEventListener('change', () => { formState[field.field] = select.value; });
        group.appendChild(select);

      } else if (field.type === 'text' || field.type === 'tel') {
        const input = document.createElement('input');
        input.type = field.type === 'tel' ? 'tel' : 'text';
        input.className = 'jn-form-input';
        input.placeholder = field.placeholder || '';
        input.required = !!field.required;
        formState[field.field] = '';
        input.addEventListener('input', () => { formState[field.field] = input.value; });
        group.appendChild(input);
      }

      // Error message
      const error = document.createElement('div');
      error.className = 'jn-form-error';
      error.dataset.field = field.field;
      group.appendChild(error);

      form.appendChild(group);
    });

    // Optional note on how the entered details are handled (shown right above the submit button).
    const privacyNote = renderPrivacyNote(node.privacy_note);
    if (privacyNote) form.appendChild(privacyNote);

    // Submit button
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'jn-form-submit';
    submitBtn.textContent = node.next === 'confirm' ? '送信する' : '次へ';
    submitBtn.addEventListener('click', () => {
      // Validate
      let valid = true;
      node.fields.forEach(field => {
        const errorEl = form.querySelector(`[data-field="${field.field}"]`);
        if (!field.required) { errorEl.style.display = 'none'; return; }

        const val = formState[field.field];
        let isEmpty = false;
        if (Array.isArray(val)) {
          isEmpty = val.length === 0;
        } else {
          isEmpty = !val || (typeof val === 'string' && !val.trim());
        }

        if (isEmpty) {
          errorEl.textContent = `${field.label}を入力してください`;
          errorEl.style.display = 'block';
          valid = false;
        } else {
          errorEl.style.display = 'none';
        }

        // Phone validation
        if (field.field === 'phone' && val) {
          const digits = val.replace(/[\s\-\u2010-\u2015\u2212\uFF0D]/g, '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
          if (!/^0\d{9,10}$/.test(digits)) {
            errorEl.textContent = '電話番号の形式が正しくありません';
            errorEl.style.display = 'block';
            valid = false;
          }
        }

        // Name validation
        if (field.field === 'name' && val) {
          if (val.trim().length < 2) {
            errorEl.textContent = 'お名前を正しく入力してください';
            errorEl.style.display = 'block';
            valid = false;
          }
        }
      });

      if (!valid) return;

      // Save form data
      Object.entries(formState).forEach(([key, val]) => {
        if (Array.isArray(val)) {
          state.formData[key] = val.join('、');
        } else {
          state.formData[key] = val;
        }
        if (key === 'name' && val) state.userName = val;
      });

      // Show user summary
      const summary = node.fields
        .map(f => {
          const v = Array.isArray(formState[f.field]) ? formState[f.field].join('、') : formState[f.field];
          return v ? `${f.label}: ${v}` : null;
        })
        .filter(Boolean)
        .join('\n');
      addMessage(summary, 'user');

      // Re-enable input and proceed
      inputEl.disabled = false;
      clearOptions();
      showScenarioNode(node.next);
    });
    form.appendChild(submitBtn);

    optionsContainer.appendChild(form);
    scrollToBottom();
  }

  function showBackButton() {
    if (state.nodeHistory.length < 2) return;
    const btn = document.createElement('button');
    btn.className = 'jn-back-btn';
    btn.textContent = '← 入力をやり直す';
    btn.addEventListener('click', () => goBack());
    optionsContainer.innerHTML = '';
    optionsContainer.appendChild(btn);
    scrollToBottom();
  }

  function goBack() {
    // Remove current node
    state.nodeHistory.pop();
    // Get previous node
    const prevNodeId = state.nodeHistory.pop();
    if (!prevNodeId) return;
    // Remove: current bot message, previous user answer, previous bot message
    for (let i = 0; i < 3; i++) {
      const last = messagesEl.querySelector('.jn-msg:last-child');
      if (last) last.remove();
    }
    clearOptions();
    inputEl.type = 'text';
    inputEl.value = '';
    inputEl.disabled = false;
    showScenarioNode(prevNodeId);
  }

  function handleOptionClick(opt) {
    addMessage(opt.label, 'user');
    clearOptions();

    // Save form value if present
    if (opt.form_value) {
      const currentNode = state.scenarioData[state.currentNodeId];
      if (currentNode && currentNode.form_field) {
        state.formData[currentNode.form_field] = opt.form_value;
      }
      // Save inquiry type from root
      if (state.currentNodeId === 'root') {
        state.formData.inquiry_type = opt.form_value;
      }
    }

    if (opt.action === 'switch_to_ai') {
      trackEvent('ai_switch', state.currentNodeId);
      switchToAiMode();
    } else if (opt.next) {
      showScenarioNode(opt.next);
    }
  }

  function switchToAiMode() {
    state.mode = 'ai';
    aiBanner.style.display = 'block';
    inputArea.style.display = 'flex';
    setInputPlaceholder('質問を入力してください...');
    addMessage('交通事故に関することなら、何でもお気軽にご質問ください。', 'bot');
    inputEl.focus();
  }

  // ── AI logic ────────────────────────────────────────────
  async function sendAiMessage(userMessage) {
    if (state.isLoading) return;
    setLoadingState(true);

    addMessage(userMessage, 'user');
    clearOptions();

    // Add to conversation history
    state.conversationHistory.push({ role: 'user', content: userMessage });

    const streamingMsg = addStreamingMessage();
    let fullResponse = '';

    try {
      const response = await fetch(CONFIG.edgeFunctionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.supabaseAnonKey },
        body: JSON.stringify({
          session_id: state.sessionId,
          user_name: state.userName,
          message: userMessage,
          conversation_history: state.conversationHistory.slice(-10), // Last 10 messages
        }),
      });

      if (!response.ok) throw new Error('API error');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              fullResponse += parsed.text;
              updateStreamingMessage(streamingMsg, fullResponse);
            }
          } catch (e) {
            // Not JSON, might be raw text
            fullResponse += data;
            updateStreamingMessage(streamingMsg, fullResponse);
          }
        }
      }

      if (!fullResponse) {
        fullResponse = '申し訳ありません。回答を取得できませんでした。お電話でのご相談もお受けしています。';
        updateStreamingMessage(streamingMsg, fullResponse);
      }

      state.conversationHistory.push({ role: 'assistant', content: fullResponse });
      state.messages.push({ role: 'assistant', content: fullResponse });
      state.messageCount++;

    } catch (err) {
      console.error('Jikonavi chat error:', err);
      fullResponse = '通信エラーが発生しました。恐れ入りますが、お電話でもご相談いただけます。';
      updateStreamingMessage(streamingMsg, fullResponse);
    } finally {
      setLoadingState(false);
      // Show follow-up options after AI response
      showOptions([
        { label: '他にも質問がある', action: 'switch_to_ai' },
        { label: '電話で相談する', next: 'phone' },
        { label: '最初に戻る', next: 'root' },
      ], state.scenarioData?.phone?.phone_number);
    }
  }

  // ── Input handling ──────────────────────────────────────
  function handleSend() {
    const text = inputEl.value.trim();
    if (!text || state.isLoading) return;
    inputEl.value = '';

    if (state.mode === 'form_input') {
      // Validate phone number
      if (state.currentFormField === 'phone') {
        const digits = text.replace(/[\s\-\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFF0D]/g, '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
        if (!/^0\d{9,10}$/.test(digits)) {
          addMessage('電話番号の形式が正しくないようです。\n例：090-1234-5678', 'bot');
          scrollToBottom();
          return;
        }
      }
      // Validate name (at least 2 chars, no digits only)
      if (state.currentFormField === 'name') {
        if (text.length < 2 || /^\d+$/.test(text)) {
          addMessage('お名前を正しく入力してください。', 'bot');
          scrollToBottom();
          return;
        }
      }

      addMessage(text, 'user');
      state.formData[state.currentFormField] = text;
      if (state.currentFormField === 'name') {
        state.userName = text;
      }
      const nextNode = state.currentFormNext;
      inputEl.type = 'text';
      inputEl.value = '';
      requestAnimationFrame(() => {
        inputEl.value = '';
        showScenarioNode(nextNode);
      });
      return;
    }

    if (state.mode === 'ai') {
      clearOptions();
      sendAiMessage(text);
      return;
    }

    // In scenario mode, ignore free text input (input area is hidden)
    if (state.mode === 'scenario') {
      return;
    }
  }

  // ── Form submission ────────────────────────────────────
  async function submitForm() {
    setLoadingState(true);
    trackEvent('submit', 'confirm');
    try {
      const response = await fetch(CONFIG.edgeFunctionUrl.replace('/chat', '/chat-form'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.supabaseAnonKey },
        body: JSON.stringify({
          session_id: state.sessionId,
          form_data: state.formData,
          variant: state.abVariant,
          experiment_id: state.experimentId,
          scenario_version: state.scenarioVersion,
          page_url: window.location.href,
          user_agent: navigator.userAgent,
          device_type: /Mobile|Android|iPhone/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
        }),
      });

      if (!response.ok) {
        let errorBody = null;
        try {
          errorBody = await response.json();
        } catch (_) {
          errorBody = null;
        }
        if (response.status === 403 && errorBody?.code === 'unsupported_browser') {
          addMessage(errorBody.message || 'このブラウザからは送信できません。お手数ですがお電話でご連絡ください。', 'bot');
          showScenarioNode('phone');
          return;
        }
        throw new Error('Submit failed');
      }

      // Skip conversion tracking for blocklisted submissions (still shows success)
      let result = null;
      try { result = await response.json(); } catch (_) { result = null; }

      // GTM tracking: push event for form submission conversion (non-blocking)
      if (!result?.blocked) {
        try { window.dataLayer = window.dataLayer || []; window.dataLayer.push({ event: 'jn_chat_submit', jn_variant: state.abVariant }); } catch (_) {}
      }

      showScenarioNode('complete');
    } catch (err) {
      console.error('Form submit error:', err);
      addMessage('送信中にエラーが発生しました。お手数ですがお電話でご連絡ください。', 'bot');
      showScenarioNode('phone');
    } finally {
      setLoadingState(false);
    }
  }

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend();
    }
  });
  sendBtn.addEventListener('click', handleSend);

  // ── Toggle ──────────────────────────────────────────────
  function toggle() {
    state.isOpen = !state.isOpen;
    window_.classList.toggle('visible', state.isOpen);
    trigger.classList.toggle('open', state.isOpen);
    triggerWrap.classList.toggle('open', state.isOpen);
    trigger.setAttribute('aria-label', state.isOpen ? 'チャットを閉じる' : 'チャットを開く');

    if (state.isOpen && state.messages.length === 0) {
      initChat();
      // GTM tracking: push event for ad conversion measurement
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: 'jn_chat_open', jn_open_method: state.autoOpened ? 'auto' : 'manual' });
    } else if (!state.isOpen && state.messages.length > 0) {
      trackClose();
    }
  }

  trigger.addEventListener('click', toggle);
  container.querySelector('.jn-header-close').addEventListener('click', toggle);

  // Expose global API so external buttons can open the chat
  window.jikonautoChat = { toggle, open: () => { if (!state.isOpen) toggle(); } };

  // Mobile chat entry is the floating trigger (9/30). Hide the chat slot that the
  // site's bottom bar carries and return the bar to the phone/LINE two columns.
  function mountMobileBottomBarTrigger() {
    if (!document.getElementById('jikonavi-chat-mobile-bar-style')) {
      const style = document.createElement('style');
      style.id = 'jikonavi-chat-mobile-bar-style';
      style.textContent = `
        @media (max-width: 480px) {
          .sp-bar [data-mobile-chat-trigger] { display: none !important; }
          .sp-bar:not(.sp-bar--clinic) { grid-template-columns: 1fr 1fr !important; }
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
    syncExternalMobileTrigger();
  }

  mountMobileBottomBarTrigger();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountMobileBottomBarTrigger, { once: true });
  }

  // Mobile hero (11/6, Matsumoto request): on phones the site's first screen offers only
  // the phone button. Show chat and phone side by side (chat left, half each).
  // - Top page: reveal the chat button the site already renders but hides on phones.
  // - Clinic pages: add a chat button next to the phone button.
  // Bridge until the site ships the same layout itself: skipped when the site marks
  // its hero with [data-hero-chat].
  const HERO_CHAT_MEDIA = '(max-width: 760px)';
  function mountHeroChat() {
    if (document.querySelector('[data-hero-chat]')) return;
    const home = document.querySelector('.home-phone-first .hero-cta');
    const clinic = document.querySelector('.clinic-hero-contact');
    const clinicPhone = clinic && clinic.querySelector('.clinic-hero-phone');
    if (!home && !clinicPhone) return;

    if (!document.getElementById('jikonavi-chat-hero-style')) {
      const style = document.createElement('style');
      style.id = 'jikonavi-chat-hero-style';
      style.textContent = `
        .jn-hero-row > .jn-hero-chat, .jn-phone-compact { display: none; }
        @media ${HERO_CHAT_MEDIA} {
          .jn-hero-split, .jn-hero-row { display: flex !important; gap: 8px; align-items: stretch; }
          .jn-hero-split > .btn, .jn-hero-row > .btn {
            flex: 1 1 0 !important; width: auto !important; min-width: 0; min-height: 66px;
            margin: 0; padding: 10px 6px !important; border-radius: 12px;
            justify-content: center !important; text-align: center;
          }
          .jn-hero-split > .btn-chat, .jn-hero-row > .jn-hero-chat {
            display: flex !important; order: -1; flex-direction: column; align-items: center; gap: 3px;
            background: #2563eb; color: #fff; border: 2px solid #2563eb; box-shadow: 0 6px 18px #2563eb35;
            font-weight: 900; line-height: 1.35;
          }
          .jn-hero-split > .btn-chat svg, .jn-hero-row > .jn-hero-chat svg { display: none; }
          .jn-hero-split > .btn-chat .btn-label, .jn-hero-chat .jn-hero-chat-label {
            display: flex; flex-direction: column; align-items: center; gap: 2px;
            font-size: clamp(13px, 4.1vw, 16px); line-height: 1.35; text-align: center; white-space: nowrap;
          }
          .jn-hero-split > .btn-chat small, .jn-hero-chat small,
          .jn-hero-split > .hero-phone small, .jn-phone-compact small {
            font-size: 12px; font-weight: 700; opacity: .95; white-space: nowrap; letter-spacing: 0;
          }
          /* Same two lines on both pages: the number, then "24時間365日・通話無料". */
          .jn-hero-row > .clinic-hero-phone > :not(.jn-phone-compact) { display: none !important; }
          .jn-hero-row > .clinic-hero-phone > .jn-phone-compact {
            display: flex; flex-direction: column; align-items: center; gap: 2px; line-height: 1.4;
          }
          .jn-hero-split > .hero-phone .btn-label { gap: 2px; }
          .jn-hero-split > .hero-phone strong, .jn-phone-compact strong {
            font-size: clamp(14px, 4.6vw, 18px); font-weight: 900; white-space: nowrap; letter-spacing: .01em;
          }
        }
        @media (max-width: 340px) {
          .jn-hero-split > .btn-chat small, .jn-hero-chat small,
          .jn-hero-split > .hero-phone small, .jn-phone-compact small { font-size: 11px; white-space: normal; }
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    if (home) home.classList.add('jn-hero-split');

    if (clinicPhone && !clinic.querySelector('.jn-hero-row')) {
      const row = document.createElement('div');
      row.className = 'jn-hero-row';
      const chat = document.createElement('a');
      chat.className = 'btn btn-chat jn-hero-chat';
      chat.href = '/contact/';
      chat.innerHTML = `${ICON_CHAT}<span class="jn-hero-chat-label">チャットで相談する<small>まず軽くたずねたい方</small></span>`;
      chat.addEventListener('click', (event) => {
        event.preventDefault();
        window.jikonautoChat.open();
      });
      // Compact two-line label for the half-width phone button (the site's own label stays for wide screens).
      const compact = document.createElement('span');
      compact.className = 'jn-phone-compact';
      compact.innerHTML = '<strong>0120-911-427</strong><small>24時間365日・通話無料</small>';
      clinicPhone.appendChild(compact);
      clinicPhone.parentNode.insertBefore(row, clinicPhone);
      row.appendChild(chat);
      row.appendChild(clinicPhone);
    }
  }

  mountHeroChat();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountHeroChat, { once: true });
  }

  window.addEventListener('pagehide', () => {
    trackClose('pagehide');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') trackClose('pagehide');
  });

  // Mobile: after 4 seconds (once per session) replace the floating trigger with a
  // small peek bubble above the bottom bar instead of opening the full-screen
  // chat, so the page the visitor is reading stays visible. Tapping it opens the chat.
  // (8/31 auto-open kept as a proactive nudge; 9/30 changed from full-screen to peek.)
  function mobileBarOffset() {
    let el = document.querySelector('.sp-bar') || document.querySelector('[data-mobile-chat-trigger]');
    while (el && el !== document.body) {
      if (getComputedStyle(el).position === 'fixed') return el.getBoundingClientRect().height + 12;
      el = el.parentElement;
    }
    return 96;
  }

  function showPeek() {
    if (labelOff || state.isOpen || container.querySelector('.jn-peek')) return;
    const peek = document.createElement('div');
    peek.className = 'jn-peek';
    peek.setAttribute('role', 'dialog');
    peek.setAttribute('aria-label', 'チャットのご案内');
    peek.style.bottom = `calc(${mobileBarOffset()}px + env(safe-area-inset-bottom, 0px))`;
    peek.innerHTML = `
      <p class="jn-peek-text"><span>交通事故のご相談を、</span><span>24時間365日</span><span>チャットで</span><span>受け付けています。</span></p>
      <button type="button" class="jn-peek-open">チャットで相談する</button>
      <button type="button" class="jn-peek-close" aria-label="閉じる">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>`;
    let hideTimer;
    const remove = () => {
      peek.remove();
      clearTimeout(hideTimer);
      triggerWrap.classList.remove('jn-peek-on');
    };
    hideTimer = setTimeout(remove, 15000);
    peek.querySelector('.jn-peek-open').addEventListener('click', () => {
      remove();
      state.autoOpened = true;
      window.jikonautoChat.open();
    });
    peek.querySelector('.jn-peek-close').addEventListener('click', remove);
    triggerWrap.classList.add('jn-peek-on');
    container.appendChild(peek);
    if (window.dataLayer) window.dataLayer.push({ event: 'jn_chat_peek_shown' });
  }

  // Mobile: open the full-screen chat shortly after landing (once per session).
  // 10/27 restored from the 9/30 peek: chat leads from ads fell from 94 (Sep) to 10 (Oct 1-25)
  // right after the peek replaced the auto-open. showPeek() above is kept for a later A/B test.
  // 11/6: delay shortened from 4 seconds to CONFIG.autoOpenDelayMs.
  // Form pages skip it without using up the once-per-session flag.
  if (window.innerWidth <= 480 && !labelOff) {
    try {
      if (!sessionStorage.getItem('jn_auto_open_done')) {
        setTimeout(() => {
          // A site dialog (e.g. a one-time notice) is open: do not stack the chat on it,
          // and keep the once-per-session flag so the next page can still open the chat.
          if (!state.isOpen && !document.querySelector('dialog[open]')) {
            state.autoOpened = true;
            window.jikonautoChat.open();
            sessionStorage.setItem('jn_auto_open_done', '1');
          }
        }, CONFIG.autoOpenDelayMs);
      }
    } catch (e) { /* sessionStorage blocked */ }
  }

  // ── Init ────────────────────────────────────────────────
  async function initChat() {
    // Variant assignment (persisted per experiment)
    try {
      const storageKey = `jikonavi_variant_${EXPERIMENT.id}`;
      let variant = localStorage.getItem(storageKey);
      if (!variant || !EXPERIMENT.variants.some(v => v.key === variant)) {
        variant = pickVariant();
        localStorage.setItem(storageKey, variant);
      }
      state.abVariant = variant;
    } catch (e) {
      state.abVariant = pickVariant(); // localStorage blocked: assign randomly for this load only.
    }

    // Load scenario data from experiment config
    // Find widget script by src to reliably get base URL (currentScript may be null with defer)
    const scriptEl = document.currentScript
      || document.querySelector('script[src*="widget.js"]');
    const scriptSrc = scriptEl?.src || '';
    const baseUrl = scriptSrc ? scriptSrc.replace(/widget\.js.*$/, '') : './';

    const assignedVariant = EXPERIMENT.variants.find(v => v.key === state.abVariant) || EXPERIMENT.variants[0];
    const scenarioFile = assignedVariant.file || EXPERIMENT.variants[0].file;

    try {
      const cacheBust = '?t=' + Date.now();
      const scenarioRes = await fetch(baseUrl + scenarioFile + cacheBust);
      if (scenarioRes.ok) {
        state.scenarioData = await scenarioRes.json();
      } else {
        // Fallback to control scenario if target file is missing
        const fallbackRes = await fetch(baseUrl + EXPERIMENT.variants[0].file + cacheBust);
        state.scenarioData = await fallbackRes.json();
        state.abVariant = EXPERIMENT.variants[0].key;
      }
    } catch (e) {
      console.error('Jikonavi: scenario.json load failed', e);
      state.scenarioData = {
        root: {
          message: '申し訳ありません。読み込みに失敗しました。お電話（0120-911-427）でご相談ください。',
          options: [
            { label: '電話で相談する', next: 'phone' },
          ],
        },
      };
    }

    const scenarioMeta = state.scenarioData?._meta || {};
    state.experimentId = scenarioMeta.experiment_id || EXPERIMENT.id;
    state.scenarioVersion = scenarioMeta.scenario_version || 'unknown';

    // Track chat open
    state.openTracked = true;
    trackEvent('open', null, {
      trigger: state.autoOpened ? 'auto' : 'manual',
      page: window.location.pathname || '/',
    });

    addMessage(CONFIG.greeting, 'bot');
    state.nodeHistory.push('root');
    showScenarioNode('root');
    // Hide badge after first open
    badge.style.display = 'none';
  }

  // ── Mount ───────────────────────────────────────────────
  initTrackingIdentity();
  document.body.appendChild(host);

})();
