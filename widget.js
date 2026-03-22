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
    brandColor: '#1a5995',
    accentColor: '#027c96',
    widgetWidth: 380,
    widgetHeight: 640,
    maxInputLength: 500,
    botName: '事故なび',
    greeting: '交通事故に遭われた方へ\n\n通院前に事故なびへ無料相談すると、お見舞金 最大50,000円をお受け取りいただけます。\nまずはお気軽にご相談ください。',
  };

  // ── State ───────────────────────────────────────────────
  const state = {
    isOpen: false,
    mode: 'scenario', // scenario | form_input | ai
    scenarioData: null,
    messages: [],
    sessionId: crypto.randomUUID(),
    userName: '',
    conversationHistory: [],
    isLoading: false,
    messageCount: 0,
    formData: {},
    currentFormField: null,
    currentFormNext: null,
    currentNodeId: null,
  };

  // ── Styles ──────────────────────────────────────────────
  const STYLES = `
    :host { all: initial; font-family: 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    .jn-trigger-wrap {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
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

    /* Header */
    .jn-header {
      background: ${CONFIG.brandColor}; color: #fff;
      padding: 16px 20px; display: flex; align-items: center; gap: 12px;
      flex-shrink: 0;
    }
    .jn-header-avatar {
      width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,0.2);
      display: flex; align-items: center; justify-content: center; font-size: 18px;
      flex-shrink: 0;
    }
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
    @media (max-width: 480px) {
      .jn-window {
        bottom: 0; right: 0; left: 0; top: 0;
        width: 100%; height: 100%;
        border-radius: 0;
      }
      .jn-trigger-wrap { bottom: 16px; right: 16px; }
      .jn-trigger-wrap.open .jn-trigger { display: none; }
      .jn-trigger-label { font-size: 12px; padding: 6px 12px 6px 10px; }
      .jn-header-close { display: flex; align-items: center; justify-content: center; }
      .jn-input-area {
        padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
      }
      .jn-input { font-size: 16px; }
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
  // Operator with headset
  const ICON_OPERATOR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4z"/><path d="M12 14c-4 0-8 2-8 4v1c0 .55.45 1 1 1h14c.55 0 1-.45 1-1v-1c0-2-4-4-8-4z"/><path d="M20 8h-1c0-3.31-2.69-6-6-6S7 4.69 7 8H6c-.55 0-1 .45-1 1v2c0 .55.45 1 1 1h1v-1c0-2.76 2.24-5 5-5s5 2.24 5 5v1h1c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1z"/></svg>';

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
        <div class="jn-header-avatar">🏥</div>
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
  const trigger = container.querySelector('.jn-trigger');
  const badge = container.querySelector('.jn-badge');
  const window_ = container.querySelector('.jn-window');
  const messagesEl = container.querySelector('.jn-messages');
  const optionsContainer = container.querySelector('.jn-options-container');
  const aiBanner = container.querySelector('.jn-ai-banner');
  const inputEl = container.querySelector('.jn-input');
  const sendBtn = container.querySelector('.jn-send-btn');

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

  // ── Scenario logic ──────────────────────────────────────
  function showScenarioNode(nodeId) {
    const node = state.scenarioData[nodeId];
    if (!node) return;

    // Handle submit action
    if (node.action === 'submit_form') {
      addMessage(node.message, 'bot');
      submitForm();
      return;
    }

    // Handle form input nodes (text/tel)
    if (node.input_type) {
      state.mode = 'form_input';
      state.currentFormField = node.form_field;
      state.currentFormNext = node.next;
      aiBanner.style.display = 'none';
      addMessage(node.message, 'bot');
      setInputPlaceholder(node.input_placeholder || 'ここに入力...');
      inputEl.type = node.input_type === 'tel' ? 'tel' : 'text';
      inputEl.focus();
      return;
    }

    // Normal scenario node with button options
    state.mode = 'scenario';
    state.currentNodeId = nodeId;
    aiBanner.style.display = 'none';
    setInputPlaceholder('選択肢をお選びください');

    addMessage(node.message, 'bot');
    if (node.options) {
      showOptions(node.options, node.phone_number);
    }
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
      switchToAiMode();
    } else if (opt.next) {
      showScenarioNode(opt.next);
    }
  }

  function switchToAiMode() {
    state.mode = 'ai';
    aiBanner.style.display = 'block';
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
        headers: { 'Content-Type': 'application/json' },
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

    // In scenario mode, if user types freely, switch to AI
    if (state.mode === 'scenario') {
      clearOptions();
      switchToAiMode();
      sendAiMessage(text);
    }
  }

  // ── Form submission ────────────────────────────────────
  async function submitForm() {
    setLoadingState(true);
    try {
      const response = await fetch(CONFIG.edgeFunctionUrl.replace('/chat', '/chat-form'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: state.sessionId,
          form_data: state.formData,
          page_url: window.location.href,
        }),
      });

      if (!response.ok) throw new Error('Submit failed');

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
    if (e.key === 'Enter' && !e.shiftKey) {
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
    }
  }

  trigger.addEventListener('click', toggle);
  container.querySelector('.jn-header-close').addEventListener('click', toggle);

  // ── Init ────────────────────────────────────────────────
  async function initChat() {
    // Load scenario data
    try {
      const scriptSrc = document.querySelector('#jikonavi-chat-widget')
        ? '' : (document.currentScript?.src || '');
      const baseUrl = scriptSrc ? scriptSrc.replace(/widget\.js.*$/, '') : './';
      const res = await fetch(baseUrl + 'scenario.json');
      state.scenarioData = await res.json();
    } catch (e) {
      console.error('Jikonavi: scenario.json load failed', e);
      // Fallback: inline minimal scenario
      state.scenarioData = {
        root: {
          message: 'どのようなご相談ですか？',
          options: [
            { label: '自由に質問する（AI対応）', action: 'switch_to_ai' },
          ],
        },
      };
    }

    addMessage(CONFIG.greeting, 'bot');
    showScenarioNode('root');
    // Hide badge after first open
    badge.style.display = 'none';
  }

  // ── Mount ───────────────────────────────────────────────
  document.body.appendChild(host);

})();
