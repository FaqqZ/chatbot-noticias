"""Trae los eventos publicados en la Agenda Cultural del Municipio de SMT.

Fuente: agendaculturalsmt.com (plataforma oficial de la Municipalidad de
San Miguel de Tucumán), vía su API REST de WordPress.

Limitación conocida: la API no expone la fecha real en que ocurre cada
evento (el calendario del sitio la carga por JavaScript). Lo que sí es
confiable es la fecha de publicación en la agenda, que se muestra tal cual
— no se debe interpretar como "fecha del evento".
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from html import unescape

import requests

EVENTS_API_URL = "https://agendaculturalsmt.com/wp-json/wp/v2/ajde_events"
EXCLUDED_SLUGS = {"ejemplo"}  # evento de prueba que quedó cargado en el sitio


@dataclass
class MunicipalEvent:
    title: str
    link: str
    summary: str
    published: str


def _strip_html(raw_html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", raw_html)
    text = re.sub(r"\s+", " ", text).strip()
    return unescape(text)


def fetch_municipal_events(limit: int = 5) -> list[MunicipalEvent]:
    params = {
        "per_page": limit + len(EXCLUDED_SLUGS),
        "orderby": "date",
        "order": "desc",
        "_fields": "title,link,slug,date,content",
    }
    response = requests.get(EVENTS_API_URL, params=params, timeout=15)
    response.raise_for_status()

    events = []
    for item in response.json():
        if item.get("slug") in EXCLUDED_SLUGS:
            continue
        summary = _strip_html(item["content"]["rendered"])
        events.append(
            MunicipalEvent(
                title=_strip_html(item["title"]["rendered"]),
                link=item["link"],
                summary=summary[:200].rstrip() + ("…" if len(summary) > 200 else ""),
                published=item["date"][:10],
            )
        )
        if len(events) >= limit:
            break
    return events
