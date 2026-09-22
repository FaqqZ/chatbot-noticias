"""Descarga y normaliza artículos desde los feeds RSS configurados en sources.yaml."""

from __future__ import annotations

from dataclasses import dataclass
from time import strftime, struct_time

import feedparser
import yaml


@dataclass
class Article:
    title: str
    link: str
    source: str
    published: str
    summary: str


def load_sources(path: str = "sources.yaml") -> list[dict]:
    with open(path, encoding="utf-8") as f:
        config = yaml.safe_load(f)
    return config["sources"]


def _format_published(entry) -> str:
    parsed: struct_time | None = entry.get("published_parsed") or entry.get("updated_parsed")
    if parsed is None:
        return entry.get("published", "")
    return strftime("%Y-%m-%d %H:%M", parsed)


def fetch_articles(sources: list[dict]) -> list[Article]:
    articles = []
    for source in sources:
        feed = feedparser.parse(source["rss_url"])
        for entry in feed.entries:
            articles.append(
                Article(
                    title=entry.get("title", "").strip(),
                    link=entry.get("link", "").strip(),
                    source=source["name"],
                    published=_format_published(entry),
                    summary=entry.get("summary", "").strip(),
                )
            )
    return articles
