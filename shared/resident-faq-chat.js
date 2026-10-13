/**
 * Wires the resident floating FAQ chat to POST /faq/chat (Groq + FAQ DB).
 * Expects #chatToggle, #chatWindow, #chatBody, #chatInput, .chat-footer button.
 * API base: script[data-api-base] or https://sb-draft1.onrender.com
 */
(function residentFaqChatInit(global) {
  const doc = global.document;
  const scriptEl = doc.querySelector('script[src*="resident-faq-chat.js"]');
  const rawBase =
    (scriptEl && scriptEl.getAttribute("data-api-base")) || global.__SB_API_BASE__ || "https://sb-draft1.onrender.com";
  const apiBase = String(rawBase || "").replace(/\/$/, "");

  function qs(id) {
    return doc.getElementById(id);
  }

  function injectStylesOnce() {
    if (doc.getElementById("resident-faq-chat-styles")) return;
    const s = doc.createElement("style");
    s.id = "resident-faq-chat-styles";
    s.textContent = `
      .faq-chat-reply { white-space: pre-wrap; word-break: break-word; }
      .faq-chat-inline-link {
        color: #16a34a;
        font-weight: 600;
        text-decoration: underline;
      }
      .faq-chat-inline-link:hover { color: #15803d; }
      .faq-chat-err { color: #b91c1c !important; }
      .chat-footer button:disabled { opacity: 0.55; cursor: not-allowed; }
    `;
    doc.head.appendChild(s);
  }

  function seedWelcome() {
    const body = qs("chatBody");
    if (!body || body.dataset.faqChatReady === "1") return;
    body.dataset.faqChatReady = "1";
    body.innerHTML = "";
    const w1 = doc.createElement("div");
    w1.className = "msg msg-ai faq-chat-reply";
    w1.innerHTML =
      `Hi! I'm your SB AI! For updates, always check your Bulletin Board to be notified into the current programs/activities of the barangay!` +
      `<br><i>Hi! Ako ang iyong SB AI! Para sa updates, palaging tignan ang inyong Bulletin Board para malaman ang mga kasalukuyang programa/aktibidad ng barangay!</i>`;
    body.appendChild(w1);
    scrollChatToBottom();

    global.setTimeout(() => {
      // If the chat was re-seeded or removed, skip.
      const latestBody = qs("chatBody");
      if (!latestBody || latestBody.dataset.faqChatReady !== "1") return;
      if (latestBody.dataset.faqChatSecondWelcome === "1") return;
      latestBody.dataset.faqChatSecondWelcome = "1";

      const w2 = doc.createElement("div");
      w2.className = "msg msg-ai faq-chat-reply";
      w2.innerHTML =
        `I'm here to help you, what do you like to ask?` +
        `<br><i>Nandito ako para tulungan ka, ano ang gusto mong itanong?</i>`;
      latestBody.appendChild(w2);
      scrollChatToBottom();
    }, 5000);
  }

  function scrollChatToBottom() {
    const body = qs("chatBody");
    if (body) body.scrollTop = body.scrollHeight;
  }

  function getSendButton() {
    const footer = doc.querySelector(".chat-footer");
    return footer ? footer.querySelector("button") : null;
  }

  function toggleChat() {
    const win = qs("chatWindow");
    const inp = qs("chatInput");
    if (!win) return;
    const opening = win.style.display !== "flex";
    win.style.display = opening ? "flex" : "none";
    if (opening && inp) {
      seedWelcome();
      global.requestAnimationFrame(() => inp.focus());
    }
  }

  function appendUserMessage(text) {
    const body = qs("chatBody");
    const div = doc.createElement("div");
    div.className = "msg msg-user faq-chat-reply";
    div.textContent = text;
    body.appendChild(div);
    scrollChatToBottom();
  }

  function appendAssistantShell() {
    const body = qs("chatBody");
    const div = doc.createElement("div");
    div.className = "msg msg-ai faq-chat-reply";
    div.dataset.role = "assistant-pending";
    div.textContent = "Thinking...";
    body.appendChild(div);
    scrollChatToBottom();
    return div;
  }

  const GREETING_OR_SMALL_CHAT_REPLY =
    "Hello there! Tell me how I can help with barangay services—for example office hours, what you can request, fees, how to track or cancel a request, or viewing your Request History.";

  function appendAssistantAnswer(text) {
    const body = qs("chatBody");
    const el = doc.createElement("div");
    el.className = "msg msg-ai faq-chat-reply";
    const main = doc.createElement("div");
    main.className = "faq-chat-reply";
    main.innerHTML = linkifyResidentNavPhrases(text);
    el.appendChild(main);
    body.appendChild(el);
    scrollChatToBottom();
  }

  function looksLikeGreetingOnly(text) {
    const t = String(text || "").trim();
    const lower = t.toLowerCase();
    if (!lower || lower.length > 44) return false;
    // Avoid grabbing real FAQ questions that mention portal names
    if (/\b(track|cancel|delete|hours|office|fee|payment|peso|pesos|\$|php|history|dashboard|appointment|bulletin)\b/i.test(t)) {
      return false;
    }
    const patterns = [
      /^(hello|hi+|hey+|yo+|sup+)\s*[!.,?]*$/,
      /^(hello|hey|hi)(,\s*| )?(there|everyone)(\s|[!.])*$/i,
      /^(good\s+(morning|afternoon|evening|day|night))(\s|!|,|\.)*$/i,
      /^(kamusta|kumusta|musta)\s*[!.?,]*$/,
      /^(thanks|thank\s+you+|ty+)\s*[!.]*$/i,
      /^salamat(\s*[a-z]*)?\s*[!.?,]*$/,
      /^ok(ay|ies)?(\s+[a-z]*)?\s*[!.]*$/i
    ];
    return patterns.some((re) => re.test(lower.trim()));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function hrefForKnownNavPhrase(lower) {
    if (lower === "recent service requests" || lower === "recent service request") {
      return "request-history.html";
    }
    if (lower === "request history") {
      return "request-history.html";
    }
    if (lower === "service requests") {
      return "service-requests.html";
    }
    return "";
  }

  /**
   * Turns known UI phrases into in-app links (same folder as resident/*.html).
   * Regex order favors "Recent Service Requests" before "Service Requests".
   */
  function linkifyResidentNavPhrases(plainText) {
    const normalized = String(plainText || "").replace(/\u201c|\u201d/g, '"');
    const re = /\b(Recent Service Requests|Recent Service Request|Request History|Service Requests)\b/gi;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(normalized)) !== null) {
      const full = m[0];
      const href = hrefForKnownNavPhrase(full.toLowerCase());
      out += escapeHtml(normalized.slice(last, m.index));
      if (href) {
        out += `<a href="${href}" class="faq-chat-inline-link">${escapeHtml(full)}</a>`;
      } else {
        out += escapeHtml(full);
      }
      last = re.lastIndex;
    }
    out += escapeHtml(normalized.slice(last));
    return out;
  }

  function finalizeAssistant(el, text) {
    el.removeAttribute("data-role");
    el.classList.remove("faq-chat-err");
    el.innerHTML = "";
    const main = doc.createElement("div");
    main.className = "faq-chat-reply";
    main.innerHTML = linkifyResidentNavPhrases(text || "");
    el.appendChild(main);
    scrollChatToBottom();
  }

  function showAssistantError(el, message) {
    el.removeAttribute("data-role");
    el.classList.add("faq-chat-err");
    el.textContent =
      message ||
      "Couldn't reach the server. Make sure the backend API is running and try again.";
    scrollChatToBottom();
  }

  async function sendMessage() {
    const input = qs("chatInput");
    const sendBtn = getSendButton();
    if (!input) return;
    const text = String(input.value || "").trim();
    if (!text) return;

    appendUserMessage(text);
    input.value = "";

    if (looksLikeGreetingOnly(text)) {
      appendAssistantAnswer(GREETING_OR_SMALL_CHAT_REPLY);
      scrollChatToBottom();
      return;
    }

    const pending = appendAssistantShell();

    input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;

    try {
      const res = await fetch(`${apiBase}/faq/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, limit: 3 })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.message || `HTTP ${res.status}`);
      }
      if (!payload.ok) {
        throw new Error(payload.message || "Invalid response.");
      }
      const replyText = String(payload.reply || "").trim();
      if (!replyText) {
        throw new Error("Empty reply from server.");
      }
      finalizeAssistant(pending, replyText);
    } catch (err) {
      let msg = err?.message ? String(err.message) : "";
      if (msg === "Empty reply from server.") msg = "The server returned an empty reply.";
      else if (msg === "Invalid response.") msg = "The server returned an invalid response.";
      else if (/^HTTP \d/.test(msg)) msg = "Could not connect properly to the server. Please try again.";
      showAssistantError(pending, msg);
    } finally {
      input.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      scrollChatToBottom();
    }
  }

  injectStylesOnce();

  global.toggleChat = toggleChat;
  global.sendMessage = sendMessage;

  function attachInputHandlers() {
    const input = qs("chatInput");
    if (!input || input.dataset.faqChatBound === "1") return;
    input.dataset.faqChatBound = "1";
    input.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      sendMessage();
    });
    global.document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      const win = qs("chatWindow");
      if (!win || win.style.display !== "flex") return;
      win.style.display = "none";
    });
  }

  function boot() {
    seedWelcome();
    attachInputHandlers();
  }

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(typeof window !== "undefined" ? window : globalThis);
