(function () {
  const isVsCodeHost = typeof acquireVsCodeApi === "function";
  const vscode = isVsCodeHost ? acquireVsCodeApi() : createWebRuntime();
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
    const msgObj = { wrap, body, raw: "" };
    if (text) updateMessage(msgObj, text);
    return msgObj;
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

  /* ---------------- сообщения от extension host / web runtime ---------------- */

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

  function createWebRuntime() {
    const storageKey = "lunacode.web";
    const state = loadState();
    let controller = null;

    setTimeout(() => {
      state.history.forEach((m) => emit({ type: m.role === "user" ? "userMessage" : "assistantMessage", text: m.content }));
      emit({ type: "initAgentMode", value: state.agentMode });
      emit({ type: "modelInfo", provider: state.provider, model: state.model });
      emitUsage();
      if (!state.apiKey) {
        emit({ type: "assistantMessage", text: "Добро пожаловать в LunaCode Web. Нажмите на бейдж модели сверху, укажите OpenAI-compatible endpoint и API-ключ, затем задайте вопрос. Интерфейс и логика чата общие с VS Code расширением." });
      }
    }, 0);

    return { postMessage };

    async function postMessage(msg) {
      if (msg.type === "setAgentMode") {
        state.agentMode = !!msg.value;
        saveState();
        return;
      }
      if (msg.type === "resetUsage") {
        state.usage = { inputTokens: 0, outputTokens: 0, estimated: false };
        saveState();
        emitUsage();
        return;
      }
      if (msg.type === "openTerminal") {
        emit({ type: "assistantMessage", text: "В веб-версии терминал VS Code недоступен. Для терминала используйте расширение LunaCode внутри VS Code." });
        return;
      }
      if (msg.type === "selectModel") {
        openSettingsPrompt();
        return;
      }
      if (msg.type === "stop") {
        controller?.abort();
        emit({ type: "stopped" });
        return;
      }
      if (msg.type === "send" && typeof msg.text === "string") {
        await sendToModel(msg.text);
      }
    }

    async function sendToModel(text) {
      state.history.push({ role: "user", content: text });
      trimHistory();
      saveState();
      emit({ type: "userMessage", text });

      if (state.agentMode) {
        emit({ type: "assistantMessage", text: "Agent-режим с доступом к файлам работает только в VS Code расширении. В LunaCode Web доступен безопасный чат без файловых инструментов." });
        emit({ type: "requestFinished" });
        return;
      }
      if (!state.apiKey || !state.baseUrl || !state.model) {
        emit({ type: "assistantError", text: "Не настроены baseUrl, model или API-ключ. Нажмите на бейдж модели сверху." });
        emit({ type: "requestFinished" });
        return;
      }

      controller?.abort();
      controller = new AbortController();
      emit({ type: "assistantStreamStart" });
      let reply = "";
      try {
        const response = await fetch(state.baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.apiKey}` },
          body: JSON.stringify({ model: state.model, messages: state.history.slice(-20), stream: true, temperature: state.temperature }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const data = line.trim().replace(/^data:\s*/, "");
            if (!data || data === "[DONE]") continue;
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content || "";
            if (delta) {
              reply += delta;
              emit({ type: "assistantStreamChunk", text: delta });
            }
            if (json.usage) accumulateUsage(json.usage.prompt_tokens || 0, json.usage.completion_tokens || 0, false);
          }
        }
        emit({ type: "assistantStreamEnd", text: reply });
        if (reply) state.history.push({ role: "assistant", content: reply });
        if (!state.usageUpdatedByProvider) accumulateUsage(estimateTokens(text), estimateTokens(reply), true);
        state.usageUpdatedByProvider = false;
        trimHistory();
        saveState();
      } catch (err) {
        emit({ type: "assistantError", text: err.name === "AbortError" ? "Операция отменена пользователем." : err.message });
      } finally {
        controller = null;
        emit({ type: "requestFinished" });
      }
    }

    function openSettingsPrompt() {
      const baseUrl = prompt("OpenAI-compatible chat completions URL", state.baseUrl || "https://api.openai.com/v1/chat/completions");
      if (baseUrl === null) return;
      const model = prompt("Model", state.model || "gpt-4o-mini");
      if (model === null) return;
      const apiKey = prompt("API key (хранится только в localStorage браузера)", state.apiKey || "");
      if (apiKey === null) return;
      state.provider = "web-openai-compatible";
      state.baseUrl = baseUrl.trim();
      state.model = model.trim();
      state.apiKey = apiKey.trim();
      saveState();
      emit({ type: "modelInfo", provider: state.provider, model: state.model });
    }

    function accumulateUsage(inputTokens, outputTokens, estimated) {
      state.usage.inputTokens += inputTokens;
      state.usage.outputTokens += outputTokens;
      state.usage.estimated = state.usage.estimated || estimated;
      state.usageUpdatedByProvider = !estimated;
      saveState();
      emitUsage({ inputTokens, outputTokens, estimated });
    }
    function emitUsage(last) { emit({ type: "usageUpdate", total: state.usage, last, showCost: false }); }
    function emit(data) { window.dispatchEvent(new MessageEvent("message", { data })); }
    function estimateTokens(text) { return Math.ceil(String(text || "").length / 4); }
    function trimHistory() { state.history = state.history.slice(-60); }
    function loadState() {
      return { provider: "web-openai-compatible", model: "", baseUrl: "", apiKey: "", temperature: 0.4, agentMode: false, history: [], usage: { inputTokens: 0, outputTokens: 0, estimated: false }, ...JSON.parse(localStorage.getItem(storageKey) || "{}") };
    }
    function saveState() { localStorage.setItem(storageKey, JSON.stringify(state)); }
  }
})();
