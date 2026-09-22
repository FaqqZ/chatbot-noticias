/**
 * Dispara los workflows de GitHub Actions del monitor de noticias a horario
 * exacto, vía la API de GitHub (workflow_dispatch), porque el `schedule`
 * propio de GitHub Actions no es confiable (puede demorar minutos u horas,
 * sobre todo con crons frecuentes como "cada 5 minutos").
 */

const OWNER = "FaqqZ";
const REPO = "chatbot-noticias";

const WORKFLOWS_BY_CRON = {
  "0 10 * * *": "daily-report.yml",
  "* * * * *": "bot-interact.yml",
};

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
    body: JSON.stringify({ ref: "main" }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error ${response.status} para ${workflowFile}: ${body}`);
  }
}

export default {
  async scheduled(event, env, ctx) {
    const workflowFile = WORKFLOWS_BY_CRON[event.cron];
    if (!workflowFile) {
      console.log(`Cron desconocido: ${event.cron}`);
      return;
    }
    ctx.waitUntil(dispatchWorkflow(workflowFile, env.GITHUB_TOKEN));
  },

  // Permite probar manualmente: <worker-url>/?workflow=daily-report.yml
  async fetch(request, env) {
    const url = new URL(request.url);
    const workflowFile = url.searchParams.get("workflow");
    const validWorkflows = Object.values(WORKFLOWS_BY_CRON);
    if (!workflowFile || !validWorkflows.includes(workflowFile)) {
      return new Response(`Uso: ?workflow=${validWorkflows.join(" o ?workflow=")}`, { status: 400 });
    }
    try {
      await dispatchWorkflow(workflowFile, env.GITHUB_TOKEN);
      return new Response(`Disparado ${workflowFile}`);
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  },
};
