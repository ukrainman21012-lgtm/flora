#!/usr/bin/env python3
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_MODEL = "qwen3.5:4b"
MAX_BODY_SIZE = 20_000
MAX_MESSAGES = 12
MAX_MESSAGE_LENGTH = 1_200
REQUESTS_PER_MINUTE = 12
rate_limit_lock = threading.Lock()
request_times = {}

def clean_assistant_reply(reply):
    lines = [
        line for line in reply.splitlines()
        if line.strip().lower().rstrip(".") != "user safety: safe"
    ]
    return "\n".join(lines).strip()


def ollama_url():
    return os.environ.get("OLLAMA_BASE_URL", DEFAULT_OLLAMA_URL).rstrip("/")


def ollama_model():
    return os.environ.get("OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL).strip() or DEFAULT_OLLAMA_MODEL


def get_installed_models():
    request = urllib.request.Request(
        f"{ollama_url()}/api/tags",
        headers={"Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        result = json.loads(response.read())
    models = result.get("models")
    if not isinstance(models, list):
        raise ValueError("Ollama вернул неожиданный список моделей.")
    return models


def load_local_env():
    env_file = ROOT / ".env"
    if not env_file.is_file():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key not in {"OLLAMA_BASE_URL", "OLLAMA_MODEL"} or key in os.environ:
            continue
        os.environ[key] = value.strip().strip("\"'")


def json_response(handler, status, payload):
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(encoded)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(encoded)


class FloraHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path == "/api/health":
            model = ollama_model()
            try:
                installed_models = get_installed_models()
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
                json_response(self, 200, {
                    "configured": False,
                    "available": False,
                    "provider": "ollama",
                    "model": model,
                })
                return
            model_installed = any(
                item.get("name") == model or item.get("model") == model
                for item in installed_models
                if isinstance(item, dict)
            )
            json_response(self, 200, {
                "configured": model_installed,
                "available": True,
                "provider": "ollama",
                "model": model,
            })
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/chat":
            json_response(self, 404, {"error": "Такого API-маршрута нет."})
            return

        model = ollama_model()
        try:
            installed_models = get_installed_models()
        except (urllib.error.URLError, TimeoutError):
            json_response(self, 503, {"error": "Локальный Ollama не запущен. Открой приложение Ollama и попробуй снова."})
            return
        except (json.JSONDecodeError, ValueError):
            json_response(self, 502, {"error": "Не удалось получить список моделей Ollama. Перезапусти Ollama и попробуй снова."})
            return
        model_installed = any(
            item.get("name") == model or item.get("model") == model
            for item in installed_models
            if isinstance(item, dict)
        )
        if not model_installed:
            json_response(self, 503, {"error": f"Локальная модель {model} ещё не установлена. Открой терминал и выполни: ollama pull {model}"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            json_response(self, 400, {"error": "Некорректный размер запроса."})
            return
        if content_length < 1 or content_length > MAX_BODY_SIZE:
            json_response(self, 413, {"error": "Сообщение слишком большое. Сократите переписку и попробуйте ещё раз."})
            return

        now = time.monotonic()
        client = self.client_address[0]
        with rate_limit_lock:
            recent = [timestamp for timestamp in request_times.get(client, []) if now - timestamp < 60]
            if len(recent) >= REQUESTS_PER_MINUTE:
                request_times[client] = recent
                json_response(self, 429, {"error": "Слишком много сообщений подряд. Подождите минуту и попробуйте снова."})
                return
            recent.append(now)
            request_times[client] = recent

        try:
            payload = json.loads(self.rfile.read(content_length))
            messages = payload.get("messages") if isinstance(payload, dict) else None
            if not isinstance(messages, list) or not messages or len(messages) > MAX_MESSAGES:
                raise ValueError("Отправьте до 12 сообщений в одном диалоге.")
            clean_messages = []
            for message in messages:
                if not isinstance(message, dict) or message.get("role") not in {"user", "assistant"}:
                    raise ValueError("Некорректный формат истории диалога.")
                content = message.get("content")
                if not isinstance(content, str) or not content.strip() or len(content) > MAX_MESSAGE_LENGTH:
                    raise ValueError("Каждое сообщение должно содержать от 1 до 1200 символов.")
                clean_messages.append({"role": message["role"], "content": content.strip()})
            if clean_messages[-1]["role"] != "user":
                raise ValueError("Последним сообщением должен быть вопрос пользователя.")
        except (json.JSONDecodeError, UnicodeDecodeError):
            json_response(self, 400, {"error": "Не удалось прочитать сообщение."})
            return
        except ValueError as error:
            json_response(self, 400, {"error": str(error)})
            return

        request_payload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Ты Филлип — дружелюбный ботанический помощник сайта Flora-Anotomy. "
                        "Отвечай по-русски, ясно и доброжелательно. По умолчанию отвечай компактно: "
                        "2–4 коротких предложения, без длинного вступления и повторов; подробности "
                        "добавляй, только если пользователь попросил. Не используй Markdown, "
                        "звёздочки, жирный текст или заголовки. "
                        "При необходимости используй короткие списки обычными строками. Помогай с выбором "
                        "растений и уходом: поливом, "
                        "освещением, влажностью, грунтом и типичными проблемами. Для полива учитывай "
                        "вид и условия дома; объясняй, как проверить влажность грунта, а не обещай "
                        "точное расписание. Для монстеры советуй проверять верхние 2–3 см грунта; "
                        "не рекомендуй пересушивать весь корневой ком. Не выдавай догадки за точный "
                        "диагноз; если данных мало, "
                        "задай один уточняющий вопрос. Не утверждай, что растение безопасно для детей "
                        "или животных, если вид точно не определён; при возможном отравлении посоветуй "
                        "обратиться к врачу, ветеринару или в токсикологическую службу. Ты не заменяешь "
                        "профильного специалиста. Не выводи служебные метки вроде «User Safety: safe» "
                        "или другие внутренние оценки; отвечай непосредственно на вопрос пользователя."
                    ),
                },
                *clean_messages,
            ],
            "stream": False,
            "think": False,
            "options": {
                "num_predict": 500,
                "temperature": 0.6,
            },
        }
        request = urllib.request.Request(
            f"{ollama_url()}/api/chat",
            data=json.dumps(request_payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                result = json.loads(response.read())
            reply = result["message"]["content"]
            if not isinstance(reply, str) or not reply.strip():
                raise ValueError("empty response")
            reply = clean_assistant_reply(reply)
            if not reply:
                raise ValueError("empty response")
            json_response(self, 200, {"reply": reply, "model": result.get("model", model)})
        except urllib.error.HTTPError as error:
            if error.code == 404:
                json_response(self, 503, {"error": f"Модель {model} не найдена в Ollama. Выполни в терминале: ollama pull {model}"})
            else:
                print(f"Ollama returned HTTP {error.code}")
                json_response(self, 502, {"error": "Локальная модель не смогла ответить. Проверь Ollama и попробуй ещё раз."})
        except (urllib.error.URLError, TimeoutError):
            json_response(self, 502, {"error": "Не удалось подключиться к локальной модели. Проверь Ollama и попробуй ещё раз."})
        except (KeyError, IndexError, TypeError, json.JSONDecodeError, ValueError):
            json_response(self, 502, {"error": "Ollama вернула неожиданный ответ. Попробуй ещё раз."})

    def log_message(self, format_string, *args):
        if self.path.startswith("/api/"):
            return
        super().log_message(format_string, *args)


if __name__ == "__main__":
    load_local_env()
    server = ThreadingHTTPServer(("127.0.0.1", 8000), FloraHandler)
    print("Flora-Anotomy local server: http://127.0.0.1:8000")
    print(f"Local model: {ollama_model()} ({ollama_url()})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping local server.")
    finally:
        server.server_close()
