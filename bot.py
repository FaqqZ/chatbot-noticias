"""Procesa comandos entrantes del bot de Telegram.

No hay un servidor corriendo 24/7: esto se ejecuta por polling desde un
workflow de GitHub Actions cada pocos minutos (ver
.github/workflows/bot-interact.yml). Cada corrida pregunta a Telegram si
hay mensajes nuevos desde el último `offset` procesado (persistido en
bot_offset.json) y responde a los que reconoce como comandos.
"""

from __future__ import annotations

import json
import os
import unicodedata
from pathlib import Path

import requests

from filters import load_exclude_keywords, load_keywords
from main import main as send_daily_report
from sources import load_sources

OFFSET_PATH = Path("bot_offset.json")
KEYWORDS_PATH = Path("keywords.yaml")

HELP_TEXT = (
    "Comandos disponibles:\n"
    "/informe — mandar el informe de noticias relevantes ahora\n"
    "/keywords — ver palabras clave, exclusiones y medios activos\n"
    "/agregar <palabra> — sumar una palabra clave a rastrear\n"
    "/quitar <palabra> — sacar una palabra clave\n"
    "/ayuda — ver esta ayuda"
)


def _load_offset() -> int:
    if OFFSET_PATH.exists():
        return json.loads(OFFSET_PATH.read_text(encoding="utf-8")).get("offset", 0)
    return 0


def _save_offset(offset: int) -> None:
    OFFSET_PATH.write_text(json.dumps({"offset": offset}), encoding="utf-8")


def _get_updates(token: str, offset: int) -> list[dict]:
    url = f"https://api.telegram.org/bot{token}/getUpdates"
    response = requests.get(url, params={"offset": offset}, timeout=15)
    response.raise_for_status()
    return response.json()["result"]


def _reply(token: str, chat_id: str, text: str, html: bool = False) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = {"chat_id": chat_id, "text": text}
    if html:
        data["parse_mode"] = "HTML"
    response = requests.post(url, data=data, timeout=15)
    response.raise_for_status()


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    return "".join(c for c in text if not unicodedata.combining(c)).lower().strip()


def _keyword_section_bounds(lines: list[str]) -> tuple[int, int] | None:
    """Devuelve (start, end) de la lista bajo "keywords:" en keywords.yaml."""
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == "keywords:")
    except StopIteration:
        return None
    end = start + 1
    while end < len(lines) and lines[end].startswith("  - "):
        end += 1
    return start, end


def add_keyword(word: str) -> str:
    lines = KEYWORDS_PATH.read_text(encoding="utf-8").splitlines()
    bounds = _keyword_section_bounds(lines)
    if bounds is None:
        return "No pude encontrar la sección 'keywords:' en keywords.yaml."
    start, end = bounds
    current = [line[4:].strip() for line in lines[start + 1 : end]]
    if any(_normalize(k) == _normalize(word) for k in current):
        return f'"{word}" ya está en la lista de palabras clave.'
    lines.insert(end, f"  - {word}")
    KEYWORDS_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return f'Agregada la palabra clave "{word}".'


def remove_keyword(word: str) -> str:
    lines = KEYWORDS_PATH.read_text(encoding="utf-8").splitlines()
    bounds = _keyword_section_bounds(lines)
    if bounds is None:
        return "No pude encontrar la sección 'keywords:' en keywords.yaml."
    start, end = bounds
    for i in range(start + 1, end):
        if _normalize(lines[i][4:].strip()) == _normalize(word):
            del lines[i]
            KEYWORDS_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
            return f'Saqué la palabra clave "{word}".'
    return f'No encontré "{word}" en la lista de palabras clave.'


def describe_config() -> str:
    keywords = load_keywords()
    exclude = load_exclude_keywords()
    sources = load_sources()
    lines = ["<b>Palabras clave:</b>"]
    lines += [f"• {k}" for k in keywords]
    lines.append("")
    lines.append("<b>Exclusiones (descartan aunque matcheen):</b>")
    lines += [f"• {k}" for k in exclude]
    lines.append("")
    lines.append("<b>Medios monitoreados:</b>")
    lines += [f"• {s['name']}" for s in sources]
    return "\n".join(lines)


def handle_command(text: str, token: str, chat_id: str) -> None:
    parts = text.strip().split(maxsplit=1)
    command = parts[0].lower().split("@")[0]  # soporta "/informe@nombre_del_bot"
    arg = parts[1].strip() if len(parts) > 1 else ""

    if command in ("/start", "/ayuda", "/help"):
        _reply(token, chat_id, HELP_TEXT)
    elif command == "/informe":
        send_daily_report()
    elif command == "/keywords":
        _reply(token, chat_id, describe_config(), html=True)
    elif command == "/agregar":
        _reply(token, chat_id, add_keyword(arg) if arg else "Uso: /agregar <palabra clave>")
    elif command == "/quitar":
        _reply(token, chat_id, remove_keyword(arg) if arg else "Uso: /quitar <palabra clave>")
    else:
        _reply(token, chat_id, f"No reconozco ese comando.\n\n{HELP_TEXT}")


def main() -> None:
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    authorized_chat_id = str(os.environ["TELEGRAM_CHAT_ID"])

    offset = _load_offset()
    updates = _get_updates(token, offset)
    print(f"offset inicial={offset} updates recibidos={len(updates)}")

    for update in updates:
        offset = update["update_id"] + 1
        message = update.get("message")
        if not message or "text" not in message:
            print(f"update {update['update_id']}: sin mensaje de texto, se ignora")
            continue
        chat_id = str(message["chat"]["id"])
        text = message["text"]
        print(f"update {update['update_id']}: chat_id={chat_id} texto={text!r}")
        if chat_id != authorized_chat_id:
            print(f"  -> ignorado: chat_id no autorizado (esperado {authorized_chat_id})")
            continue
        if text.startswith("/"):
            print(f"  -> procesando comando")
            try:
                handle_command(text, token, chat_id)
                print(f"  -> comando procesado OK")
            except Exception as exc:
                print(f"  -> ERROR procesando comando: {exc!r}")
                raise
        else:
            print(f"  -> no es un comando (no empieza con '/'), se ignora")

    _save_offset(offset)
    print(f"offset final={offset}")


if __name__ == "__main__":
    main()
