"""Filtra artículos por las palabras clave definidas en keywords.yaml."""

from __future__ import annotations

import unicodedata

import yaml

from sources import Article


def load_keywords(path: str = "keywords.yaml") -> list[str]:
    with open(path, encoding="utf-8") as f:
        config = yaml.safe_load(f)
    return config["keywords"]


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.lower()


def match_keyword(article: Article, keywords: list[str]) -> str | None:
    """Devuelve la primera keyword que matchea el título o resumen, o None."""
    haystack = _normalize(f"{article.title} {article.summary}")
    for keyword in keywords:
        if _normalize(keyword) in haystack:
            return keyword
    return None


def filter_articles(articles: list[Article], keywords: list[str]) -> dict[str, list[Article]]:
    """Agrupa los artículos que matchean por la keyword encontrada."""
    grouped: dict[str, list[Article]] = {}
    for article in articles:
        keyword = match_keyword(article, keywords)
        if keyword:
            grouped.setdefault(keyword, []).append(article)
    return grouped
