(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const stopBtn = document.getElementById("stop");
  const terminalBtn = document.getElementById("terminal-btn");
  const modeChatBtn = document.getElementById("mode-chat");
  const modeAgentBtn = document.getElementById("mode-agent");
  const modelBadge = document.getElementById("model-badge");
  const usageText = document.getElementById("usage-text");
  const usageReset = document.getElementById("usage-reset");

  /* ---------------- рендер сообщений с простой markdown-подсветкой ---------------- */

  function renderInto(container, text) {
    container.innerHTML = "";
    const parts = String(text).split(/```(\w*)\n?([\s\S]*?)```/g);
    for (let i = 0; i < parts.length; i++) {
      const mod = i % 3;
      if (mod === 0) {
        if (parts[i]) {
          const span = document.createElement("span");
          span.className = "text-part";
          span.textContent = parts[i];
          container.appendChild(span);
        }
      } else if (mod === 2) {
        const lang = parts[i - 1] || "";
        const pre = document.createElement("pre");
        const codeEl = document.createElement("code");
        codeEl.textContent = parts[i];
        if (lang) codeEl.setAttribute("data-lang", lang);
        pre.appendChild(codeEl);
        container.appendChild(pre);
      }
    }
  }

  function addMessage(text, cls) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + cls;
    const body = document.createElement("div");
    body.className = "msg-body";
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return { wrap, body, raw: "" };
  }

  function updateMessage(msgObj, deltaText) {
    msgObj.raw += deltaText;
    renderInto(msgObj.body, msgObj.raw);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  let typingEl = null;
  let streamMsg = null;
  let thoughtEl = null;
  let thoughtBody = null;

  function resetThought() {
    thoughtEl = null;
    thoughtBody = null;
  }

  /* ---------------- переключатель режима Chat / Agent ---------------- */

  function setModeUI(isAgent) {
    modeChatBtn.classList.toggle("active", !isAgent);
    modeAgentBtn.classList.toggle("active", isAgent);
  }

  modeChatBtn.addEventListener("click", () => {
    setModeUI(false);
    vscode.postMessage({ type: "setAgentMode", value: false });
  });
  modeAgentBtn.addEventListener("click", () => {
    setModeUI(true);
    vscode.postMessage({ type: "setAgentMode", value: true });
  });

  modelBadge.addEventListener("click", () => {
    vscode.postMessage({ type: "selectModel" });
  });

  terminalBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "openTerminal" });
  });

  usageReset.addEventListener("click", () => {
    vscode.postMessage({ type: "resetUsage" });
  });

  /* ---------------- usage ---------------- */

  function fmtNum(n) {
    return new Intl.NumberFormat("ru-RU").format(Math.round(n));
  }
  function fmtCost(c) {
    return "$" + c.toFixed(4);
  }
  function renderUsage(data) {
    const t = data.total || { inputTokens: 0, outputTokens: 0, estimated: false };
    let text = `${fmtNum(t.inputTokens)} вход / ${fmtNum(t.outputTokens)} выход`;
    if (t.estimated) text += " (оценка)";
    if (data.showCost && typeof data.totalCost === "number") {
      text += ` · ≈${fmtCost(data.totalCost)}`;
    }
    usageText.textContent = text;
    usageText.title = data.last
      ? `Последний запрос: ${fmtNum(data.last.inputTokens)}/${fmtNum(data.last.outputTokens)}`
      : "";
  }

  /* ---------------- ввод ---------------- */

  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  }
  inputEl.addEventListener("input", autoGrow);

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    stopBtn.hidden = false;
    vscode.postMessage({ type: "send", text });
    inputEl.value = "";
    autoGrow();
  }

  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  /* ---------------- сообщения от extension host ---------------- */

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "userMessage": {
        const m = addMessage("", "user");
        updateMessage(m, msg.text);
        break;
      }

      case "assistantTyping":
        typingEl = addMessage("ИИ-агент работает...", "typing").wrap;
        break;

      case "agentStep": {
        const div = document.createElement("div");
        div.className = "msg agent-step";
        div.textContent = msg.text;
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        break;
      }

      case "assistantStreamStart":
        streamMsg = null;
        resetThought();
        break;

      case "assistantReasoningChunk":
        if (!thoughtEl) {
          thoughtEl = document.createElement("details");
          thoughtEl.className = "thought";
          const summary = document.createElement("summary");
          summary.textContent = "🧠 Thought";
          thoughtBody = document.createElement("div");
          thoughtBody.className = "thought-body";
          thoughtEl.appendChild(summary);
          thoughtEl.appendChild(thoughtBody);
          messagesEl.appendChild(thoughtEl);
        }
        thoughtBody.textContent += msg.text;
        messagesEl.scrollTop = messagesEl.scrollHeight;
        break;

      case "assistantStreamChunk":
        if (!streamMsg) streamMsg = addMessage("", "assistant");
        updateMessage(streamMsg, msg.text);
        break;

      case "assistantStreamEnd":
        // Если контент не приходил кусками (модель отдала весь ответ через
        // "рассуждения"), подставляем финальный текст как обычный ответ.
        if (!streamMsg && msg.text) {
          streamMsg = addMessage("", "assistant");
          updateMessage(streamMsg, msg.text);
        }
        streamMsg = null;
        break;

      case "assistantMessage": {
        sendBtn.disabled = false;
        stopBtn.hidden = true;
        if (typingEl) { typingEl.remove(); typingEl = null; }
        const m = addMessage("", "assistant");
        updateMessage(m, msg.text);
        break;
      }

      case "requestFinished":
      case "stopped":
        sendBtn.disabled = false;
        stopBtn.hidden = true;
        break;

      case "assistantError":
        if (typingEl) { typingEl.remove(); typingEl = null; }
        streamMsg = null;
        resetThought();
        {
          const div = document.createElement("div");
          div.className = "msg error";
          div.textContent = "Ошибка: " + msg.text;
          messagesEl.appendChild(div);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        break;

      case "prefill":
        inputEl.value = msg.text + inputEl.value;
        inputEl.focus();
        autoGrow();
        break;

      case "cleared":
        messagesEl.innerHTML = "";
        resetThought();
        streamMsg = null;
        break;

      case "initAgentMode":
        setModeUI(!!msg.value);
        break;

      case "modelInfo": {
        const label = msg.model || "не выбрана";
        modelBadge.textContent = `Модель: ${label}`;
        modelBadge.title = `Провайдер: ${msg.provider}. Нажмите, чтобы сменить модель.`;
        break;
      }

      case "usageUpdate":
        renderUsage(msg);
        break;
    }
  });
})();
