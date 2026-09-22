"""Filtra, puntúa y deduplica artículos según keywords.yaml.

La relevancia se evalúa con una heurística simple (sin IA):
- Un artículo es más relevante cuanto más palabras clave distintas matchea.
- Entre artículos muy similares (la misma noticia cubierta por varios
  medios), se conserva solo el más relevante.
- Se recorta al máximo configurado (`max_results`).
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass

import yaml

from sources import Article

# Umbral de similitud de títulos (0-1) a partir del cual dos artículos se
# consideran la misma noticia cubierta por medios distintos.
DUPLICATE_TITLE_THRESHOLD = 0.3

_STOPWORDS = {
    "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "en",
    "a", "al", "y", "o", "que", "se", "su", "sus", "por", "para", "con",
    "es", "fue", "ser", "esta", "este", "estos", "estas", "lo", "como",
    "mas", "mas", "durante", "entre", "sobre", "hoy", "ya",
}


@dataclass
class RankedArticle:
    article: Article
    matched_keywords: list[str]


def load_keywords(path: str = "keywords.yaml") -> list[str]:
    config = _load_config(path)
    return config["keywords"]


def load_exclude_keywords(path: str = "keywords.yaml") -> list[str]:
    config = _load_config(path)
    return config.get("exclude_keywords", [])


def load_max_results(path: str = "keywords.yaml") -> int:
    config = _load_config(path)
    return config.get("max_results", 10)


def _load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.lower()


def match_keywords(article: Article, keywords: list[str]) -> list[str]:
    """Devuelve todas las keywords que matchean el título o resumen."""
    haystack = _normalize(f"{article.title} {article.summary}")
    return [kw for kw in keywords if _normalize(kw) in haystack]


def is_excluded(article: Article, exclude_keywords: list[str]) -> bool:
    haystack = _normalize(f"{article.title} {article.summary}")
    return any(_normalize(kw) in haystack for kw in exclude_keywords)


def _significant_words(title: str) -> set[str]:
    words = _normalize(title).replace(",", " ").replace(":", " ").replace("?", " ").replace("¿", " ").split()
    return {w for w in words if w not in _STOPWORDS and len(w) > 2}


def _title_similarity(a: str, b: str) -> float:
    """Solapamiento (Jaccard) de palabras significativas entre dos títulos.

    Se probó combinar esto con difflib.SequenceMatcher (similitud de texto
    literal), pero a nivel de caracteres da falsos positivos altos (>0.4)
    incluso entre títulos sin relación, solo por compartir palabras muy
    comunes como "Tucumán" o "lunes". El solapamiento de palabras
    significativas es más confiable para detectar la misma noticia cubierta
    por medios distintos."""
    words_a, words_b = _significant_words(a), _significant_words(b)
    if not words_a or not words_b:
        return 0.0
    return len(words_a & words_b) / len(words_a | words_b)


def _deduplicate(ranked: list[RankedArticle]) -> list[RankedArticle]:
    """Recorre los artículos ya ordenados por relevancia y descarta los que
    parecen cubrir la misma noticia que uno ya elegido (se queda con el más
    relevante de cada grupo de duplicados)."""
    kept: list[RankedArticle] = []
    for candidate in ranked:
        if any(
            _title_similarity(candidate.article.title, k.article.title) >= DUPLICATE_TITLE_THRESHOLD
            for k in kept
        ):
            continue
        kept.append(candidate)
    return kept


def rank_articles(
    articles: list[Article],
    keywords: list[str],
    exclude_keywords: list[str] | None = None,
    max_results: int = 10,
) -> list[RankedArticle]:
    """Filtra por keywords/exclusiones, puntúa por relevancia, deduplica
    noticias repetidas entre medios y devuelve como máximo `max_results`."""
    exclude_keywords = exclude_keywords or []

    candidates = []
    for article in articles:
        if is_excluded(article, exclude_keywords):
            continue
        matched = match_keywords(article, keywords)
        if matched:
            candidates.append(RankedArticle(article=article, matched_keywords=matched))

    # Más keywords matcheadas primero; a igualdad, lo más reciente primero.
    candidates.sort(key=lambda r: (len(r.matched_keywords), r.article.published), reverse=True)

    deduplicated = _deduplicate(candidates)
    return deduplicated[:max_results]
