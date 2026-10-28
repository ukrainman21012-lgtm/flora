(() => {
  const toggle = document.querySelector("#flora-ai-toggle");
  const panel = document.querySelector("#flora-ai-panel");
  const closeButton = document.querySelector("#flora-ai-close");
  const form = document.querySelector("#flora-ai-form");
  const input = document.querySelector("#flora-ai-input");
  const sendButton = document.querySelector("#flora-ai-send");
  const messagesElement = document.querySelector("#flora-ai-messages");
  const suggestions = document.querySelector("#flora-ai-suggestions");
  const presence = document.querySelector("#flora-ai-presence");
  if (!toggle || !panel || !closeButton || !form || !input || !sendButton || !messagesElement || !suggestions || !presence) {
    throw new Error("Не удалось инициализировать чат ботанического помощника.");
  }

  const nicknameStorageKey = "flora-nickname";
  const apiBase = String(window.FLORA_AI_ENDPOINT || "").replace(/\/+$/, "");
  const apiUrl = (path) => `${apiBase}/api/${path}`;
  const historyLimit = 12;
  const messageLimit = 1200;
  const conversation = [];
  let busy = false;
  let activeNickname = readNickname();
  let activeProfileKey = normalizeNickname(activeNickname);
  let activeRequestController = null;
  let activeProvider = null;

  function normalizeNickname(nickname) {
    return nickname.normalize("NFKC").trim().toLocaleLowerCase("ru-RU") || "гость";
  }

  function readNickname(value = null) {
    if (value !== null) return value.trim() || "Гость";
    try {
      return localStorage.getItem(nicknameStorageKey)?.trim() || "Гость";
    } catch (error) {
      console.warn("Не удалось прочитать ник для истории чата.", error);
      return "Гость";
    }
  }

  const getHistoryKey = () => `flora-ai-chat-history:${encodeURIComponent(activeProfileKey)}`;

  const setPresence = (state, text) => {
    presence.dataset.state = state;
    presence.lastChild.textContent = ` ${text}`;
  };

  const cleanAssistantText = (text) => text
    .replace(/^\s*user\s+safety\s*:\s*safe\s*\.?\s*$/gim, "")
    .replace(/\*\*(.*?)\*\*/gs, "$1")
    .replace(/\*\*/g, "")
    .trim();

  const appendMessage = (role, text) => {
    if (role === "assistant") text = cleanAssistantText(text);
    const article = document.createElement("article");
    article.className = `flora-ai-message flora-ai-message-${role}`;
    if (role === "assistant") {
      const avatar = document.createElement("span");
      avatar.className = "flora-ai-avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.innerHTML = '<svg class="ui-icon"><use href="#icon-leaf"></use></svg>';
      article.append(avatar);
    }
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    article.append(paragraph);
    messagesElement.append(article);
    messagesElement.scrollTop = messagesElement.scrollHeight;
    return article;
  };

  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Закрыть ботанического помощника" : "Открыть ботанического помощника");
    if (open) {
      input.focus();
      void checkConnection();
    } else {
      toggle.focus();
    }
  };

  const checkConnection = async () => {
    try {
      const response = await fetch(apiUrl("health"), { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      activeProvider = result.provider || "remote";
      const status = result.provider === "ollama"
        ? !result.available
          ? "Запусти Ollama"
          : result.configured
            ? "Филлип работает локально"
            : `Скачай ${result.model || "локальную модель"}`
        : result.configured
          ? "Филлип готов помочь"
          : "ИИ не настроен на сервере";
      setPresence(result.configured ? "ready" : "offline", status);
    } catch {
      activeProvider = null;
      setPresence("offline", "ИИ-сервер недоступен");
    }
  };

  const saveConversation = () => {
    try {
      localStorage.setItem(getHistoryKey(), JSON.stringify(conversation.slice(-historyLimit)));
    } catch (error) {
      console.warn(`Не удалось сохранить историю чата для ника «${activeNickname}».`, error);
    }
  };

  const setBusy = (value) => {
    busy = value;
    sendButton.disabled = value;
    input.disabled = value;
    form.setAttribute("aria-busy", String(value));
  };

  const renderProfileConversation = () => {
    conversation.length = 0;
    messagesElement.replaceChildren();
    appendMessage("assistant", `Привет, ${activeNickname}! Я Филлип. Что хотите узнать о растениях?`);
    suggestions.hidden = false;
    try {
      const stored = JSON.parse(localStorage.getItem(getHistoryKey()) || "[]");
      if (!Array.isArray(stored)) throw new TypeError("Ожидался список сообщений.");
      stored.slice(-historyLimit).forEach((message) => {
        if (!message || !["assistant", "user"].includes(message.role) || typeof message.content !== "string") return;
        const content = (message.role === "assistant" ? cleanAssistantText(message.content) : message.content.trim()).slice(0, messageLimit);
        if (!content) return;
        conversation.push({ role: message.role, content });
        appendMessage(message.role, content);
      });
      if (conversation.length) suggestions.hidden = true;
    } catch (error) {
      console.warn(`Не удалось восстановить историю чата для ника «${activeNickname}».`, error);
    }
  };

  const switchNickname = (nickname) => {
    const nextNickname = readNickname(nickname);
    const nextProfileKey = normalizeNickname(nextNickname);
    if (nextProfileKey === activeProfileKey) {
      activeNickname = nextNickname;
      return;
    }
    activeRequestController?.abort();
    activeRequestController = null;
    activeNickname = nextNickname;
    activeProfileKey = nextProfileKey;
    setBusy(false);
    renderProfileConversation();
  };

  const sendMessage = async (value) => {
    const content = value.trim().slice(0, messageLimit);
    if (!content || busy) return;

    const requestProfileKey = activeProfileKey;
    conversation.push({ role: "user", content });
    appendMessage("user", content);
    suggestions.hidden = true;
    input.value = "";
    input.style.height = "";
    saveConversation();
    setBusy(true);

    const typing = document.createElement("article");
    typing.className = "flora-ai-message flora-ai-message-assistant flora-ai-typing";
    typing.setAttribute("aria-label", "Филлип печатает");
    typing.innerHTML = '<span class="flora-ai-avatar" aria-hidden="true"><svg class="ui-icon"><use href="#icon-leaf"></use></svg></span><p><i></i><i></i><i></i></p>';
    messagesElement.append(typing);
    messagesElement.scrollTop = messagesElement.scrollHeight;

    const controller = new AbortController();
    activeRequestController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 300000);
    try {
      const response = await fetch(apiUrl("chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          plantContext: typeof window.floraGetPlantContext === "function"
            ? window.floraGetPlantContext(content)
            : [],
          messages: conversation.slice(-historyLimit).map((message) => ({
            role: message.role,
            content: message.content.slice(0, messageLimit)
          }))
        }),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (requestProfileKey !== activeProfileKey) return;
      if (!response.ok) {
        const error = new Error(typeof result.error === "string" ? result.error : "Не удалось получить ответ. Попробуйте ещё раз.");
        error.status = response.status;
        throw error;
      }
      if (typeof result.reply !== "string" || !result.reply.trim()) throw new Error("Помощник вернул пустой ответ. Попробуйте задать вопрос иначе.");
      const reply = cleanAssistantText(result.reply);
      if (!reply) throw new Error("Помощник вернул пустой ответ. Попробуйте задать вопрос иначе.");
      conversation.push({ role: "assistant", content: reply.slice(0, 5000) });
      appendMessage("assistant", reply);
      saveConversation();
      setPresence("ready", activeProvider === "ollama" ? "Филлип работает локально" : "Филлип готов помочь");
    } catch (error) {
      if (requestProfileKey !== activeProfileKey) return;
      const message = error.name === "AbortError"
        ? activeProvider === "ollama"
          ? "Локальная модель отвечает дольше обычного. Попробуйте ещё раз."
          : "Облачная модель отвечает дольше обычного. Попробуйте ещё раз."
        : error instanceof TypeError
          ? activeProvider === "ollama"
            ? "Не удалось связаться с сервером. Запустите локальный сервер проекта."
            : "Не удалось связаться с облачным ИИ-сервером."
          : error.message;
      appendMessage("assistant", message);
      if (error.status === 503 || error instanceof TypeError || error.name === "AbortError") {
        const status = error.status === 503
          ? activeProvider === "ollama" ? "Проверь Ollama и модель" : "ИИ временно недоступен"
          : "Проверьте связь";
        setPresence("offline", status);
      }
    } finally {
      window.clearTimeout(timeout);
      typing.remove();
      if (requestProfileKey === activeProfileKey) {
        if (activeRequestController === controller) activeRequestController = null;
        setBusy(false);
        if (!panel.hidden) input.focus();
      }
    }
  };

  window.addEventListener("flora:nickname-change", (event) => {
    switchNickname(event.detail?.nickname);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === nicknameStorageKey) switchNickname(event.newValue || "");
  });

  toggle.addEventListener("click", () => setOpen(panel.hidden));
  closeButton.addEventListener("click", () => setOpen(false));
  panel.querySelector("#flora-ai-clear").addEventListener("click", () => {
    conversation.length = 0;
    messagesElement.replaceChildren();
    appendMessage("assistant", `Привет, ${activeNickname}! Я Филлип. Что хотите узнать о растениях?`);
    suggestions.hidden = false;
    try {
      localStorage.removeItem(getHistoryKey());
    } catch (error) {
      console.warn(`Не удалось очистить историю чата для ника «${activeNickname}».`, error);
    }
    input.focus();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage(input.value);
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 105)}px`;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  suggestions.addEventListener("click", (event) => {
    const button = event.target.closest("button.flora-ai-suggestion");
    if (!button) return;
    void sendMessage(button.textContent);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) setOpen(false);
  });

  renderProfileConversation();
  void checkConnection();
})();
