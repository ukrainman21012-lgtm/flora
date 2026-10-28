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
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*|__(.*?)__/gs, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g, "$1$2")
    .trim();

  const isGoogleSearchUrl = (value) => {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "www.google.com" &&
        url.pathname === "/search" && Boolean(url.searchParams.get("q"));
    } catch {
      return false;
    }
  };

  const cleanSources = (value) => {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 3).flatMap((source) => {
      if (!source || typeof source.title !== "string" || typeof source.url !== "string") return [];
      try {
        const url = new URL(source.url);
        if (url.protocol !== "https:" || url.username || url.password) return [];
        return [{ title: source.title.trim().slice(0, 160), url: url.href }];
      } catch {
        return [];
      }
    }).filter((source) => source.title);
  };

  const separateLegacySources = (text) => {
    const marker = "\n\nИсточники:\n";
    const markerIndex = text.lastIndexOf(marker);
    if (markerIndex < 0) return { text, sources: [] };
    const sources = text.slice(markerIndex + marker.length).split(/\r?\n/).flatMap((line) => {
      const separator = line.lastIndexOf(": https://");
      if (separator < 1) return [];
      return [{ title: line.slice(0, separator), url: line.slice(separator + 2).trim() }];
    });
    const clean = cleanSources(sources);
    return clean.length ? { text: text.slice(0, markerIndex), sources: clean } : { text, sources: [] };
  };

  const renderAssistantText = (container, text) => {
    const lines = cleanAssistantText(text).split(/\r?\n/);
    let paragraphLines = [];
    let list = null;
    let listKind = "";
    const flushParagraph = () => {
      if (!paragraphLines.length) return;
      const paragraph = document.createElement("p");
      paragraph.textContent = paragraphLines.join(" ").trim();
      if (paragraph.textContent) container.append(paragraph);
      paragraphLines = [];
    };
    const flushList = () => {
      if (list) container.append(list);
      list = null;
      listKind = "";
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        flushParagraph();
        continue;
      }
      const bullet = line.match(/^(?:[-*•]\s+|(\d+)[.)]\s+)(.+)$/u);
      if (bullet) {
        flushParagraph();
        const nextKind = bullet[1] ? "ol" : "ul";
        if (listKind !== nextKind) {
          flushList();
          list = document.createElement(nextKind);
          listKind = nextKind;
        }
        const item = document.createElement("li");
        item.textContent = bullet[2];
        list.append(item);
        continue;
      }
      flushList();
      paragraphLines.push(line);
    }
    flushParagraph();
    flushList();
  };

  const appendMessage = (role, text, searchUrl = "", sources = []) => {
    if (role === "assistant") {
      const legacy = separateLegacySources(text);
      text = cleanAssistantText(legacy.text);
      const currentSources = cleanSources(sources);
      sources = currentSources.length ? currentSources : legacy.sources;
    }
    const article = document.createElement("article");
    article.className = `flora-ai-message flora-ai-message-${role}`;
    if (role === "assistant") {
      const avatar = document.createElement("span");
      avatar.className = "flora-ai-avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.innerHTML = '<svg class="ui-icon"><use href="#icon-leaf"></use></svg>';
      article.append(avatar);
      const content = document.createElement("div");
      content.className = "flora-ai-content";
      renderAssistantText(content, text);
      article.append(content);
    } else {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      article.append(paragraph);
    }
    if (role === "assistant" && sources.length) {
      const sourceLabel = document.createElement("span");
      sourceLabel.className = "flora-ai-source-label";
      sourceLabel.textContent = "Источники";
      article.querySelector(".flora-ai-content")?.append(sourceLabel);
      const sourceList = document.createElement("ul");
      sourceList.className = "flora-ai-sources";
      for (const source of sources) {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = source.title;
        item.append(link);
        sourceList.append(item);
      }
      article.querySelector(".flora-ai-content")?.append(sourceList);
    }
    if (role === "assistant" && isGoogleSearchUrl(searchUrl)) {
      const link = document.createElement("a");
      link.className = "flora-ai-google-search-link";
      link.href = searchUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Открыть поиск Google";
      article.querySelector(".flora-ai-content")?.append(link);
    }
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
        let content = (message.role === "assistant" ? cleanAssistantText(message.content) : message.content.trim()).slice(0, messageLimit);
        if (!content) return;
        const searchUrl = message.role === "assistant" && isGoogleSearchUrl(message.searchUrl) ? message.searchUrl : "";
        const legacy = message.role === "assistant" ? separateLegacySources(content) : { text: content, sources: [] };
        content = legacy.text;
        const savedSources = cleanSources(message.sources);
        const sources = savedSources.length ? savedSources : legacy.sources;
        conversation.push({
          role: message.role,
          content,
          ...(searchUrl ? { searchUrl } : {}),
          ...(sources.length ? { sources } : {}),
        });
        appendMessage(message.role, content, searchUrl, sources);
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
      const searchUrl = isGoogleSearchUrl(result.searchUrl) ? result.searchUrl : "";
      const sources = cleanSources(result.sources);
      conversation.push({
        role: "assistant",
        content: reply.slice(0, 5000),
        ...(searchUrl ? { searchUrl } : {}),
        ...(sources.length ? { sources } : {}),
      });
      appendMessage("assistant", reply, searchUrl, sources);
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
