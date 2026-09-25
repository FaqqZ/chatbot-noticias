/**
 * Dos trabajos en un mismo Worker:
 *
 * 1. `scheduled()`: dispara el informe diario (workflow_dispatch en GitHub)
 *    a horario exacto, porque el `schedule` propio de GitHub Actions no es
 *    confiable. En el mismo tick (cada 2hs) también chequea `agenda.json`
 *    y manda recordatorios automáticos para los ítems con fecha detectada
 *    (el día anterior y un par de horas antes, ver checkAgendaReminders).
 * 2. `fetch()` en POST /telegram-webhook: recibe los mensajes del bot de
 *    Telegram en tiempo real (webhook, no polling) y resuelve los comandos
 *    simples (/keywords, /eventos, /agregar, /quitar, /agendar, /miagenda,
 *    /desagendar, /limpiar, /ayuda) directo acá — /keywords y
 *    /agregar/quitar leen y escriben keywords.yaml, /agendar/miagenda/
 *    desagendar leen y escriben agenda.json, /limpiar vacía
 *    seen_urls.json, todo vía la API de contenidos de GitHub; /eventos
 *    consulta agendaculturalsmt.com — sin pasar por GitHub Actions, así
 *    que la respuesta es casi instantánea. Los mensajes de voz se
 *    transcriben con el modelo Whisper de Cloudflare Workers AI (binding
 *    `AI`, ver wrangler.toml) y se cargan directo en la agenda, como
 *    /agendar. Solo /informe dispara GitHub Actions, porque necesita
 *    correr el pipeline de Python (traer RSS, rankear, deduplicar).
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
  "/desagendar <id> — sacar un ítem de tu agenda personal (el #id sale de /miagenda)\n" +
  "🎙 mandá un audio — se transcribe y se carga directo en tu agenda, como /agendar\n" +
  "⏰ si un ítem tiene fecha, te avisa solo el día anterior y un par de horas antes\n" +
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
// Si el texto trae "el DD/MM/AAAA" y/o "a las HH:MMhs", se extrae esa fecha
// y hora para poder ordenar /miagenda por proximidad — el texto original no
// se toca.

// Whisper transcribe números como dígitos pero meses como palabras (ej.
// "el 30 de septiembre de 2026", nunca "30/09/2026"), así que hace falta
// reconocer las fechas dictadas en palabras además del formato con barras
// que se usa al tipear.
const SPANISH_MONTHS = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  setiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
};

function parseSlashDate(text) {
  const m = text.match(/\bel\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/i);
  if (!m) return null;
  const [, d, mo, yRaw] = m;
  const y = yRaw.length === 2 ? `20${yRaw}` : yRaw.padStart(4, "0");
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function parseSpokenDate(text) {
  const monthNames = Object.keys(SPANISH_MONTHS).join("|");
  const re = new RegExp(`\\bel\\s+(\\d{1,2})\\s+de\\s+(${monthNames})(?:\\s+del?\\s+(\\d{4}))?\\b`, "i");
  const m = text.match(re);
  if (!m) return null;

  const [, d, monthName, yRaw] = m;
  const mo = SPANISH_MONTHS[monthName.toLowerCase()];
  const dPad = d.padStart(2, "0");

  if (yRaw) return `${yRaw}-${mo}-${dPad}`;

  // Sin año explícito ("el 30 de septiembre"): asumimos este año, salvo que
  // esa fecha ya haya pasado, en cuyo caso asumimos el año que viene (nadie
  // dicta una fecha de una reunión pasada).
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  let candidate = `${currentYear}-${mo}-${dPad}`;
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (new Date(`${candidate}T00:00:00Z`).getTime() < now.getTime() - oneDayMs) {
    candidate = `${currentYear + 1}-${mo}-${dPad}`;
  }
  return candidate;
}

// "hoy" / "mañana" / "pasado mañana", relativos a la fecha actual en
// Argentina (usa nowInArgentina(), definida más abajo junto a los
// recordatorios). Ojo: "mañana" también significa "AM" en español ("a las
// 9 de la mañana"), así que se excluye ese uso para no interpretar mal una
// hora como si fuera "el día siguiente".
function parseRelativeDate(text) {
  const nowArg = nowInArgentina();
  const addDays = (n) => {
    const d = new Date(nowArg);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  if (/\bhoy\b/i.test(text)) return addDays(0);
  if (/\bpasado\s+ma[nñ]ana\b/i.test(text)) return addDays(2);
  if (/(?<!de\s)(?<!de\sla\s)\bma[nñ]ana\b/i.test(text)) return addDays(1);

  return null;
}

function parseTime(text) {
  const m = text.match(/\ba\s+las?\s+(\d{1,2})(?::(\d{2}))?\s*h?s?\b/i);
  if (!m) return null;
  const [, h, min] = m;
  return `${h.padStart(2, "0")}:${(min || "00").padStart(2, "0")}`;
}

function parseAgendaDateTime(text) {
  const date = parseSlashDate(text) || parseSpokenDate(text) || parseRelativeDate(text);
  const time = parseTime(text);
  return { date, time };
}

function formatAgendaWhen(date, time) {
  const [y, m, d] = date.split("-");
  const datePart = `${d}/${m}/${y}`;
  return time ? `${datePart} ${time}hs` : datePart;
}

async function handleAddAgendaItem(env, text) {
  const existing = await getFileOptional("agenda.json", env.GITHUB_TOKEN);
  const items = existing ? JSON.parse(existing.content) : [];
  const sha = existing ? existing.sha : undefined;

  const nextId = items.reduce((max, it) => Math.max(max, it.id), 0) + 1;
  const { date: eventDate, time: eventTime } = parseAgendaDateTime(text);
  const item = { id: nextId, text, created_at: new Date().toISOString().slice(0, 10) };
  if (eventDate) item.event_date = eventDate;
  if (eventTime) item.event_time = eventTime;

  // Si ya está a menos de 3hs del evento en el momento de cargarlo, no tiene
  // sentido esperar al próximo tick del cron (hasta 2hs) — se manda el
  // recordatorio "horas antes" de una, y se marca como ya notificado para
  // que el chequeo periódico no lo repita.
  const dueNow = isHoursBeforeDue(item);
  if (dueNow) item.notified_hours_before = true;

  items.push(item);

  await putFile(
    "agenda.json",
    JSON.stringify(items, null, 2) + "\n",
    sha,
    `Bot: agregar ítem de agenda #${nextId}`,
    env.GITHUB_TOKEN
  );

  if (dueNow) await broadcastToAllChats(env, formatHoursBeforeMessage(item));

  const when = eventDate ? ` — programado para ${formatAgendaWhen(eventDate, eventTime)}` : "";
  return `Agregado a tu agenda (#${nextId})${when}.`;
}

async function handleRemoveAgendaItem(env, idArg) {
  const id = Number.parseInt(idArg, 10);
  if (!Number.isInteger(id)) return `"${idArg}" no es un número de ítem válido. Usá /miagenda para ver los #id.`;

  const existing = await getFileOptional("agenda.json", env.GITHUB_TOKEN);
  const items = existing ? JSON.parse(existing.content) : [];
  const index = items.findIndex((it) => it.id === id);
  if (index === -1) return `No encontré el ítem #${id} en tu agenda. Usá /miagenda para ver los que hay.`;

  const [removed] = items.splice(index, 1);
  await putFile(
    "agenda.json",
    JSON.stringify(items, null, 2) + "\n",
    existing.sha,
    `Bot: quitar ítem de agenda #${id}`,
    env.GITHUB_TOKEN
  );
  return `Saqué de tu agenda (#${id}): "${removed.text}"`;
}

async function handleListAgenda(env) {
  const existing = await getFileOptional("agenda.json", env.GITHUB_TOKEN);
  const items = existing ? JSON.parse(existing.content) : [];
  if (items.length === 0) return "Tu agenda está vacía. Usá /agendar <texto> para cargar algo.";

  const withDate = items
    .filter((it) => it.event_date)
    .sort((a, b) =>
      `${a.event_date}T${a.event_time || "00:00"}`.localeCompare(`${b.event_date}T${b.event_time || "00:00"}`)
    );
  const withoutDate = items.filter((it) => !it.event_date);

  const lines = ["<b>📋 Tu agenda</b>"];
  for (const it of withDate) {
    lines.push(`• #${it.id} 🗓 ${formatAgendaWhen(it.event_date, it.event_time)} — ${escapeHtml(it.text)}`);
  }
  if (withoutDate.length > 0) {
    if (withDate.length > 0) lines.push("", "<b>Sin fecha:</b>");
    for (const it of withoutDate) {
      lines.push(`• #${it.id} (${it.created_at}) ${escapeHtml(it.text)}`);
    }
  }
  return lines.join("\n");
}

// ---------- Recordatorios de agenda ----------
// Se chequean en el mismo Cron Trigger que dispara el informe (cada 2hs),
// sin infraestructura nueva. Argentina no tiene horario de verano, así que
// el offset UTC-3 es fijo: no hace falta una librería de timezones, alcanza
// con correr la aritmética a mano.

const ARGENTINA_OFFSET_MS = -3 * 60 * 60 * 1000;

function nowInArgentina() {
  return new Date(Date.now() + ARGENTINA_OFFSET_MS);
}

// "Un par de horas antes": due en cualquier momento entre ahora mismo y 3hs
// antes del evento. Sin piso además de "todavía no pasó" a propósito — así
// también sirve para el chequeo inmediato al cargar un ítem (ver
// handleAddAgendaItem), no solo para el cron cada 2hs.
function isHoursBeforeDue(item) {
  if (!item.event_date || !item.event_time || item.notified_hours_before) return false;
  const eventMs = new Date(`${item.event_date}T${item.event_time}:00-03:00`).getTime();
  const hoursUntil = (eventMs - Date.now()) / (60 * 60 * 1000);
  return hoursUntil > 0 && hoursUntil <= 3;
}

function formatHoursBeforeMessage(item) {
  return `<b>⏰ En un par de horas:</b> ${formatAgendaWhen(item.event_date, item.event_time)} — ${escapeHtml(item.text)}`;
}

async function broadcastToAllChats(env, text) {
  for (const chatId of allowedChatIds(env)) {
    await replyTelegram(env, chatId, text, true);
  }
}

async function checkAgendaReminders(env) {
  const existing = await getFileOptional("agenda.json", env.GITHUB_TOKEN);
  if (!existing) return;
  const items = JSON.parse(existing.content);
  if (items.length === 0) return;

  const nowArg = nowInArgentina();
  const todayStr = nowArg.toISOString().slice(0, 10);
  const tomorrow = new Date(nowArg);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const argHour = nowArg.getUTCHours();

  const dayBeforeDue = [];
  const hoursBeforeDue = [];
  let changed = false;

  for (const it of items) {
    if (!it.event_date || it.event_date < todayStr) continue;

    // Resumen del día siguiente: una vez, en la ventana matutina (7-11 ART).
    if (!it.notified_day_before && it.event_date === tomorrowStr && argHour >= 7 && argHour <= 11) {
      dayBeforeDue.push(it);
      it.notified_day_before = true;
      changed = true;
    }

    if (isHoursBeforeDue(it)) {
      hoursBeforeDue.push(it);
      it.notified_hours_before = true;
      changed = true;
    }
  }

  if (dayBeforeDue.length === 0 && hoursBeforeDue.length === 0) return;

  for (const chatId of allowedChatIds(env)) {
    if (dayBeforeDue.length > 0) {
      const lines = ["<b>📅 Mañana en tu agenda:</b>"];
      for (const it of dayBeforeDue) {
        lines.push(`• ${formatAgendaWhen(it.event_date, it.event_time)} — ${escapeHtml(it.text)}`);
      }
      await replyTelegram(env, chatId, lines.join("\n"), true);
    }
    for (const it of hoursBeforeDue) {
      await replyTelegram(env, chatId, formatHoursBeforeMessage(it), true);
    }
  }

  if (changed) {
    await putFile(
      "agenda.json",
      JSON.stringify(items, null, 2) + "\n",
      existing.sha,
      "Bot: marcar recordatorios de agenda enviados",
      env.GITHUB_TOKEN
    );
  }
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

async function replyTelegram(env, chatId, text, html = false) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = new URLSearchParams({ chat_id: chatId, text });
  if (html) body.set("parse_mode", "HTML");
  const res = await fetch(url, { method: "POST", body });
  if (!res.ok) throw new Error(`sendMessage falló: ${res.status} ${await res.text()}`);
}

// TELEGRAM_CHAT_ID acepta uno o varios chat_id separados por coma (ej. tu
// chat personal + el de un grupo), para poder usar el bot desde más de un
// chat sin abrirlo a cualquiera.
function allowedChatIds(env) {
  return String(env.TELEGRAM_CHAT_ID)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

// Descarga un mensaje de voz de Telegram y lo transcribe con el modelo
// Whisper de Cloudflare Workers AI (binding "AI" en wrangler.toml). Devuelve
// el texto transcripto (puede ser "" si Whisper no reconoció nada).
async function transcribeVoice(env, fileId) {
  const fileInfoRes = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  if (!fileInfoRes.ok) throw new Error(`getFile falló: ${fileInfoRes.status}`);
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo.result.file_path;

  const audioRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!audioRes.ok) throw new Error(`descarga del audio falló: ${audioRes.status}`);
  const audioBuffer = await audioRes.arrayBuffer();

  const result = await env.AI.run("@cf/openai/whisper", {
    audio: [...new Uint8Array(audioBuffer)],
  });
  return (result.text || "").trim();
}

async function handleTelegramWebhook(request, env) {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await request.json();
  const message = update.message;
  if (!message || !message.chat) return new Response("ok");

  const chatId = String(message.chat.id);
  console.log(
    `mensaje de chat_id=${chatId} tipo=${message.chat.type} texto=${JSON.stringify(message.text)} voice=${!!message.voice}`
  );
  if (!allowedChatIds(env).includes(chatId)) return new Response("ignored");

  if (message.voice) {
    try {
      const transcript = await transcribeVoice(env, message.voice.file_id);
      if (!transcript) {
        await replyTelegram(env, chatId, "No pude transcribir el audio (vino vacío). Probá de nuevo o mandalo por texto.");
      } else {
        const added = await handleAddAgendaItem(env, transcript);
        await replyTelegram(env, chatId, `🎙 "${transcript}"\n\n${added}`);
      }
    } catch (err) {
      await replyTelegram(env, chatId, `Uh, no pude procesar el audio: ${err.message}`);
    }
    return new Response("ok");
  }

  if (typeof message.text !== "string") return new Response("ok");

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
        await replyTelegram(env, chatId, HELP_TEXT);
        break;
      case "/keywords":
        await replyTelegram(env, chatId, await describeConfig(env), true);
        break;
      case "/eventos":
        await replyTelegram(env, chatId, formatEventsReply(await fetchMunicipalEvents()), true);
        break;
      case "/agregar":
        await replyTelegram(env, chatId, arg ? await handleAddKeyword(env, arg) : "Uso: /agregar <palabra clave>");
        break;
      case "/quitar":
        await replyTelegram(env, chatId, arg ? await handleRemoveKeyword(env, arg) : "Uso: /quitar <palabra clave>");
        break;
      case "/agendar":
        await replyTelegram(env, chatId, arg ? await handleAddAgendaItem(env, arg) : "Uso: /agendar <texto>");
        break;
      case "/miagenda":
        await replyTelegram(env, chatId, await handleListAgenda(env), true);
        break;
      case "/desagendar":
        await replyTelegram(env, chatId, arg ? await handleRemoveAgendaItem(env, arg) : "Uso: /desagendar <id>");
        break;
      case "/limpiar":
        await replyTelegram(env, chatId, await handleClearCache(env));
        break;
      case "/informe":
        await dispatchWorkflow("daily-report.yml", env.GITHUB_TOKEN);
        await replyTelegram(env, chatId, "Generando el informe, te llega en un momento…");
        break;
      default:
        await replyTelegram(env, chatId, `No reconozco ese comando.\n\n${HELP_TEXT}`);
    }
  } catch (err) {
    await replyTelegram(env, chatId, `Uh, algo falló procesando el comando: ${err.message}`);
  }

  return new Response("ok");
}

// ---------- Entry points ----------

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "0 */2 * * *") {
      ctx.waitUntil(dispatchWorkflow("daily-report.yml", env.GITHUB_TOKEN));
      ctx.waitUntil(checkAgendaReminders(env));
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
