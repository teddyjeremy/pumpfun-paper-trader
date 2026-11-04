import Fastify from "fastify";
import { config } from "./config.js";
import { diagnose, increment, snapshot } from "./diagnostics/registry.js";

const app = Fastify({
  logger: { level: config.LOG_LEVEL, redact: ["*.HELIUS_API_KEY", "*.apiKey", "*.secret", "*.authorization"] }
});

app.get("/health", async () => ({
  status: "ok",
  mode: "paper",
  uptimeSeconds: Math.floor(process.uptime()),
  timestamp: new Date().toISOString()
}));

app.get("/ready", async (_request, reply) => {
  const state = snapshot().readiness;
  if (!state.ready) return reply.code(503).send({ ready: false, blockers: state.blockers });
  return { ready: true, blockers: [] };
});

app.get("/api/diagnostics", async () => ({
  ...snapshot(),
  diagnosis: diagnose(),
  process: {
    uptimeSeconds: Math.floor(process.uptime()),
    memoryBytes: process.memoryUsage().rss,
    nodeVersion: process.version
  }
}));

app.get("/api/results/summary", async () => {
  const state = snapshot();
  const counters = state.counters;
  return {
    mode: "paper",
    portfolio: {
      startingBalanceUsd: config.PAPER_STARTING_BALANCE_USD,
      positionSizeUsd: config.PAPER_POSITION_SIZE_USD,
      maxOpenPositions: config.PAPER_MAX_OPEN_POSITIONS,
      maxAllocatedUsd: config.PAPER_POSITION_SIZE_USD * config.PAPER_MAX_OPEN_POSITIONS,
      realizedNetPnlUsd: null,
      openPositions: null,
      note: "Portfolio ledger is not connected yet; PnL is intentionally null, not guessed."
    },
    activity: {
      discovered: counters["candidate.discovered"] ?? 0,
      rejected: counters["candidate.rejected"] ?? 0,
      quoteSuccess: counters["quote.success"] ?? 0,
      quoteFailure: (counters["failure.quote_missing"] ?? 0) + (counters["failure.quote_stale"] ?? 0) + (counters["failure.quote_cost"] ?? 0),
      paperEntries: counters["paper.entry"] ?? 0,
      paperExits: counters["paper.exit"] ?? 0
    },
    diagnosis: diagnose()
  };
});

app.get("/", async (_request, reply) => reply.type("text/html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pump.fun Paper Trader</title>
<style>
:root{color-scheme:dark;font:15px system-ui;background:#0b1020;color:#e7ecf5}body{margin:0;padding:28px;max-width:1100px;margin:auto}
h1{font-size:26px}p,.muted{color:#9ba8bd}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
section{background:#141d31;border:1px solid #293650;border-radius:12px;padding:18px;margin:14px 0}
strong{font-size:24px;display:block;margin-top:8px}.status{color:#f6c76b}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#c9d6eb}
a{color:#8cbcff}button{background:#263a5d;color:white;border:0;padding:9px 13px;border-radius:8px;cursor:pointer}
</style></head><body><h1>Pump.fun Paper Trader</h1><p>Paper mode only · Pump.fun bonding curve only · no wallet signing</p>
<div class="grid"><section>Starting balance<strong>$8.00</strong></section><section>Position size<strong>$1.00</strong></section><section>Maximum positions<strong>3</strong></section><section>Live readiness<strong id="ready" class="status">Checking…</strong></section></div>
<section><h2>System diagnosis</h2><p id="diagnosis" class="muted">Loading diagnostics…</p><pre id="blockers"></pre></section>
<section><h2>Activity & results</h2><pre id="results">Loading…</pre></section>
<section><h2>Recent failures</h2><pre id="failures">Loading…</pre></section>
<p class="muted">Refreshes every 5 seconds. A missing metric is shown as unavailable, never as zero profit.</p>
<script>
async function refresh(){try{
 const [d,r]=await Promise.all([fetch('/api/diagnostics').then(x=>x.json()),fetch('/api/results/summary').then(x=>x.json())]);
 document.querySelector('#ready').textContent=d.readiness.ready?'READY':'NOT READY';
 document.querySelector('#diagnosis').textContent=d.diagnosis.status+' — '+d.diagnosis.notes.join(' ');
 document.querySelector('#blockers').textContent='Blockers: '+d.readiness.blockers.join(' | ')+'\n\nTop failure categories:\n'+JSON.stringify(d.diagnosis.topFailures,null,2);
 document.querySelector('#results').textContent=JSON.stringify(r,null,2);
 document.querySelector('#failures').textContent=JSON.stringify(d.failures.slice(0,20),null,2);
 }catch(e){document.querySelector('#diagnosis').textContent='Dashboard API unavailable: '+e}}
refresh();setInterval(refresh,5000);
</script></body></html>`));

app.addHook("onReady", async () => {
  increment("service.started");
  app.log.info({ mode: "paper", ready: false }, "Service started in safe degraded mode; live adapters are not connected");
});

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
