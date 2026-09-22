# Monitor de noticias de San Miguel de Tucumán

Revisa todas las mañanas los medios locales de Tucumán configurados, filtra
las noticias por palabras clave propias, y envía un informe por Telegram.
Corre solo en GitHub Actions (no depende de tu computadora).

## Cómo funciona

1. Un workflow de GitHub Actions se dispara todos los días a las 07:00 (hora
   Argentina).
2. `main.py` trae los artículos de los feeds RSS listados en `sources.yaml`.
3. Filtra por `keywords.yaml`, descarta lo que matchea `exclude_keywords`
   (ej. deportes), puntúa por relevancia, deduplica la misma noticia cubierta
   por varios medios y se queda con las `max_results` más importantes.
4. Envía el informe a tu chat de Telegram.
5. Guarda los links ya enviados en `seen_urls.json` para no repetir noticias
   al día siguiente.

Además, otro workflow (`bot-interact.yml`) revisa cada 5 minutos si le
escribiste algo al bot y responde a comandos (ver "Comandos del bot" más
abajo). No es instantáneo — GitHub puede demorar la ejecución programada
unos minutos.

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
  espera a las 7 AM).
- `/keywords` — lista las palabras clave, exclusiones y medios activos.
- `/agregar <palabra>` — suma una palabra clave a `keywords.yaml` (commitea
  el cambio automáticamente).
- `/quitar <palabra>` — saca una palabra clave.
- `/ayuda` — lista estos comandos.

Solo responde a mensajes del `chat_id` configurado en los secrets — otros
usuarios que le escriban al bot son ignorados.

## Agregar o quitar medios

Editá `sources.yaml`. Cada fuente necesita un `name` y una `rss_url`. Para
verificar si un medio nuevo tiene RSS, probá abrir `<sitio>/rss`,
`<sitio>/feed` o `<sitio>/rss.xml` en el navegador.

## Desarrollo local

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy .venv/bin/python main.py
```
