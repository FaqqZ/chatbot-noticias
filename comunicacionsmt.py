"""Scraping del portal oficial de comunicación de la Municipalidad de SMT.

No tiene RSS ni una API pública (el calendario de eventos del sitio está
detrás de un endpoint bloqueado por WAF/Cloudflare para accesos
automatizados), así que se scrapea directamente el listado de noticias, que
sí es HTML server-rendered normal. Se suma como una fuente más al pipeline
de noticias (se filtra por las mismas keywords que el resto), no como una
lista de eventos aparte.
"""

from __future__ import annotations

from datetime import datetime

import requests
from bs4 import BeautifulSoup

from sources import Article

BASE_URL = "https://comunicacionsmt.gob.ar"
LISTING_URL = f"{BASE_URL}/categoria/177/noticias"
SOURCE_NAME = "Municipalidad de SMT"


def fetch_comunicacionsmt_articles() -> list[Article]:
    response = requests.get(LISTING_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")

    articles = []
    for post in soup.select("article.post__noticia"):
        title_el = post.select_one("h2.post__titulo a")
        date_el = post.select_one(".post__fecha .fecha")
        summary_el = post.select_one(".post__detalle")
        if title_el is None:
            continue

        link = title_el.get("href", "").strip()
        if link.startswith("/"):
            link = BASE_URL + link

        articles.append(
            Article(
                title=title_el.get_text(strip=True),
                link=link,
                source=SOURCE_NAME,
                published=_parse_date(date_el.get_text(strip=True) if date_el else ""),
                summary=summary_el.get_text(strip=True) if summary_el else "",
            )
        )
    return articles


def _parse_date(text: str) -> str:
    try:
        return datetime.strptime(text, "%d/%m/%Y").strftime("%Y-%m-%d 00:00")
    except ValueError:
        return ""
