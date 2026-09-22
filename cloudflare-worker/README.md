# Scheduler + bot (Cloudflare Worker)

Este Worker hace dos cosas:

1. **Dispara el informe diario a horario exacto.** El `schedule` (cron)
   propio de GitHub Actions no es confiable (puede demorar minutos u horas).
   Este Worker usa un Cron Trigger de Cloudflare (que sí es confiable) para
   llamar a la API de GitHub (`workflow_dispatch`) todos los días a las
   10:00 UTC.
2. **Recibe los comandos del bot de Telegram por webhook**, no por polling.
   Telegram le pega directo al Worker apenas mandás un mensaje — nada de
   esperar a que un cron revise cada tanto. `/keywords`, `/agregar`,
   `/quitar` y `/ayuda` se resuelven ahí mismo (leyendo/escribiendo
   `keywords.yaml` vía la API de contenidos de GitHub), así que responden
   casi al instante. Solo `/informe` dispara GitHub Actions (tarda ~30-60s,
   porque corre el pipeline de Python que trae y rankea noticias).

Es gratis: el plan free de Cloudflare Workers incluye Cron Triggers y
volumen de pedidos muy por encima de lo que este uso necesita.

## Setup (una sola vez)

### 1. Cuenta de Cloudflare

Si no tenés una, creála gratis en <https://dash.cloudflare.com/sign-up>.

### 2. Login de wrangler

Desde esta carpeta (`cloudflare-worker/`):

```bash
npx wrangler login
```

Te abre el navegador para autorizar. Quedás logueado en esta máquina.

### 3. Crear un token de GitHub

El Worker necesita permiso para leer/escribir `keywords.yaml` y disparar
workflows en tu repo:

1. Andá a <https://github.com/settings/tokens?type=beta> → **Generate new
   token**.
2. **Repository access**: solo `FaqqZ/chatbot-noticias`.
3. **Permissions** → **Actions**: `Read and write`. **Contents**: `Read and
   write` (para poder editar `keywords.yaml`).
4. Generá el token y copialo (empieza con `github_pat_...`).

### 4. Cargar los secrets del Worker

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put WEBHOOK_SECRET
```

Cada uno te pide que pegues el valor — no se guarda en ningún archivo del
repo. `WEBHOOK_SECRET` es un valor random que vos inventás (por ejemplo con
`openssl rand -hex 24`); sirve para que Telegram demuestre que el mensaje es
realmente suyo.

### 5. Deploy

```bash
npx wrangler deploy
```

Copiá la URL que imprime (algo como
`https://tucuman-news-scheduler.<subdominio>.workers.dev`).

### 6. Registrar el webhook en Telegram

Con el mismo `WEBHOOK_SECRET` del paso 4 y tu `TELEGRAM_BOT_TOKEN`:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://tucuman-news-scheduler.<subdominio>.workers.dev/telegram-webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

A partir de acá, Telegram le manda los mensajes directo al Worker. **Dejás
de poder usar `getUpdates`** (Telegram solo entrega por un canal a la vez) —
no hace falta, todo pasa por el webhook.

## Probar manualmente

Disparar el informe sin esperar al cron ni mandar `/informe`:

```
https://tucuman-news-scheduler.<tu-subdominio>.workers.dev/?workflow=daily-report.yml
```

## Cambiar el horario del informe diario

Editá `crons` en `wrangler.toml` (formato cron estándar, en UTC) y volvé a
correr `npx wrangler deploy`.

## Ver logs en vivo

```bash
npx wrangler tail
```
