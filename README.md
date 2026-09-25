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
6. (Opcional) Para que el bot también responda en un **grupo**: agregalo al
   grupo, mandale ahí cualquier comando (ej. `/ayuda`) y repetí la consulta
   a `getUpdates` — el `chat_id` de un grupo es un número negativo. Vas a
   necesitar ese id para el secret `TELEGRAM_CHAT_ID` del Worker (ver "Cargar
   los secrets del Worker" en [`cloudflare-worker/README.md`](cloudflare-worker/README.md)),
   que acepta varios chat_id separados por coma.

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
- `TELEGRAM_CHAT_ID`: el chat_id obtenido en el paso anterior. Este es el
  secret que usa GitHub Actions para el informe periódico (`main.py` /
  `notifier.py`) — admite uno o varios chat_id separados por coma (ej. tu
  chat personal + un grupo), igual que el del Worker (ver más abajo).

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
- `/agendar <texto>` — anota texto libre en tu agenda personal (ej. "Reunión
  con DiTec, Lic. Fernandez a las 18:00hs el 30/09/2026"), guardado en
  `agenda.json` vía la API de GitHub. Respuesta casi instantánea. Por ahora
  no se incluyen en el informe periódico.

  Si el texto trae una fecha y/o una hora, el bot las detecta y las usa para
  ordenar `/miagenda`. Reconoce:
  - Formato escrito: `el DD/MM/AAAA` (ej. `el 30/09/2026`).
  - Formato hablado (el que devuelve la transcripción de audio): `el DD de
    <mes> [de AAAA]` (ej. `el 30 de septiembre de 2026` — si no decís el
    año, asume el año que viene si esa fecha ya pasó este año).
  - Relativos: `hoy`, `mañana`, `pasado mañana`. "mañana" en el sentido de
    "AM" (ej. "a las 9 **de la mañana**") no cuenta como "día siguiente" —
    el bot distingue ese caso.
  - **Sin fecha, solo hora** (ej. "a las 15:40hs", sin decir ningún día):
    asume hoy, salvo que esa hora ya haya pasado hoy, en cuyo caso asume
    mañana.

  Para la hora reconoce `a las HH:MMhs` o `a las HH horas` (en cualquier
  orden respecto de la fecha; también funciona `a la` y hora sin minutos,
  ej. `a las 9hs`). También reconoce la hora sin la palabra "la"/"las" (ej.
  "a 16 horas", que es como a veces sale la transcripción de audio), pero
  en ese caso exige un sufijo horario explícito ("horas" o "hs") para no
  confundir cualquier "a &lt;número&gt;" suelto con una hora. Si no matchea
  ningún patrón, igual se guarda el texto tal cual, sin fecha estructurada.
- `/miagenda` — lista lo que cargaste con `/agendar`, ordenado por fecha más
  próxima primero (los que no tienen fecha detectada van aparte, al final,
  con su fecha de carga). Cada ítem muestra su `#id`. Respuesta casi
  instantánea.
- `/desagendar <id>` — saca un ítem de tu agenda personal (el `#id` sale de
  `/miagenda`). Respuesta casi instantánea.
- **Mensaje de voz** (sin comando) — se transcribe con
  `@cf/openai/whisper-large-v3-turbo` de Cloudflare Workers AI (el modelo
  grande, no el básico) y se carga directo en la agenda, como si hubieras
  mandado `/agendar <transcripción>`. Se le fija el idioma (español) y se le
  da un prompt de contexto (que puede traer nombres propios, títulos como
  "Lic."/"Crio.", fechas y horarios) para mejorar la precisión — probado
  contra el modelo básico, corrige varios errores de nombres propios que el
  básico no pescaba. El bot te responde con el texto que entendió (para que
  puedas chequear que la transcripción salió bien) más la confirmación de
  que se agregó. Tarda un poco más que los comandos de texto porque corre
  el modelo, pero sigue siendo dentro del mismo Worker (no dispara GitHub
  Actions).
- `/limpiar` — vacía `seen_urls.json` (el caché de noticias ya mostradas).
  El próximo `/informe` vuelve a traer todo lo que matchea tus keywords,
  aunque ya lo hayas visto. Respuesta casi instantánea.
- `/ayuda` — lista estos comandos.

### Recordatorios automáticos de la agenda

Para los ítems de `/agendar` con fecha detectada, el bot manda avisos
automáticos sin que hagas nada, usando el mismo Cron Trigger que dispara el
informe cada 2hs (hora Argentina, sin horario de verano):

- **El día anterior**, en algún momento entre las 7 y las 11 de la mañana:
  un resumen de lo que tenés agendado para el día siguiente.
- **Un par de horas antes** del horario del evento (solo si el ítem tiene
  hora detectada, no solo fecha): un recordatorio puntual de ese ítem.
  Si cuando lo cargás con `/agendar` (o por audio) ya faltan menos de 3hs
  para el evento, este aviso se manda **al toque**, en el momento de
  cargarlo — no espera al próximo tick del cron. Si falta más de 3hs, sí
  espera al cron.

Cada aviso se manda una sola vez por ítem (queda marcado en `agenda.json`
con `notified_day_before`/`notified_hours_before`). Fuera del caso de "ya
faltan menos de 3hs" (que se manda al instante), el chequeo periódico corre
cada 2hs, así que el margen real es de hasta ±1h respecto al horario
exacto — si en algún momento hace falta más precisión, se puede agregar un
Cron Trigger aparte que corra más seguido solo para este chequeo (ver
`crons` en `wrangler.toml`).

Solo responde a mensajes de los `chat_id` configurados en el secret
`TELEGRAM_CHAT_ID` **del Worker** (que admite uno o varios separados por
coma, ej. tu chat personal + un grupo) — otros chats que le escriban al bot
son ignorados. Además valida un token secreto propio del webhook
(`WEBHOOK_SECRET`), así que ni siquiera alguien que adivine la URL del
Worker puede mandar comandos falsos.

Nota: este secret es independiente del `TELEGRAM_CHAT_ID` que usa GitHub
Actions para el informe periódico (paso 3 del setup) — son dos lugares
distintos (Worker vs. GitHub Actions) con su propio valor, aunque ambos
admiten la misma sintaxis de lista separada por coma. Si agregás un chat
nuevo (ej. un grupo) y querés que reciba tanto los comandos interactivos
como el informe automático, hay que actualizar los dos secrets por
separado, con la misma lista de chat_id en cada uno.

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
