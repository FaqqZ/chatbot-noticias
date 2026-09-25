# Monitor de noticias de San Miguel de Tucumán

Revisa todas las mañanas los medios locales de Tucumán configurados, filtra
las noticias por palabras clave propias, y envía un informe por Telegram.
Corre solo en GitHub Actions (no depende de tu computadora).

## Cómo funciona

1. Un workflow de GitHub Actions se dispara cada 2 horas en punto (hora
   UTC).
2. `main.py` trae los artículos de los feeds RSS listados en `sources.yaml`,
   más las noticias oficiales del Municipio (`comunicacionsmt.py`, scraping
   de comunicacionsmt.gob.ar — no tiene RSS).
3. Filtra por `keywords.yaml`, descarta lo que matchea `exclude_keywords`
   (ej. deportes), puntúa por relevancia, deduplica la misma noticia cubierta
   por varios medios y se queda con las `max_results` más importantes.
4. Envía el informe (solo noticias) a tu chat de Telegram.
5. Guarda los links ya enviados en `seen_urls.json` para no repetir noticias
   al día siguiente.

Los eventos de la Agenda Cultural del Municipio **no** están en este
informe — viven aparte, en el comando `/eventos` del bot (ver abajo), para
no mezclarlos con las noticias.

Además, un Cloudflare Worker recibe por **webhook** (no polling) los mensajes
que le mandes al bot y responde a comandos (ver "Comandos del bot" más
abajo) — `/keywords`, `/agregar`, `/quitar` y `/ayuda` responden casi al
instante, sin pasar por GitHub Actions. Solo `/informe` dispara GitHub
Actions (tarda ~30-60s, porque corre el pipeline completo de Python).

**Importante**: el `schedule` propio de GitHub Actions no es confiable (puede
demorar minutos u horas) y no sirve para recibir mensajes de Telegram en
tiempo real. Todo el disparo a horario exacto y la recepción de comandos la
hace un Cloudflare Worker — ver
[`cloudflare-worker/README.md`](cloudflare-worker/README.md) para el setup
(obligatorio para que esto funcione).

## Setup (una sola vez)

### 1. Crear el bot de Telegram

1. Abrí una conversación con [@BotFather](https://t.me/BotFather) en
   Telegram.
2. Enviale `/newbot`, elegí un nombre y un username para tu bot.
3. BotFather te va a dar un **token** (algo como
   `123456789:ABCdefGhIJKlmNoPQRstuVwxyZ`). Guardalo.
4. Iniciá una conversación con tu bot nuevo (buscalo por el username y
   apretá "Start" / mandale cualquier mensaje).
5. Para obtener tu **chat_id**, abrí en el navegador (reemplazando
   `<TOKEN>`):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   y buscá el campo `"chat":{"id": ...}` en la respuesta JSON.

### 2. Subir el repo a GitHub

```bash
gh repo create tucuman-news-monitor --private --source=. --push
```

(o crealo manualmente en GitHub y hacé `git remote add origin ...` +
`git push`).

### 3. Cargar los secrets en GitHub

En el repo de GitHub: **Settings → Secrets and variables → Actions → New
repository secret**, y agregá:

- `TELEGRAM_BOT_TOKEN`: el token de BotFather.
- `TELEGRAM_CHAT_ID`: el chat_id obtenido en el paso anterior.

### 4. Completar tus palabras clave

Editá `keywords.yaml` y agregá los términos que querés rastrear (uno por
línea), por ejemplo:

```yaml
keywords:
  - San Miguel de Tucumán
  - Tucumán
  - municipalidad de Tucumán
```

El matching es case-insensitive y no distingue acentos.

### 5. Probar manualmente

En GitHub: **Actions → Informe diario de noticias → Run workflow**. Debería
llegarte un mensaje de Telegram en menos de un minuto.

## Comandos del bot

Le podés escribir directamente a tu bot en Telegram:

- `/informe` — manda el informe de noticias relevantes en el momento (no
  espera al próximo envío automático cada 2hs). Tarda ~30-60s, porque
  dispara el pipeline completo en GitHub Actions.
- `/eventos` — últimos eventos publicados en la Agenda Cultural del
  Municipio (agendaculturalsmt.com). Respuesta casi instantánea. Muestra la
  fecha de *publicación* en la agenda, no la fecha en que ocurre el evento
  — ese sitio no expone esa fecha de forma confiable (el calendario se
  carga por JavaScript).
- `/keywords` — lista las palabras clave, exclusiones y medios activos.
  Respuesta casi instantánea.
- `/agregar <palabra>` — suma una palabra clave a `keywords.yaml` (commitea
  el cambio automáticamente vía la API de GitHub). Respuesta casi
  instantánea.
- `/quitar <palabra>` — saca una palabra clave. Ídem.
- `/agendar <texto>` — anota texto libre en tu agenda personal (ej. "Agenda
  del Lic. Fernandez y del Crio. Rolando Gomez"), guardado en `agenda.json`
  vía la API de GitHub. Respuesta casi instantánea. Por ahora no hay forma
  de borrar ítems ni se incluyen en el informe periódico.
- `/miagenda` — lista todo lo que cargaste con `/agendar`, con fecha de
  carga. Respuesta casi instantánea.
- `/limpiar` — vacía `seen_urls.json` (el caché de noticias ya mostradas).
  El próximo `/informe` vuelve a traer todo lo que matchea tus keywords,
  aunque ya lo hayas visto. Respuesta casi instantánea.
- `/ayuda` — lista estos comandos.

Solo responde a mensajes del `chat_id` configurado en los secrets del
Worker — otros usuarios que le escriban al bot son ignorados. Además valida
un token secreto propio del webhook (`WEBHOOK_SECRET`), así que ni siquiera
alguien que adivine la URL del Worker puede mandar comandos falsos.

## Agregar o quitar medios

Editá `sources.yaml`. Cada fuente necesita un `name` y una `rss_url`. Para
verificar si un medio nuevo tiene RSS, probá abrir `<sitio>/rss`,
`<sitio>/feed` o `<sitio>/rss.xml` en el navegador.

Para un medio sin RSS hace falta un scraper dedicado (como
`comunicacionsmt.py`), no alcanza con agregarlo a `sources.yaml`. Nota sobre
comunicacionsmt.gob.ar: el calendario de eventos de ese sitio (`/get_events`)
está protegido por un WAF/Cloudflare que bloquea accesos automatizados
(devuelve 403/404 según los headers) — por eso se scrapea el listado de
noticias (`/categoria/177/noticias`, sí accesible) en vez del calendario.

## Desarrollo local

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy .venv/bin/python main.py
```
