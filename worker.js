const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const MAX_BODY_SIZE = 20000;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 1200;

const systemMessage = {
  role: "system",
  content: "Ты Филлип — дружелюбный ботанический помощник сайта Flora-Anotomy. " +
    "Всегда отвечай естественным, грамотным русским языком. Не вставляй английские слова и фразы; " +
    "латиницей можно писать только научные названия растений. Перед отправкой проверь, что весь ответ " +
    "на русском и в нём нет английских слов. По умолчанию отвечай компактно: 2–4 коротких предложения, без длинного " +
    "вступления и повторов; подробности добавляй, только если пользователь попросил. " +
    "Не используй Markdown, звёздочки, жирный текст или заголовки. " +
    "При необходимости используй короткие списки обычными строками. Помогай с выбором растений и уходом: " +
    "поливом, освещением, влажностью, грунтом и типичными проблемами. Для полива учитывай вид и условия " +
    "дома; объясняй, как проверить влажность грунта, а не обещай точное расписание. Никогда не назначай " +
    "полив по фиксированному числу дней: частота зависит от условий, а календарный график может навредить. " +
    "Для фикуса Бенджамина (Ficus benjamina) рекомендуй яркий рассеянный свет: он переносит лёгкую полутень, " +
    "но не любит глубокую тень. Не называй его тенелюбивым. Для монстеры советуй проверять верхние 2–3 см " +
    "грунта и поливать, когда они подсохли; не рекомендуй " +
    "пересушивать весь корневой ком. Например: «Проверьте грунт пальцем: если верхние 2–3 см подсохли, " +
    "полейте монстеру и слейте лишнюю воду из поддона. Не ориентируйтесь на график по дням — скорость " +
    "высыхания зависит от света, температуры, сезона и размера горшка». Не выдавай догадки " +
    "за точный диагноз; если данных мало, задай один уточняющий вопрос. Не утверждай, что растение " +
    "безопасно для детей или животных, если вид точно не определён; при возможном отравлении посоветуй " +
    "обратиться к врачу, ветеринару или в токсикологическую службу. Ты не заменяешь профильного специалиста. " +
    "Не выводи служебные метки вроде «User Safety: safe» или другие внутренние оценки; отвечай непосредственно на вопрос.",
};

function cleanAssistantReply(reply) {
  return reply.split(/\r?\n/)
    .filter((line) => line.trim().toLowerCase().replace(/\.+$/, "") !== "user safety: safe")
    .join("\n")
    .trim();
}

function containsUnexpectedLatinWords(reply) {
  const withoutScientificNames = reply.replace(
    /\b[A-Z][a-z]+(?:[-'][A-Za-z]+)?\s+[a-z][a-z-]+\b/g,
    "",
  );
  return /\b[A-Za-z]{2,}\b/.test(withoutScientificNames);
}

function isAllowedOrigin(origin, configuredOrigin) {
  if (!origin) return true;
  if (origin === configuredOrigin) return Boolean(configuredOrigin);
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function jsonResponse(payload, status, origin, configuredOrigin) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  if (origin && isAllowedOrigin(origin, configuredOrigin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const configuredOrigin = env.SITE_ORIGIN || "";

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin, configuredOrigin)) {
        return jsonResponse({ error: "Запрос с этого сайта не разрешён." }, 403, origin, configuredOrigin);
      }
      const response = new Response(null, { status: 204 });
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.headers.set("Access-Control-Allow-Headers", "Content-Type");
      response.headers.set("Access-Control-Max-Age", "86400");
      response.headers.set("Vary", "Origin");
      return response;
    }

    if (!isAllowedOrigin(origin, configuredOrigin)) {
      return jsonResponse({ error: "Запрос с этого сайта не разрешён." }, 403, origin, configuredOrigin);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return jsonResponse({
        configured: Boolean(env.AI),
        provider: "cloudflare",
        model: MODEL,
      }, 200, origin, configuredOrigin);
    }
    if (url.pathname !== "/api/chat" || request.method !== "POST") {
      return jsonResponse({ error: "Такого API-маршрута нет." }, 404, origin, configuredOrigin);
    }
    if (!env.AI) {
      return jsonResponse({ error: "Cloudflare Workers AI не подключён к Worker." }, 503, origin, configuredOrigin);
    }
    if (!env.CHAT_RATE_LIMITER) {
      return jsonResponse({ error: "Защита от частых запросов ещё не настроена на сервере." }, 503, origin, configuredOrigin);
    }
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (!clientIp) {
      return jsonResponse({ error: "Не удалось проверить источник запроса." }, 400, origin, configuredOrigin);
    }
    const rateLimit = await env.CHAT_RATE_LIMITER.limit({ key: clientIp });
    if (!rateLimit.success) {
      return jsonResponse({ error: "Слишком много сообщений подряд. Подождите минуту и попробуйте снова." }, 429, origin, configuredOrigin);
    }
    const declaredLength = Number(request.headers.get("Content-Length") || 0);
    if (declaredLength > MAX_BODY_SIZE) {
      return jsonResponse({ error: "Сообщение слишком большое." }, 413, origin, configuredOrigin);
    }

    let payload;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_BODY_SIZE) {
        return jsonResponse({ error: "Сообщение слишком большое." }, 413, origin, configuredOrigin);
      }
      payload = JSON.parse(body);
    } catch {
      return jsonResponse({ error: "Не удалось прочитать сообщение." }, 400, origin, configuredOrigin);
    }
    const messages = payload?.messages;
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) {
      return jsonResponse({ error: "Отправьте до 12 сообщений в одном диалоге." }, 400, origin, configuredOrigin);
    }
    const cleanMessages = [];
    for (const message of messages) {
      if (!message || !["user", "assistant"].includes(message.role) ||
          typeof message.content !== "string" || !message.content.trim() ||
          message.content.length > MAX_MESSAGE_LENGTH) {
        return jsonResponse({ error: "Проверьте текст сообщения и попробуйте снова." }, 400, origin, configuredOrigin);
      }
      cleanMessages.push({ role: message.role, content: message.content.trim() });
    }
    if (cleanMessages.at(-1)?.role !== "user") {
      return jsonResponse({ error: "Последним сообщением должен быть вопрос пользователя." }, 400, origin, configuredOrigin);
    }

    try {
      const options = {
        messages: [systemMessage, ...cleanMessages],
        max_tokens: 350,
        temperature: 0.1,
      };
      let result = await env.AI.run(MODEL, options);
      let reply = typeof result?.response === "string" ? cleanAssistantReply(result.response) : result?.response;
      if (typeof reply === "string" && containsUnexpectedLatinWords(reply)) {
        result = await env.AI.run(MODEL, {
          ...options,
          messages: [
            systemMessage,
            {
              role: "system",
              content: "Предыдущий ответ был отклонён: в нём были английские слова. Ответь заново исключительно естественным русским языком. Латиницей разрешено написать только научное название растения.",
            },
            ...cleanMessages,
          ],
        });
        reply = typeof result?.response === "string" ? cleanAssistantReply(result.response) : result?.response;
      }
      if (typeof reply !== "string" || !reply.trim()) {
        console.error("Cloudflare Workers AI returned an empty or unexpected response");
        return jsonResponse({ error: "Облачная модель вернула неожиданный ответ. Попробуйте ещё раз." }, 502, origin, configuredOrigin);
      }
      if (containsUnexpectedLatinWords(reply)) {
        return jsonResponse({ error: "Модель пока не может ответить без смешения языков. Попробуйте задать вопрос иначе." }, 502, origin, configuredOrigin);
      }
      return jsonResponse({ reply }, 200, origin, configuredOrigin);
    } catch (error) {
      console.error("Cloudflare Workers AI request failed:", error.name);
      return jsonResponse({ error: "Облачный ИИ временно не ответил. Возможно, исчерпана дневная бесплатная квота. Попробуйте позже." }, 502, origin, configuredOrigin);
    }
  },
};
