"""Filtra artículos por las palabras clave definidas en keywords.yaml."""

from __future__ import annotations

import unicodedata

import yaml

from sources import Article


def load_keywords(path: str = "keywords.yaml") -> list[str]:
    config = _load_config(path)
    return config["keywords"]


def load_exclude_keywords(path: str = "keywords.yaml") -> list[str]:
    config = _load_config(path)
    return config.get("exclude_keywords", [])


def _load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


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


def is_excluded(article: Article, exclude_keywords: list[str]) -> bool:
    haystack = _normalize(f"{article.title} {article.summary}")
    return any(_normalize(kw) in haystack for kw in exclude_keywords)


def filter_articles(
    articles: list[Article],
    keywords: list[str],
    exclude_keywords: list[str] | None = None,
) -> dict[str, list[Article]]:
    """Agrupa los artículos que matchean por la keyword encontrada, salvo que
    también matcheen alguna palabra de exclude_keywords (ej. temas de
    deportes que no interesan aunque mencionen Tucumán)."""
    exclude_keywords = exclude_keywords or []
    grouped: dict[str, list[Article]] = {}
    for article in articles:
        if is_excluded(article, exclude_keywords):
            continue
        keyword = match_keyword(article, keywords)
        if keyword:
            grouped.setdefault(keyword, []).append(article)
    return grouped
