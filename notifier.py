"""Envío del informe por Telegram usando la Bot API."""

from __future__ import annotations

import os

import requests

TELEGRAM_API_URL = "https://api.telegram.org/bot{token}/sendMessage"
MAX_MESSAGE_LENGTH = 4000  # límite de Telegram es 4096, dejamos margen


def send_telegram_message(text: str) -> None:
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    chat_id = os.environ["TELEGRAM_CHAT_ID"]
    url = TELEGRAM_API_URL.format(token=token)

    for chunk in _split_message(text):
        response = requests.post(
            url,
            data={
                "chat_id": chat_id,
                "text": chunk,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
            timeout=15,
        )
        response.raise_for_status()


def _split_message(text: str) -> list[str]:
    """Parte el texto en chunks respetando límites de línea, para nunca
    cortar una etiqueta HTML (ej. <a href="...">...</a>) a la mitad."""
    if len(text) <= MAX_MESSAGE_LENGTH:
        return [text]

    chunks = []
    current_lines: list[str] = []
    current_len = 0
    for line in text.split("\n"):
        added_len = len(line) + 1  # +1 por el \n
        if current_lines and current_len + added_len > MAX_MESSAGE_LENGTH:
            chunks.append("\n".join(current_lines))
            current_lines = []
            current_len = 0
        current_lines.append(line)
        current_len += added_len
    if current_lines:
        chunks.append("\n".join(current_lines))
    return chunks
