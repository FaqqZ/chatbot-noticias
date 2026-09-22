"""Orquesta el informe diario: trae noticias, filtra por keywords, envía y deduplica."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from html import escape

from comunicacionsmt import fetch_comunicacionsmt_articles
from events import MunicipalEvent, fetch_municipal_events
from filters import (
    RankedArticle,
    load_exclude_keywords,
    load_keywords,
    load_max_results,
    rank_articles,
)
from notifier import send_telegram_message
from sources import fetch_articles, load_sources

MAX_EVENTS = 5

SEEN_URLS_PATH = Path("seen_urls.json")
MAX_SEEN_URLS = 2000  # evita que el archivo crezca indefinidamente


def load_seen_urls() -> set[str]:
    if not SEEN_URLS_PATH.exists():
        return set()
    return set(json.loads(SEEN_URLS_PATH.read_text(encoding="utf-8")))


def save_seen_urls(urls: set[str]) -> None:
    trimmed = list(urls)[-MAX_SEEN_URLS:]
    SEEN_URLS_PATH.write_text(json.dumps(trimmed, ensure_ascii=False, indent=2), encoding="utf-8")


def build_report(ranked: list[RankedArticle], events: list[MunicipalEvent]) -> str:
    today = datetime.now().strftime("%d/%m/%Y")
    lines = [f"<b>Informe de noticias — San Miguel de Tucumán</b>", f"{today}", ""]
    for item in ranked:
        article = item.article
        tags = " ".join(f"#{escape(kw.replace(' ', ''))}" for kw in item.matched_keywords)
        lines.append(f'• <a href="{escape(article.link)}">{escape(article.title)}</a> ({escape(article.source)})')
        lines.append(f"  {tags}")

    if events:
        if ranked:
            lines.append("")
        lines.append("<b>🎭 Agenda Cultural del Municipio</b> (últimos eventos publicados)")
        for event in events:
            lines.append(f'• <a href="{escape(event.link)}">{escape(event.title)}</a> (publicado {event.published})')

    return "\n".join(lines).strip()


def main() -> None:
    sources = load_sources()
    keywords = load_keywords()
    exclude_keywords = load_exclude_keywords()
    max_results = load_max_results()
    articles = fetch_articles(sources)

    try:
        articles += fetch_comunicacionsmt_articles()
    except Exception:
        pass  # si falla el scraping del Municipio, no debe tumbar el resto del informe

    seen_urls = load_seen_urls()
    new_articles = [a for a in articles if a.link not in seen_urls]

    ranked = rank_articles(new_articles, keywords, exclude_keywords, max_results)

    try:
        events = fetch_municipal_events(MAX_EVENTS)
    except Exception:
        events = []  # si falla la agenda cultural, no debe tumbar el informe de noticias

    if not ranked and not events:
        send_telegram_message("Informe de noticias de San Miguel de Tucumán: sin novedades relevantes hoy.")
    else:
        send_telegram_message(build_report(ranked, events))

    seen_urls.update(item.article.link for item in ranked)
    # También marcamos como vistos todos los artículos traídos en esta corrida
    # (no solo los que matchearon), para no re-evaluar el feed completo cada vez.
    seen_urls.update(a.link for a in articles)
    save_seen_urls(seen_urls)


if __name__ == "__main__":
    main()
