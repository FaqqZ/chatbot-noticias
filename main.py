"""Orquesta el informe diario: trae noticias, filtra por keywords, envía y deduplica."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from html import escape

from filters import filter_articles, load_exclude_keywords, load_keywords
from notifier import send_telegram_message
from sources import Article, fetch_articles, load_sources

SEEN_URLS_PATH = Path("seen_urls.json")
MAX_SEEN_URLS = 2000  # evita que el archivo crezca indefinidamente


def load_seen_urls() -> set[str]:
    if not SEEN_URLS_PATH.exists():
        return set()
    return set(json.loads(SEEN_URLS_PATH.read_text(encoding="utf-8")))


def save_seen_urls(urls: set[str]) -> None:
    trimmed = list(urls)[-MAX_SEEN_URLS:]
    SEEN_URLS_PATH.write_text(json.dumps(trimmed, ensure_ascii=False, indent=2), encoding="utf-8")


def build_report(grouped: dict[str, list[Article]]) -> str:
    today = datetime.now().strftime("%d/%m/%Y")
    lines = [f"<b>Informe de noticias — San Miguel de Tucumán</b>", f"{today}", ""]
    for keyword, articles in grouped.items():
        lines.append(f"<b>#{escape(keyword)}</b>")
        for article in articles:
            lines.append(f'• <a href="{escape(article.link)}">{escape(article.title)}</a> ({escape(article.source)})')
        lines.append("")
    return "\n".join(lines).strip()


def main() -> None:
    sources = load_sources()
    keywords = load_keywords()
    exclude_keywords = load_exclude_keywords()
    articles = fetch_articles(sources)

    seen_urls = load_seen_urls()
    new_articles = [a for a in articles if a.link not in seen_urls]

    grouped = filter_articles(new_articles, keywords, exclude_keywords)
    total_matches = sum(len(v) for v in grouped.values())

    if total_matches == 0:
        send_telegram_message("Informe de noticias de San Miguel de Tucumán: sin novedades hoy.")
    else:
        send_telegram_message(build_report(grouped))

    seen_urls.update(a.link for articles_ in grouped.values() for a in articles_)
    # También marcamos como vistos todos los artículos traídos en esta corrida
    # (no solo los que matchearon), para no re-evaluar el feed completo cada vez.
    seen_urls.update(a.link for a in articles)
    save_seen_urls(seen_urls)


if __name__ == "__main__":
    main()
