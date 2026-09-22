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
    if len(text) <= MAX_MESSAGE_LENGTH:
        return [text]
    chunks = []
    while text:
        chunks.append(text[:MAX_MESSAGE_LENGTH])
        text = text[MAX_MESSAGE_LENGTH:]
    return chunks
