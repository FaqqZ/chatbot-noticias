# Scheduler (Cloudflare Worker)

El `schedule` (cron) de GitHub Actions no es confiable: en la práctica puede
demorar minutos u horas, y para crons frecuentes (cada 5 minutos) casi nunca
corre a tiempo. Este Worker de Cloudflare reemplaza esa parte: se dispara a
horario exacto vía Cron Triggers (que sí son confiables) y llama a la API de
GitHub para arrancar los workflows (`workflow_dispatch`). El trabajo en sí
(traer noticias, mandar Telegram, etc.) lo sigue haciendo GitHub Actions —
esto solo soluciona el disparo a horario.

Es gratis: el plan free de Cloudflare Workers incluye Cron Triggers sin
costo, muy por encima de lo que este uso necesita.

## Setup (una sola vez)

### 1. Cuenta de Cloudflare

Si no tenés una, creála gratis en <https://dash.cloudflare.com/sign-up>.

### 2. Login de wrangler

Desde esta carpeta (`cloudflare-worker/`):

```bash
npx wrangler login
```

Te abre el navegador para autorizar. Quedás logueado en esta máquina.

### 3. Crear un token de GitHub para el Worker

El Worker necesita permiso para disparar workflows en tu repo:

1. Andá a <https://github.com/settings/tokens?type=beta> → **Generate new
   token**.
2. **Repository access**: solo `FaqqZ/chatbot-noticias`.
3. **Permissions** → **Actions**: `Read and write`.
4. Generá el token y copialo (empieza con `github_pat_...`).

### 4. Cargar el token como secret del Worker

```bash
npx wrangler secret put GITHUB_TOKEN
```

Te va a pedir que pegues el token — no se guarda en ningún archivo del repo.

### 5. Deploy

```bash
npx wrangler deploy
```

Con eso los Cron Triggers quedan activos: todos los días a las 10:00 UTC
(7:00 Argentina) dispara `daily-report.yml`, y cada 5 minutos dispara
`bot-interact.yml`.

## Probar manualmente

El Worker también responde a pedidos HTTP normales, útil para probar sin
esperar al cron:

```
https://tucuman-news-scheduler.<tu-subdominio>.workers.dev/?workflow=daily-report.yml
https://tucuman-news-scheduler.<tu-subdominio>.workers.dev/?workflow=bot-interact.yml
```

(la URL exacta la muestra `wrangler deploy` al terminar).

## Cambiar el horario

Editá `crons` en `wrangler.toml` (formato cron estándar, en UTC) y volvé a
correr `npx wrangler deploy`.
