/**
 * Dos trabajos en un mismo Worker:
 *
 * 1. `scheduled()`: dispara el informe diario (workflow_dispatch en GitHub)
 *    a horario exacto, porque el `schedule` propio de GitHub Actions no es
 *    confiable.
 * 2. `fetch()` en POST /telegram-webhook: recibe los mensajes del bot de
 *    Telegram en tiempo real (webhook, no polling) y resuelve los comandos
 *    simples (/keywords, /eventos, /agregar, /quitar, /limpiar, /ayuda)
 *    directo acá — /keywords y /agregar/quitar leen y escriben
 *    keywords.yaml, /limpiar vacía seen_urls.json, todo vía la API de
 *    contenidos de GitHub; /eventos consulta agendaculturalsmt.com — sin
 *    pasar por GitHub Actions, así que la respuesta es casi instantánea.
 *    Solo /informe dispara GitHub Actions, porque necesita correr el
 *    pipeline de Python (traer RSS, rankear, deduplicar).
 */

const OWNER = "FaqqZ";
const REPO = "chatbot-noticias";
const CONTENTS_API = `https://api.github.com/repos/${OWNER}/${REPO}/contents`;
const BRANCH = "main";

const HELP_TEXT =
  "Comandos disponibles:\n" +
  "/informe — mandar el informe de noticias relevantes ahora\n" +
  "/eventos — ver los últimos eventos publicados en la Agenda Cultural del Municipio\n" +
  "/keywords — ver palabras clave, exclusiones y medios activos\n" +
  "/agregar <palabra> — sumar una palabra clave a rastrear\n" +
  "/quitar <palabra> — sacar una palabra clave\n" +
  "/agendar <texto> — anotar algo en tu agenda personal (texto libre)\n" +
  "/miagenda — ver lo que anotaste en tu agenda personal\n" +
  "/limpiar — limpiar el caché de noticias vistas (el próximo /informe trae todo de nuevo, incluso lo ya mostrado)\n" +
  "/ayuda — ver esta ayuda";

const EVENTS_API_URL = "https://agendaculturalsmt.com/wp-json/wp/v2/ajde_events";
const EVENTS_EXCLUDED_SLUGS = new Set(["ejemplo"]); // evento de prueba que quedó cargado en el sitio
const MAX_EVENTS = 5;

// ---------- GitHub: disparar workflows ----------

async function dispatchWorkflow(workflowFile, token) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${workflowFile}/dispatches`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tucuman-news-scheduler-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: BRANCH }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error ${response.status} para ${workflowFile}: ${body}`);
  }
}

// ---------- GitHub: leer/escribir archivos (Contents API) ----------

function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

async function getFile(path, token) {
  const res = await fetch(`${CONTENTS_API}/${path}?ref=${BRANCH}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tucuman-news-scheduler-worker",
    },
  });
  if (!res.ok) throw new Error(`GET ${path} falló: ${res.status}`);
  const data = await res.json();
  return { content: base64ToUtf8(data.content), sha: data.sha };
}

// Como getFile pero devuelve null en vez de lanzar cuando el archivo
// todavía no existe (para archivos que el bot crea recién en el primer uso,
// como agenda.json).
async function getFileOptional(path, token) {
  const res = await fetch(`${CONTENTS_API}/${path}?ref=${BRANCH}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tucuman-news-scheduler-worker",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} falló: ${res.status}`);
  const data = await res.json();
  return { content: base64ToUtf8(data.content), sha: data.sha };
}

async function putFile(path, content, sha, message, token) {
  const res = await fetch(`${CONTENTS_API}/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tucuman-news-scheduler-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(content),
      sha,
      branch: BRANCH,
      committer: { name: "tucuman-news-monitor bot", email: "actions@github.com" },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PUT ${path} falló: ${res.status} ${body}`);
  }
}

// ---------- Edición de keywords.yaml (preservando comentarios) ----------
// Misma lógica que bot.py (_keyword_section_bounds/add_keyword/remove_keyword):
// se edita como texto plano, no se parsea/re-serializa YAML, para no perder
// los comentarios del archivo.

function normalize(text) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function keywordSectionBounds(lines) {
  const start = lines.findIndex((l) => l.trim() === "keywords:");
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith("  - ")) end++;
  return [start, end];
}

function extractListSection(lines, headerLine) {
  const start = lines.findIndex((l) => l.trim() === headerLine);
  if (start === -1) return [];
  const items = [];
  let i = start + 1;
  while (i < lines.length && lines[i].startsWith("  - ")) {
    items.push(lines[i].slice(4).trim());
    i++;
  }
  return items;
}

async function handleAddKeyword(env, word) {
  const { content, sha } = await getFile("keywords.yaml", env.GITHUB_TOKEN);
  const lines = content.split("\n");
  const bounds = keywordSectionBounds(lines);
  if (!bounds) return "No pude encontrar la sección 'keywords:' en keywords.yaml.";
  const [start, end] = bounds;
  const current = lines.slice(start + 1, end).map((l) => l.slice(4).trim());
  if (current.some((k) => normalize(k) === normalize(word))) {
    return `"${word}" ya está en la lista de palabras clave.`;
  }
  lines.splice(end, 0, `  - ${word}`);
  await putFile("keywords.yaml", lines.join("\n"), sha, `Bot: agregar keyword "${word}"`, env.GITHUB_TOKEN);
  return `Agregada la palabra clave "${word}".`;
}

async function handleRemoveKeyword(env, word) {
  const { content, sha } = await getFile("keywords.yaml", env.GITHUB_TOKEN);
  const lines = content.split("\n");
  const bounds = keywordSectionBounds(lines);
  if (!bounds) return "No pude encontrar la sección 'keywords:' en keywords.yaml.";
  const [start, end] = bounds;
  for (let i = start + 1; i < end; i++) {
    if (normalize(lines[i].slice(4).trim()) === normalize(word)) {
      lines.splice(i, 1);
      await putFile("keywords.yaml", lines.join("\n"), sha, `Bot: quitar keyword "${word}"`, env.GITHUB_TOKEN);
      return `Saqué la palabra clave "${word}".`;
    }
  }
  return `No encontré "${word}" en la lista de palabras clave.`;
}

async function handleClearCache(env) {
  const { sha } = await getFile("seen_urls.json", env.GITHUB_TOKEN);
  await putFile("seen_urls.json", "[]\n", sha, "Bot: limpiar caché de noticias vistas", env.GITHUB_TOKEN);
  return "Listo, limpié el caché. El próximo /informe va a traer todo de nuevo (incluso lo que ya te mostré antes).";
}

// ---------- Agenda personal (agenda.json) ----------
// Texto libre que el usuario carga con /agendar. Se guarda crudo (sin
// escapar HTML) y se escapa recién al formatear la respuesta de /miagenda.

async function handleAddAgendaItem(env, text) {
  const existing = await getFileOptional("agenda.json", env.GITHUB_TOKEN);
  const items = existing ? JSON.parse(existing.content) : [];
  const sha = existing ? existing.sha : undefined;

  const nextId = items.reduce((max, it) => Math.max(max, it.id), 0) + 1;
  items.push({ id: nextId, text, created_at: new Date().toISOString().slice(0, 10) });

  await putFile(
    "agenda.json",
    JSON.stringify(items, null, 2) + "\n",
    sha,
    `Bot: agregar ítem de agenda #${nextId}`,
    env.GITHUB_TOKEN
  );
  return `Agregado a tu agenda (#${nextId}).`;
}

async function handleListAgenda(env) {
  const existing = await getFileOptional("agenda.json", env.GITHUB_TOKEN);
  const items = existing ? JSON.parse(existing.content) : [];
  if (items.length === 0) return "Tu agenda está vacía. Usá /agendar <texto> para cargar algo.";

  const lines = ["<b>📋 Tu agenda</b>"];
  for (const it of items) {
    lines.push(`• #${it.id} (${it.created_at}) ${escapeHtml(it.text)}`);
  }
  return lines.join("\n");
}

async function describeConfig(env) {
  const [{ content: keywordsFile }, { content: sourcesFile }] = await Promise.all([
    getFile("keywords.yaml", env.GITHUB_TOKEN),
    getFile("sources.yaml", env.GITHUB_TOKEN),
  ]);
  const kwLines = keywordsFile.split("\n");
  const keywords = extractListSection(kwLines, "keywords:");
  const exclude = extractListSection(kwLines, "exclude_keywords:");
  const sourceNames = [...sourcesFile.matchAll(/^\s*-\s*name:\s*(.+)$/gm)].map((m) => m[1].trim());
  sourceNames.push("Municipalidad de SMT (comunicacionsmt.gob.ar, scraping)");

  return [
    "<b>Palabras clave:</b>",
    ...keywords.map((k) => `• ${k}`),
    "",
    "<b>Exclusiones (descartan aunque matcheen):</b>",
    ...exclude.map((k) => `• ${k}`),
    "",
    "<b>Medios monitoreados:</b>",
    ...sourceNames.map((s) => `• ${s}`),
  ].join("\n");
}

// ---------- Agenda Cultural del Municipio (agendaculturalsmt.com) ----------
// Nota: la API no expone la fecha real del evento (el calendario del sitio
// la carga por JS). Se muestran los últimos publicados en la agenda, con
// su fecha de publicación — no es la fecha en que ocurre el evento.

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#039": "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z0-9]+);/g, (match, code) => {
    if (code[0] === "#") {
      const codePoint = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return HTML_ENTITIES[code] ?? match;
  });
}

function stripHtml(rawHtml) {
  const withoutTags = rawHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return decodeEntities(withoutTags);
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function fetchMunicipalEvents(limit = MAX_EVENTS) {
  const params = new URLSearchParams({
    per_page: String(limit + EVENTS_EXCLUDED_SLUGS.size),
    orderby: "date",
    order: "desc",
    _fields: "title,link,slug,date,content",
  });
  const res = await fetch(`${EVENTS_API_URL}?${params}`, {
    headers: { "User-Agent": "tucuman-news-scheduler-worker" },
  });
  if (!res.ok) throw new Error(`agendaculturalsmt.com falló: ${res.status}`);
  const items = await res.json();

  const events = [];
  for (const item of items) {
    if (EVENTS_EXCLUDED_SLUGS.has(item.slug)) continue;
    events.push({
      title: stripHtml(item.title.rendered),
      link: item.link,
      published: item.date.slice(0, 10),
    });
    if (events.length >= limit) break;
  }
  return events;
}

function formatEventsReply(events) {
  if (events.length === 0) return "No encontré eventos publicados en la agenda cultural ahora mismo.";
  const lines = ["<b>🎭 Agenda Cultural del Municipio</b> (últimos eventos publicados)"];
  for (const event of events) {
    lines.push(`• <a href="${event.link}">${event.title}</a> (publicado ${event.published})`);
  }
  return lines.join("\n");
}

// ---------- Telegram ----------

async function replyTelegram(env, text, html = false) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = new URLSearchParams({ chat_id: env.TELEGRAM_CHAT_ID, text });
  if (html) body.set("parse_mode", "HTML");
  const res = await fetch(url, { method: "POST", body });
  if (!res.ok) throw new Error(`sendMessage falló: ${res.status} ${await res.text()}`);
}

async function handleTelegramWebhook(request, env) {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await request.json();
  const message = update.message;
  if (!message || typeof message.text !== "string") return new Response("ok");

  const chatId = String(message.chat.id);
  console.log(`mensaje de chat_id=${chatId} tipo=${message.chat.type} texto=${JSON.stringify(message.text)}`);
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) return new Response("ignored");

  const text = message.text.trim();
  if (!text.startsWith("/")) return new Response("ok");

  const spaceIdx = text.indexOf(" ");
  const rawCommand = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  const arg = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
  const command = rawCommand.split("@")[0].toLowerCase();

  try {
    switch (command) {
      case "/start":
      case "/ayuda":
      case "/help":
        await replyTelegram(env, HELP_TEXT);
        break;
      case "/keywords":
        await replyTelegram(env, await describeConfig(env), true);
        break;
      case "/eventos":
        await replyTelegram(env, formatEventsReply(await fetchMunicipalEvents()), true);
        break;
      case "/agregar":
        await replyTelegram(env, arg ? await handleAddKeyword(env, arg) : "Uso: /agregar <palabra clave>");
        break;
      case "/quitar":
        await replyTelegram(env, arg ? await handleRemoveKeyword(env, arg) : "Uso: /quitar <palabra clave>");
        break;
      case "/agendar":
        await replyTelegram(env, arg ? await handleAddAgendaItem(env, arg) : "Uso: /agendar <texto>");
        break;
      case "/miagenda":
        await replyTelegram(env, await handleListAgenda(env), true);
        break;
      case "/limpiar":
        await replyTelegram(env, await handleClearCache(env));
        break;
      case "/informe":
        await dispatchWorkflow("daily-report.yml", env.GITHUB_TOKEN);
        await replyTelegram(env, "Generando el informe, te llega en un momento…");
        break;
      default:
        await replyTelegram(env, `No reconozco ese comando.\n\n${HELP_TEXT}`);
    }
  } catch (err) {
    await replyTelegram(env, `Uh, algo falló procesando el comando: ${err.message}`);
  }

  return new Response("ok");
}

// ---------- Entry points ----------

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "0 */2 * * *") {
      ctx.waitUntil(dispatchWorkflow("daily-report.yml", env.GITHUB_TOKEN));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/telegram-webhook") {
      return handleTelegramWebhook(request, env);
    }

    // Prueba manual: GET /?workflow=daily-report.yml
    const workflowFile = url.searchParams.get("workflow");
    if (workflowFile === "daily-report.yml") {
      try {
        await dispatchWorkflow(workflowFile, env.GITHUB_TOKEN);
        return new Response(`Disparado ${workflowFile}`);
      } catch (err) {
        return new Response(String(err), { status: 500 });
      }
    }

    return new Response("Uso: ?workflow=daily-report.yml, o POST /telegram-webhook", { status: 400 });
  },
};
