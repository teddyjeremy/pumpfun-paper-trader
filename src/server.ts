import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { authorizeDashboardRequest } from "./dashboard-auth.js";
import { config } from "./config.js";
import { diagnose, increment, snapshot } from "./diagnostics/registry.js";
import { trackingSnapshot } from "./diagnostics/tracker.js";
import {
  acquireWorkerLease, heartbeatWorkerLease, persistPaperAuditEvents,
  releaseWorkerLease, getPersistenceStatus, getTradingDashboardSnapshot, getPaperSessionLedgerSnapshot,
  persistHeliusBackfillArchive, getHeliusBackfillReplayDataset,
  getHeliusBackfillDashboardSnapshot
} from "./persistence/postgres.js";
import { fetchSolUsdPrice } from "./ingestion/sol-usd-price.js";
import {
  calibrateVolumeThresholds, hydrateArchivedVerifiedTransaction, replayHistoricalCoin
} from "./strategy/historical-replay.js";

export const app = Fastify({
  logger: { level: config.LOG_LEVEL, redact: ["*.HELIUS_API_KEY", "*.apiKey", "*.secret", "*.authorization"] }
});
// The read-only dashboard exposes private candidate, trade and portfolio data.
// Liveness/readiness stay public; every other route requires HTTP Basic auth
// in production. Missing production credentials fail closed.
app.addHook("onRequest", async (request, reply) => {
  const pathname = request.url.split("?")[0];
  if (pathname === "/health" || pathname === "/ready") return;
  if (pathname === "/internal/paper-events" || pathname === "/internal/worker-lease" || pathname === "/internal/helius-backfill") {
    const expected = config.PAPER_EVENT_INGEST_TOKEN;
    if (!expected) return reply.code(503).send({ error: "Internal ingestion authentication is not configured." });
    const authorization = request.headers.authorization ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return reply.code(401).send({ error: "Internal service authentication required." });
    }
    return;
  }
  const result = authorizeDashboardRequest({
    authorization: request.headers.authorization ?? null,
    username: config.DASHBOARD_USERNAME,
    password: config.DASHBOARD_PASSWORD,
    production: config.NODE_ENV === "production"
  });
  if (result === "ALLOW") return;
  if (result === "NOT_CONFIGURED") {
    return reply.code(503).send({ error: "Dashboard authentication is not configured." });
  }
  return reply.header("WWW-Authenticate", 'Basic realm="Pump.fun Paper Trader", charset="UTF-8"')
    .code(401).send({ error: "Authentication required." });
});



app.post("/internal/paper-events", async (request, reply) => {
  const body = request.body && typeof request.body === "object"
    ? request.body as Record<string, unknown> : {};
  const sessionId = body.sessionId;
  const events = body.events;
  if (typeof sessionId !== "string" || !sessionId.trim() ||
      !Array.isArray(events) || events.length === 0 || events.length > 100) {
    return reply.code(400).send({ error: "sessionId and 1-100 ordered events are required." });
  }
  try {
    const result = await persistPaperAuditEvents(sessionId, events as never[]);
    return { ok: true, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const conflict = message.includes("sequence") || message.includes("replay");
    return reply.code(conflict ? 409 : 503).send({
      error: conflict ? message : "Paper event persistence failed; the sender should retry."
    });
  }
});

app.post("/internal/helius-backfill", async (request, reply) => {
  const body = request.body && typeof request.body === "object"
    ? request.body as Record<string, unknown> : {};
  if (typeof body.sessionId !== "string" || typeof body.mint !== "string" ||
      !body.state || typeof body.state !== "object" ||
      !body.decodeCoverage || typeof body.decodeCoverage !== "object") {
    return reply.code(400).send({ error: "sessionId, mint, backfill state and decode coverage are required." });
  }
  try {
    await persistHeliusBackfillArchive(body as never);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const conflict = message.includes("conflicts") || message.includes("invalid");
    return reply.code(conflict ? 409 : 503).send({
      error: conflict ? message : "Helius archive persistence failed; the sender should retry."
    });
  }
});

app.post("/internal/worker-lease", async (request, reply) => {
  const body = request.body && typeof request.body === "object"
    ? request.body as Record<string, unknown> : {};
  const { action, leaseName, ownerId, ttlSeconds } = body;
  if ((action !== "acquire" && action !== "heartbeat" && action !== "release") ||
      typeof leaseName !== "string" || typeof ownerId !== "string") {
    return reply.code(400).send({ error: "action, leaseName and ownerId are required." });
  }
  try {
    if (action === "acquire") {
      return await acquireWorkerLease(leaseName, ownerId, typeof ttlSeconds === "number" ? ttlSeconds : 45);
    }
    if (action === "heartbeat") {
      return await heartbeatWorkerLease(leaseName, ownerId, typeof ttlSeconds === "number" ? ttlSeconds : 45);
    }
    return { released: await releaseWorkerLease(leaseName, ownerId) };
  } catch {
    return reply.code(503).send({ error: "Worker lease persistence is unavailable." });
  }
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

app.get("/api/tracking", async () => trackingSnapshot());
app.get("/api/persistence", async () => getPersistenceStatus());
app.get("/api/worker", async (_request, reply) => {
  if (!config.PAPER_WORKER_URL) {
    return { configured: false, canControl: false, connected: false, enabled: false, tradingReady: false,
      blocker: "Configure PAPER_WORKER_URL on the server to connect the Cloudflare monitor." };
  }
  const canControl = Boolean(config.PAPER_WORKER_CONTROL_TOKEN);
  try {
    const response = await fetch(new URL(canControl ? "/dashboard" : "/health", config.PAPER_WORKER_URL), {
      headers: canControl ? { authorization: `Bearer ${config.PAPER_WORKER_CONTROL_TOKEN}` } : {},
      signal: AbortSignal.timeout(5_000), cache: "no-store"
    });
    if (!response.ok) return reply.code(502).send({ configured: true, canControl, connected: false,
      enabled: false, tradingReady: false, blocker: `Worker status request failed (HTTP ${response.status}).` });
    const snapshot = await response.json() as Record<string, unknown>;
    if (canControl) return { configured: true, canControl: true, connected: true, ...snapshot };
    return {
      configured: true, canControl: false, connected: true, status: snapshot,
      candidates: [], recentActivity: [],
      blocker: "Cloudflare Worker is connected in read-only mode. Add PAPER_WORKER_CONTROL_TOKEN to enable candidate details and monitor controls."
    };
  } catch {
    return reply.code(502).send({ configured: true, canControl, connected: false, enabled: false,
      tradingReady: false, blocker: "Cloudflare Worker is unreachable; no trading state is assumed." });
  }
});

app.post("/api/worker/start-monitor", async (_request, reply) => {
  if (!config.PAPER_WORKER_URL || !config.PAPER_WORKER_CONTROL_TOKEN)
    return reply.code(503).send({ error: "Cloudflare Worker URL and control token are not configured." });
  try {
    const response = await fetch(new URL("/start", config.PAPER_WORKER_URL), {
      method: "POST", headers: { authorization: `Bearer ${config.PAPER_WORKER_CONTROL_TOKEN}` },
      signal: AbortSignal.timeout(10_000)
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return reply.code(502).send({ error: `Worker rejected monitor start (HTTP ${response.status}).` });
    return { ok: true, monitorStarted: true, paperExecutionEnabled: false, worker: body };
  } catch { return reply.code(502).send({ error: "Could not start the Cloudflare discovery monitor." }); }
});

app.post("/api/worker/stop-monitor", async (_request, reply) => {
  if (!config.PAPER_WORKER_URL || !config.PAPER_WORKER_CONTROL_TOKEN)
    return reply.code(503).send({ error: "Cloudflare Worker URL and control token are not configured." });
  try {
    const response = await fetch(new URL("/stop", config.PAPER_WORKER_URL), {
      method: "POST", headers: { authorization: `Bearer ${config.PAPER_WORKER_CONTROL_TOKEN}` },
      signal: AbortSignal.timeout(10_000)
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return reply.code(502).send({ error: `Worker rejected monitor stop (HTTP ${response.status}).` });
    return { ok: true, monitorStopped: true, worker: body };
  } catch { return reply.code(502).send({ error: "Could not stop the Cloudflare discovery monitor." }); }
});

app.get("/api/portfolio", async () => getTradingDashboardSnapshot());
app.get("/api/paper-ledger", async request => {
  const sessionId = (request.query as Record<string, unknown>).sessionId;
  return getPaperSessionLedgerSnapshot(typeof sessionId === "string" ? sessionId : undefined);
});

app.get("/api/helius/backfills", async (request, reply) => {
  const sessionId = (request.query as Record<string, unknown>).sessionId;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return reply.code(400).send({ error: "sessionId is required." });
  }
  try {
    return { sessionId, backfills: await getHeliusBackfillDashboardSnapshot(sessionId) };
  } catch {
    return reply.code(503).send({ error: "Historical backfill archive is unavailable; verify database migrations and connectivity." });
  }
});

app.get("/api/strategy/replay", async (request, reply) => {
  const query = request.query as Record<string, unknown>;
  const sessionId = query.sessionId;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return reply.code(400).send({ error: "sessionId is required." });
  }
  const parseOptionalPercent = (value: unknown): number | undefined => {
    if (typeof value !== "string" || value.trim() === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10_000 ? parsed : undefined;
  };
  const minFavorableExcursionPct = parseOptionalPercent(query.minFavorableExcursionPct);
  const maxAdverseExcursionPct = parseOptionalPercent(query.maxAdverseExcursionPct);
  const roundTripCostPct = parseOptionalPercent(query.roundTripCostPct);
  const anyOutcomeThreshold = query.minFavorableExcursionPct !== undefined ||
    query.maxAdverseExcursionPct !== undefined;
  if ((query.minFavorableExcursionPct !== undefined && minFavorableExcursionPct === undefined) ||
      (query.maxAdverseExcursionPct !== undefined && maxAdverseExcursionPct === undefined) ||
      (query.roundTripCostPct !== undefined && roundTripCostPct === undefined) ||
      (anyOutcomeThreshold && (minFavorableExcursionPct === undefined || maxAdverseExcursionPct === undefined || roundTripCostPct === undefined)) ||
      (minFavorableExcursionPct !== undefined && minFavorableExcursionPct <= 0) ||
      (roundTripCostPct !== undefined && !anyOutcomeThreshold)) {
    return reply.code(400).send({ error: "Supply both valid outcome excursion thresholds and an explicit round-trip cost to assign profitability labels." });
  }
  try {
    const price = await fetchSolUsdPrice();
    if (price.status !== "AVAILABLE") {
      return reply.code(503).send({ error: "Fresh SOL/USD reference unavailable; replay micro-trade filtering is blocked." });
    }
    const rows = await getHeliusBackfillReplayDataset(sessionId);
    const label = minFavorableExcursionPct !== undefined &&
      maxAdverseExcursionPct !== undefined && roundTripCostPct !== undefined
      ? {
          minFavorableExcursionPct,
          maxAdverseExcursionPct,
          roundTripCostPct: roundTripCostPct as number
        }
      : undefined;
    const replays = rows.map(row => {
      if (row.launchBlockTime === null) {
        return {
          mint: row.mint, launchBlockTime: 0, horizonSeconds: row.horizonSeconds,
          decodeComplete: false,
          decodeReason: row.decodedReason ?? row.reason ?? "Verified launch block time is unavailable.",
          verifiedTransactionCount: row.verifiedTransactionCount, verifiedTradeCount: 0,
          snapshots: [], firstSetup: null, outcome: null, status: "INCOMPLETE" as const
        };
      }
      const transactions = row.transactions.map(hydrateArchivedVerifiedTransaction);
      return replayHistoricalCoin({
        mint: row.mint, transactions, launchBlockTime: row.launchBlockTime,
        horizonSeconds: row.horizonSeconds, decodeComplete: row.decodedComplete,
        decodeReason: row.decodedReason ?? row.reason
      }, {
        solUsdPriceUsd: price.observation.priceUsd,
        minimumTradeUsd: 0.01,
        horizonSeconds: row.horizonSeconds,
        ...(label ? { label } : {})
      });
    });
    return {
      sessionId,
      solUsdReference: price.observation,
      replayCount: replays.length,
      replays,
      calibration: calibrateVolumeThresholds(replays),
      interpretation: "This is historical reserve-price and rule-evidence replay, not an executable-fill simulation. Volume thresholds are not promoted automatically; incomplete decoding remains unlabelled."
    };
  } catch (error) {
    request.log.error({ error }, "Historical strategy replay failed");
    return reply.code(503).send({ error: "Historical replay could not be completed; archived evidence may be incomplete or migrations unavailable." });
  }
});


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

const dashboardHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#090d18"><title>Pump.fun Paper Trader · Control Room</title>
<style>
:root{color-scheme:dark;--bg:#090d18;--panel:#111827;--panel2:#151f31;--line:#263449;--muted:#8b9ab1;--text:#e8eef8;--blue:#76a9ff;--green:#62d6a5;--amber:#f4c66d;--red:#ff818b;font:14px Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 15% -10%,#1b2b48 0,transparent 42%),var(--bg);color:var(--text)}
header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px clamp(18px,4vw,54px);border-bottom:1px solid var(--line);background:#0b1120d9;position:sticky;top:0;z-index:2;backdrop-filter:blur(14px)}
.brand{display:flex;align-items:center;gap:12px}.mark{width:38px;height:38px;border-radius:12px;background:linear-gradient(145deg,#8bb7ff,#345caa);display:grid;place-items:center;color:#07101f;font-weight:900;font-size:18px}
h1{font-size:16px;letter-spacing:.2px;margin:0}.sub{color:var(--muted);font-size:12px;margin-top:3px}
.actions{display:flex;align-items:center;gap:12px}.pill{border:1px solid var(--line);border-radius:99px;padding:7px 11px;color:var(--muted);font-size:12px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--amber);margin-right:7px}.dot.good{background:var(--green)}.dot.bad{background:var(--red)}
button{background:#1b2b45;color:var(--text);border:1px solid #334966;border-radius:9px;padding:8px 12px;cursor:pointer}button:hover{background:#243a5c}
main{max-width:1440px;margin:auto;padding:26px clamp(16px,4vw,54px) 60px}.intro{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:20px}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:1.6px;color:var(--blue);font-weight:700}h2{font-size:19px;margin:5px 0}.muted{color:var(--muted)}.small{font-size:12px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px}.panel{background:linear-gradient(160deg,#141e30,#101827);border:1px solid var(--line);border-radius:14px;padding:17px;min-width:0}.metric-label{font-size:12px;color:var(--muted)}.metric{font-size:27px;font-weight:700;letter-spacing:-.8px;margin:8px 0 4px}.metric-note{font-size:11px;color:var(--muted)}
.section{margin-top:18px}.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.section-head h3{font-size:14px;margin:0}.two{display:grid;grid-template-columns:1.15fr .85fr;gap:14px}.three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.status-card{display:flex;align-items:center;gap:12px}.status-icon{width:36px;height:36px;border-radius:11px;background:#26364e;display:grid;place-items:center;color:var(--blue);font-weight:800}.status-title{font-weight:650}.status-detail{font-size:12px;color:var(--muted);margin-top:3px}
.bar-row{display:grid;grid-template-columns:105px 1fr 38px;gap:10px;align-items:center;margin:12px 0;font-size:12px}.track{height:8px;border-radius:99px;background:#253146;overflow:hidden}.fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#497ac9,#8cb8ff);width:0}
.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}th{text-align:left;color:var(--muted);font-weight:600;padding:10px;border-bottom:1px solid var(--line)}td{padding:11px 10px;border-bottom:1px solid #202c3e;white-space:nowrap}tr:last-child td{border-bottom:0}.tag{display:inline-block;padding:4px 8px;border-radius:99px;background:#25344b;color:#b8d0f7;font-size:10px}.tag.warn{background:#49391f;color:#f5d28a}.tag.bad{background:#49272e;color:#ffabb2}.tag.good{background:#1d4038;color:#8ee6c2}
.list{display:flex;flex-direction:column;gap:9px}.list-item{display:flex;justify-content:space-between;gap:12px;font-size:12px;padding-bottom:9px;border-bottom:1px solid #202c3e}.list-item:last-child{border:0;padding-bottom:0}
.empty{padding:22px;text-align:center;color:var(--muted);font-size:12px}.foot{margin-top:22px;color:var(--muted);font-size:11px;display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap}
@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.two,.three{grid-template-columns:1fr}}
@media(max-width:520px){header{align-items:flex-start}.actions{flex-direction:column;align-items:flex-end}.intro{align-items:flex-start;flex-direction:column}.grid{gap:9px}.panel{padding:13px}.metric{font-size:23px}}
</style></head><body>
<header><div class="brand"><div class="mark">P</div><div><h1>Pump.fun Paper Trader</h1><div class="sub">Bonding-curve research · paper execution only</div></div></div>
<div class="actions"><span class="pill"><span class="dot" id="healthDot"></span><span id="healthText">Connecting</span></span><button id="refresh">Refresh</button></div></header>
<main>
<div class="intro"><div><div class="eyebrow">Operations / overview</div><h2>Trading control room</h2><div class="muted small">Observe discovery, screening, execution quality and system health.</div></div><div class="pill">PAPER MODE · NO WALLET SIGNING · NO REAL ORDERS</div></div>
<div class="section panel"><div class="section-head"><h3>Live market monitor</h3><span class="tag warn" id="workerTag">NOT CONNECTED</span></div>
<div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
<div><div class="metric-label">PumpPortal</div><div class="metric" id="workerPump">—</div></div>
<div><div class="metric-label">Helius</div><div class="metric" id="workerHelius">—</div></div>
<div><div class="metric-label">Monitored candidates</div><div class="metric" id="workerCandidates">—</div></div>
<div><div class="metric-label">Verified transactions</div><div class="metric" id="workerVerified">—</div></div></div>
<div class="metric-note" id="workerBlocker">Worker connection has not been configured.</div>
<div class="actions" style="margin-top:14px;justify-content:flex-start"><button id="startMonitor">Start live market monitor</button><button id="stopMonitor">Stop monitor</button><span class="tag warn" id="paperExecutionState">PAPER EXECUTION DISABLED</span></div>
<div class="metric-note" style="margin-top:9px">This starts live launch discovery and evidence collection only. It cannot create simulated fills; automated paper entry/exit integration is not complete.</div></div>
<div class="section panel"><div class="section-head"><h3>Live launch candidates</h3><span class="muted small">From the Worker discovery store</span></div><div class="table-wrap"><table><thead><tr><th>Mint</th><th>Discovery state</th><th>Observations</th><th>First seen</th><th>Last seen</th></tr></thead><tbody id="workerCandidateRows"><tr><td colspan="5" class="empty">Waiting for Worker connection</td></tr></tbody></table></div></div>
<div class="section panel"><div class="section-head"><h3>Live strategy and execution events</h3><span class="muted small">Latest audited Worker events</span></div><div class="table-wrap"><table><thead><tr><th>Time</th><th>Mint</th><th>Event</th><th>Summary</th></tr></thead><tbody id="workerActivityRows"><tr><td colspan="4" class="empty">No live events yet</td></tr></tbody></table></div></div>
<div class="grid">
<section class="panel"><div class="metric-label">Starting paper balance</div><div class="metric" id="startingBalance">—</div><div class="metric-note">Configured initial paper equity</div></section>
<section class="panel"><div class="metric-label">Position principal</div><div class="metric" id="positionPrincipal">—</div><div class="metric-note" id="positionCapacity">Loading portfolio policy…</div></section>
<section class="panel"><div class="metric-label">Realized net PnL</div><div class="metric" id="pnl">—</div><div class="metric-note" id="pnlNote">Waiting for persistent trade ledger</div></section>
<section class="panel"><div class="metric-label">Open positions</div><div class="metric" id="openPositions">—</div><div class="metric-note">Slot releases require zero-balance confirmation</div></section>
</div>
<div class="section two">
<section class="panel"><div class="section-head"><h3>System diagnosis</h3><span class="tag warn" id="readyTag">NOT READY</span></div>
<div class="status-card"><div class="status-icon">!</div><div><div class="status-title" id="diagnosis">Waiting for diagnostics</div><div class="status-detail" id="diagnosisDetail">Checking service health and configured adapters</div></div></div>
<div class="section"><div class="metric-label">Readiness blockers</div><div id="blockers" class="list"><div class="empty">Loading…</div></div></div></section>
<section class="panel"><div class="section-head"><h3>Opportunity funnel</h3><span class="muted small" id="funnelTotal">0 candidates</span></div><div id="funnel"><div class="empty">No candidate telemetry yet</div></div></section>
</div>
<div class="section two">
<section class="panel"><div class="section-head"><h3>Rejection reasons</h3><span class="muted small">Most frequent first</span></div><div id="rejections" class="list"><div class="empty">No rejection data yet</div></div></section>
<section class="panel"><div class="section-head"><h3>Quote quality</h3><span class="muted small">Pump.fun curve quotes only</span></div><div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
<div><div class="metric-label">Successful</div><div class="metric" id="quoteSuccess">0</div></div><div><div class="metric-label">Missing / stale</div><div class="metric" id="quoteFailed">0</div></div><div><div class="metric-label">Cost rejected</div><div class="metric" id="quoteCost">0</div></div><div><div class="metric-label">Sellability failures</div><div class="metric" id="quoteSell">0</div></div></div>
<div class="section"><div class="metric-label">Average observed round-trip cost</div><div class="metric" id="roundTrip">—</div></div></section>
</div>
<div class="section three">
<section class="panel"><div class="section-head"><h3>Provider health</h3></div><div class="metric" id="providerState">Not connected</div><div class="metric-note" id="providerLag">No provider telemetry</div></section>
<section class="panel"><div class="section-head"><h3>Migration monitor</h3></div><div class="metric" id="graduationCount">0</div><div class="metric-note" id="graduationDetail">Approaching / graduated / migrated verified / exit blocked</div></section>
<section class="panel"><div class="section-head"><h3>Execution latency</h3></div><div class="list" id="latency"><div class="empty">No samples yet</div></div></section>
</div>
<div class="section panel"><div class="section-head"><h3>Database persistence</h3><span class="tag warn" id="dbTag">CHECKING</span></div><div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div><div class="metric-label">PostgreSQL</div><div class="metric" id="dbConnected">—</div></div><div><div class="metric-label">Schema</div><div class="metric" id="dbSchema">—</div></div><div><div class="metric-label">Migration</div><div class="metric" id="dbMigration">—</div></div></div><div class="metric-note" id="dbNote">Connection status is checked without exposing credentials.</div></div>
<div class="section panel"><div class="section-head"><h3>Recent candidates</h3><span class="muted small">Latest 100 tracked records</span></div><div class="table-wrap"><table><thead><tr><th>Mint</th><th>Stage</th><th>Decision</th><th>Risk</th><th>Momentum</th><th>Round-trip cost</th><th>Updated</th></tr></thead><tbody id="candidates"><tr><td colspan="7" class="empty">No candidate records yet</td></tr></tbody></table></div></div>
<div class="section panel"><div class="section-head"><h3>Positions</h3><span class="muted small">Paper positions only</span></div><div class="table-wrap"><table><thead><tr><th>Mint</th><th>State</th><th>Market phase</th><th>Venue</th><th>Entry cost</th><th>Exit value</th><th>Fees</th><th>Net PnL</th><th>Zero balance</th></tr></thead><tbody id="positions"><tr><td colspan="9" class="empty">No paper positions recorded</td></tr></tbody></table></div></div>
<div class="section panel"><div class="section-head"><h3>Ledger portfolio · realized and unrealized</h3><span class="tag warn" id="ledgerTag">LEDGER CHECKING</span></div>
<div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
<div><div class="metric-label">Realized PnL · SOL</div><div class="metric" id="ledgerRealizedSol">—</div></div>
<div><div class="metric-label">Realized PnL · USD</div><div class="metric" id="ledgerRealizedUsd">—</div></div>
<div><div class="metric-label">Unrealized PnL · SOL</div><div class="metric" id="ledgerUnrealizedSol">—</div></div>
<div><div class="metric-label">Unrealized PnL · USD</div><div class="metric" id="ledgerUnrealizedUsd">Unavailable</div></div></div>
<div class="metric-note" id="ledgerValuationNote">USD unrealized valuation requires a fresh, persisted SOL/USD oracle price. Open-position SOL values require a fresh full-size sell quote.</div></div>
<div class="section panel"><div class="section-head"><h3>Open paper positions · contract addresses</h3><span class="muted small">Full CA is copyable; values are not chart-price estimates</span></div>
<div class="table-wrap"><table><thead><tr><th>Token / CA</th><th>Status</th><th>Market</th><th>Token quantity</th><th>Entry principal</th><th>Exit quote</th><th>Unrealized PnL</th><th>Last sell quote</th><th>Stop</th></tr></thead><tbody id="ledgerPositions"><tr><td colspan="9" class="empty">Waiting for persistent ledger</td></tr></tbody></table></div></div>
<div class="section panel"><div class="section-head"><h3>Trade history</h3><span class="muted small">Latest 200 persisted paper fills</span></div>
<div class="table-wrap"><table><thead><tr><th>Time</th><th>Token / CA</th><th>Side</th><th>Token quantity</th><th>Value · USD / SOL</th><th>Fees · USD / SOL</th><th>Impact</th><th>Slippage</th><th>Profile</th><th>Latency / quote age</th></tr></thead><tbody id="ledgerTrades"><tr><td colspan="10" class="empty">No persisted paper trades</td></tr></tbody></table></div></div>
<div class="section panel"><div class="section-head"><h3>Closed positions · realized results</h3><span class="muted small">A position is closed only after zero token balance is confirmed</span></div>
<div class="table-wrap"><table><thead><tr><th>Closed</th><th>Token / CA</th><th>Principal · SOL</th><th>Gross PnL · SOL</th><th>Costs · SOL</th><th>Net PnL · SOL</th><th>Net PnL · USD</th><th>Exit reason</th><th>Zero balance</th></tr></thead><tbody id="ledgerClosed"><tr><td colspan="9" class="empty">No closed paper positions</td></tr></tbody></table></div></div>
<div class="foot"><span>Auto-refresh every 5 seconds · All values are telemetry, not trading advice.</span><span id="updatedAt">Last updated —</span></div>
</main>
<script>
const $=s=>document.querySelector(s);
const money=v=>v===null||v===undefined?'—':'$'+Number(v).toFixed(4);
const pct=v=>v===null||v===undefined?'—':Number(v).toFixed(2)+'%';
const num=v=>v===null||v===undefined?'—':Number(v).toLocaleString();
const short=v=>!v?'—':String(v).length>15?String(v).slice(0,6)+'…'+String(v).slice(-5):String(v);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tag=(v)=>'<span class="tag '+(v==='reject'||v==='exit_unexecutable'?'bad':v==='open'||v==='open_migrated'||v==='migrated_market'||v==='paper_entry'?'good':v==='watch'||v==='sell_pending'||v==='migration_pending'||v==='exit_blocked'?'warn':'')+'">'+esc(v||'unknown')+'</span>';
function bars(obj){const entries=Object.entries(obj||{});const max=Math.max(1,...entries.map(x=>Number(x[1])||0));return entries.map(([k,v])=>'<div class="bar-row"><span>'+esc(k.replaceAll('_',' '))+'</span><div class="track"><div class="fill" style="width:'+Math.max(0,Math.min(100,(Number(v)||0)/max*100))+'%"></div></div><b>'+num(v)+'</b></div>').join('')||'<div class="empty">No funnel data yet</div>'}
function list(items,empty){return items.length?items.map(x=>'<div class="list-item"><span>'+esc(x[0])+'</span><b>'+esc(x[1])+'</b></div>').join(''):'<div class="empty">'+empty+'</div>'}
function latency(x){return x&&x.samples?num(x.p50Ms)+' / '+num(x.p95Ms)+' ms':'—'}
async function refresh(){try{
 const [d,r,t,db,ledger,worker]=await Promise.all([fetch('/api/diagnostics',{cache:'no-store'}).then(x=>{if(!x.ok)throw Error('Diagnostics '+x.status);return x.json()}),fetch('/api/results/summary',{cache:'no-store'}).then(x=>{if(!x.ok)throw Error('Summary '+x.status);return x.json()}),fetch('/api/tracking',{cache:'no-store'}).then(x=>{if(!x.ok)throw Error('Tracking '+x.status);return x.json()}),fetch('/api/persistence',{cache:'no-store'}).then(x=>{if(!x.ok)throw Error('Persistence '+x.status);return x.json()}),fetch('/api/portfolio',{cache:'no-store'}).then(x=>{if(!x.ok)throw Error('Portfolio '+x.status);return x.json()}),fetch('/api/worker',{cache:'no-store'}).then(x=>x.json()).catch(()=>({configured:false,connected:false,enabled:false,tradingReady:false,blocker:'Worker status unavailable'}))]);
 const workerCandidates=worker.candidates||[];$('#workerCandidateRows').innerHTML=workerCandidates.length?workerCandidates.map(c=>'<tr><td title="'+esc(c.mint)+'">'+esc(short(c.mint))+'</td><td>'+tag(c.status)+'</td><td>'+num(c.observations||0)+'</td><td>'+esc(c.firstSeenAt?new Date(c.firstSeenAt).toLocaleTimeString():'—')+'</td><td>'+esc(c.lastSeenAt?new Date(c.lastSeenAt).toLocaleTimeString():'—')+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">'+(worker.canControl===true?'No live candidates reported by Worker':'Candidate details require the authenticated Worker connection')+'</td></tr>';const activity=worker.recentActivity||[];$('#workerActivityRows').innerHTML=activity.length?activity.map(e=>{const data=e.data||{};const summary=data.reason||data.decision||data.status||data.exitReason||data.message||'Audited event';return '<tr><td>'+esc(e.occurredAt?new Date(e.occurredAt).toLocaleTimeString():'—')+'</td><td title="'+esc(e.mint||'')+'">'+esc(short(e.mint))+'</td><td>'+tag(e.kind)+'</td><td>'+esc(typeof summary==='string'?summary:JSON.stringify(summary))+'</td></tr>'}).join(''):'<tr><td colspan="4" class="empty">'+(worker.canControl===true?'No live strategy or execution events yet':'Strategy and execution events require the authenticated Worker connection')+'</td></tr>';
 const ws=worker.status||worker;const workerConnected=worker.connected===true;$('#workerTag').className='tag '+(workerConnected&&ws.enabled?'good':workerConnected?'warn':'bad');$('#workerTag').textContent=!worker.configured?'NOT CONFIGURED':!workerConnected?'OFFLINE':ws.enabled?'MONITORING':'STOPPED';$('#workerPump').textContent=ws.connected?'Connected':'Disconnected';$('#workerHelius').textContent=ws.heliusConnected?'Connected':'Disconnected';$('#workerCandidates').textContent=num(ws.monitoredCandidates??ws.candidates??0);$('#workerVerified').textContent=num(ws.verifiedTransactions??0);$('#workerBlocker').textContent=worker.blocker||ws.blocker||(workerConnected?'Discovery monitor connected.':'Configure Worker connection on the server.');$('#paperExecutionState').textContent=ws.tradingReady===true?'PAPER EXECUTION READY':'PAPER EXECUTION DISABLED';$('#paperExecutionState').className='tag '+(ws.tradingReady===true?'good':'warn');$('#startMonitor').disabled=!worker.configured||worker.canControl!==true||!workerConnected||ws.enabled===true;$('#stopMonitor').disabled=!worker.configured||worker.canControl!==true||!workerConnected||ws.enabled!==true;
 const portfolio=r.portfolio||{};const usd2=v=>v===null||v===undefined?'—':'$'+Number(v).toFixed(2);$('#startingBalance').textContent=usd2(portfolio.startingBalanceUsd);$('#positionPrincipal').textContent=usd2(portfolio.positionSizeUsd);const slots=Number(portfolio.maxOpenPositions);$('#positionCapacity').textContent=Number.isFinite(slots)?'Maximum '+slots+' simultaneous position'+(slots===1?'':'s'):'Position capacity unavailable';
 const ready=!!d.readiness?.ready;$('#healthDot').className='dot '+(ready?'good':'bad');$('#healthText').textContent=ready?'READY':'DEGRADED';$('#readyTag').className='tag '+(ready?'good':'warn');$('#readyTag').textContent=ready?'READY':'NOT READY';
 $('#diagnosis').textContent=d.diagnosis?.status||'Unknown';$('#diagnosisDetail').textContent=(d.diagnosis?.notes||[]).join(' ')||'No diagnosis details';
 const blockers=d.readiness?.blockers||[];$('#blockers').innerHTML=blockers.length?blockers.map(x=>'<div class="list-item"><span>'+esc(x)+'</span>'+tag('blocked')+'</div>').join(''):'<div class="empty">No readiness blockers reported</div>';
 const f=t.funnel||{};$('#funnel').innerHTML=bars(f);$('#funnelTotal').textContent=num(f.discovered||0)+' discovered';
 const reasons=(t.decisions?.rejectionReasons||[]).map(x=>[x.reason,x.count]);$('#rejections').innerHTML=list(reasons,'No rejections recorded');
 const q=t.quotes||{};$('#quoteSuccess').textContent=num(q.success||0);$('#quoteFailed').textContent=num((q.missing||0)+(q.stale||0));$('#quoteCost').textContent=num(q.costRejected||0);$('#quoteSell').textContent=num(q.sellabilityFailed||0);$('#roundTrip').textContent=pct(q.averageRoundTripCostPct);
 const p=t.provider||{};$('#providerState').textContent=p.connected?'Connected':'Not connected';$('#providerLag').textContent=p.latestSlotLag===null?'No provider telemetry':'Latest slot lag: '+num(p.latestSlotLag)+' · reconnects '+num(p.reconnects);
 const g=t.graduation||{};$('#graduationCount').textContent=num(g.approaching||0)+' / '+num(g.graduated||0)+' / '+num(g.migratedMarketVerified||0)+' / '+num(g.migrationExitBlocked||0);$('#graduationDetail').textContent='Approaching / graduated / migrated verified / exit blocked';
 const l=t.latency||{};$('#latency').innerHTML=list([['Discovery',latency(l.discovery)],['Enrichment',latency(l.enrichment)],['Risk',latency(l.risk)],['Buy quote',latency(l.buyQuote)],['Sell quote',latency(l.sellQuote)],['Simulation',latency(l.simulatedExecution)]],'No latency samples');
 const candidates=t.candidates||[];$('#candidates').innerHTML=candidates.length?candidates.slice(0,30).map(c=>'<tr><td title="'+esc(c.mint)+'">'+esc(short(c.mint))+'</td><td>'+tag(c.stage)+'</td><td>'+tag(c.decision)+'</td><td>'+num(c.riskScore)+'</td><td>'+num(c.momentumScore)+'</td><td>'+pct(c.roundTripCostPct)+'</td><td>'+esc(new Date(c.lastUpdatedAt).toLocaleTimeString())+'</td></tr>').join(''):'<tr><td colspan="7" class="empty">No candidate records yet — market adapters are not connected.</td></tr>';
 const positions=t.positions?.records||[];
 const workerPortfolio=worker.portfolio&&typeof worker.portfolio==='object'?worker.portfolio:null;
 const workerPositions=Array.isArray(workerPortfolio?.positions)?workerPortfolio.positions:[];
 const workerOpenPositions=workerPositions.filter(p=>p.status!=='CLOSED');
 const workerClosedPositions=workerPositions.filter(p=>p.status==='CLOSED');
 const workerEvents=Array.isArray(worker.recentActivity)?worker.recentActivity:[];
 $('#positions').innerHTML=positions.length?positions.slice().reverse().map(p=>'<tr><td>'+esc(short(p.mint))+'</td><td>'+tag(p.state)+'</td><td>'+tag(p.marketPhase||'bonding_curve')+'</td><td>'+esc(p.venue||'—')+'</td><td>'+money(p.entryCostUsd)+'</td><td>'+money(p.exitValueUsd)+'</td><td>'+money(p.feesUsd)+'</td><td>'+money(p.realizedNetPnlUsd)+'</td><td>'+tag(p.tokenBalanceZeroConfirmed?'confirmed':'pending')+'</td></tr>').join(''):workerOpenPositions.length?workerOpenPositions.map(p=>'<tr><td>'+esc(short(p.mint))+'</td><td>'+tag(p.status)+'</td><td>—</td><td>Worker paper portfolio</td><td>'+money(p.stakeUsd)+'</td><td>'+money(p.latestLiquidationValueUsd)+'</td><td>'+money(p.buyCostsUsd)+'</td><td>'+money(p.realizedPnlUsd)+'</td><td>Not applicable · paper</td></tr>').join(''):'<tr><td colspan="9" class="empty">'+(workerPortfolio?'No open positions in Worker paper portfolio':'No paper positions recorded')+'</td></tr>';
 $('#openPositions').textContent=num(workerPortfolio?workerOpenPositions.length:(t.positions?.open??0));
 $('#dbConnected').textContent=db.connected?'Connected':db.configured?'Offline':'Not configured';$('#dbSchema').textContent=db.schemaReady?'Ready':'Pending';$('#dbMigration').textContent=db.migrationVersion||'—';$('#dbTag').className='tag '+(db.schemaReady?'good':db.connected?'warn':'bad');$('#dbTag').textContent=db.schemaReady?'PERSISTENT':db.connected?'SCHEMA PENDING':'OFFLINE';$('#dbNote').textContent=db.error||'Database connection and migration status verified.';
 const pnl=t.positions?.realizedNetPnlUsd??r.portfolio?.realizedNetPnlUsd;$('#pnl').textContent=money(pnl);$('#pnlNote').textContent=pnl===null?'No realized PnL until persisted trades exist':'Net of recorded fees and execution costs';
 const ledgerPortfolio=ledger.portfolio||{};
 const workerRealizedPnl=workerClosedPositions.reduce((sum,p)=>sum+(Number(p.realizedPnlUsd)||0),0);
 const workerUnrealizedPnl=workerOpenPositions.reduce((sum,p)=>sum+(Number(p.latestLiquidationValueUsd||0)-Number(p.stakeUsd||0)-Number(p.buyCostsUsd||0)),0);
 if(ledger.available)$('#openPositions').textContent=num(ledgerPortfolio.openPositions);
 if(ledger.available&&ledgerPortfolio.realizedPnlUsd!==null){$('#pnl').textContent=usd2(ledgerPortfolio.realizedPnlUsd);$('#pnlNote').textContent='Net of recorded fees and execution costs';}
 else if(workerPortfolio){$('#pnl').textContent=usd2(workerRealizedPnl);$('#pnlNote').textContent='Worker durable paper portfolio · realized USD';}
 $('#ledgerTag').className='tag '+(ledger.available||workerPortfolio?'good':'warn');
 $('#ledgerTag').textContent=ledger.available?'PERSISTENT LEDGER':workerPortfolio?'WORKER PAPER STATE':'LEDGER UNAVAILABLE';
 $('#ledgerRealizedSol').textContent=ledger.available?(ledgerPortfolio.realizedPnlSol+' SOL'):'—';
 $('#ledgerRealizedUsd').textContent=ledger.available?(ledgerPortfolio.realizedPnlUsd===null?'—':usd2(ledgerPortfolio.realizedPnlUsd)):workerPortfolio?usd2(workerRealizedPnl):'—';
 $('#ledgerUnrealizedSol').textContent=ledger.available?(ledgerPortfolio.unrealizedPnlSol===null?'—':ledgerPortfolio.unrealizedPnlSol+' SOL'):'—';
 $('#ledgerUnrealizedUsd').textContent=ledger.available?(ledgerPortfolio.unrealizedPnlUsd===null?'Unavailable':usd2(ledgerPortfolio.unrealizedPnlUsd)):workerPortfolio?usd2(workerUnrealizedPnl):'Unavailable';
 $('#ledgerValuationNote').textContent=ledgerPortfolio.usdValuationNote||(workerPortfolio?'Worker durable paper state · open-position USD marks use latest exact-size sell quotes.':'PostgreSQL ledger or Worker portfolio is unavailable.');
 const lp=ledger.positions||[];$('#ledgerPositions').innerHTML=lp.length?lp.map(p=>'<tr><td><b>'+esc(p.name||p.symbol||'Unknown token')+'</b><br><span class="muted small">'+esc(p.mint)+'</span></td><td>'+tag(p.status)+'</td><td>'+tag(p.marketPhase)+'<br>'+esc(p.venue||'—')+'</td><td>'+esc(p.tokenQuantity)+'</td><td>'+esc(p.principalSol)+'</td><td>'+(p.estimatedExitSol===null?'—':esc(p.estimatedExitSol))+'</td><td>'+(p.estimatedUnrealizedPnlSol===null?'—':esc(p.estimatedUnrealizedPnlSol))+'</td><td>'+tag(p.sellQuoteFresh?'fresh quote':p.latestSellQuoteAt?'stale / '+(p.sellQuoteStatus||'unknown'):'missing')+'<br><span class="muted small">'+esc(p.latestSellQuoteAt?new Date(p.latestSellQuoteAt).toLocaleTimeString():'No quote')+'</span></td><td>'+(p.activeStopNetReturnPct===null?'—':esc(p.activeStopNetReturnPct)+'%')+'</td></tr>').join(''):workerOpenPositions.length?workerOpenPositions.map(p=>'<tr><td><b>'+esc(short(p.mint))+'</b><br><span class="muted small">'+esc(p.mint)+'</span></td><td>'+tag(p.status)+'</td><td>Worker paper portfolio</td><td>'+esc(p.tokenAmountBaseUnits)+'</td><td>'+usd2(p.stakeUsd)+'</td><td>'+usd2(p.latestLiquidationValueUsd)+'</td><td>'+usd2(Number(p.latestLiquidationValueUsd||0)-Number(p.stakeUsd||0)-Number(p.buyCostsUsd||0))+'</td><td>'+tag('latest quote')+'<br><span class="muted small">'+esc(p.latestSellQuoteAt?new Date(p.latestSellQuoteAt).toLocaleTimeString():'No quote')+'</span></td><td>—</td></tr>').join(''):'<tr><td colspan="9" class="empty">'+esc(workerPortfolio?'No open Worker paper positions':ledger.reason||'No open positions in persistent ledger')+'</td></tr>';
 const lc=ledger.closedPositions||[];$('#ledgerClosed').innerHTML=lc.length?lc.map(p=>'<tr><td>'+esc(p.closedAt?new Date(p.closedAt).toLocaleString():'—')+'</td><td><b>'+esc(p.name||p.symbol||'Unknown token')+'</b><br><span class="muted small">'+esc(p.mint)+'</span></td><td>'+esc(p.principalSol)+'</td><td>'+esc(p.grossPnlSol??'—')+'</td><td>'+esc(p.costsSol??'—')+'</td><td>'+esc(p.netPnlSol??'—')+'</td><td>'+(p.netPnlUsd===null?'—':usd2(p.netPnlUsd))+'</td><td>'+esc(p.exitReason||'—')+'</td><td>'+tag(p.zeroBalanceConfirmed?'confirmed':'NOT CONFIRMED')+'</td></tr>').join(''):workerClosedPositions.length?workerClosedPositions.map(p=>{const event=workerEvents.find(e=>e.kind==='PAPER_EXIT'&&(e.mint===p.mint||e.data?.position?.positionId===p.positionId));return '<tr><td>'+esc(event?.occurredAt?new Date(event.occurredAt).toLocaleString():'—')+'</td><td><b>'+esc(short(p.mint))+'</b><br><span class="muted small">'+esc(p.mint)+'</span></td><td>—</td><td>—</td><td>—</td><td>—</td><td>'+usd2(p.realizedPnlUsd)+'</td><td>'+esc(p.exitReason||event?.data?.exitReason||'—')+'</td><td>Not applicable · paper</td></tr>'}).join(''):'<tr><td colspan="9" class="empty">'+(workerPortfolio?'No closed Worker paper positions yet':'No closed paper positions recorded yet')+'</td></tr>';
 const lt=ledger.trades||[];const workerTradeEvents=workerEvents.filter(e=>e.kind==='PAPER_ENTRY'||e.kind==='PAPER_EXIT').slice(0,200);$('#ledgerTrades').innerHTML=lt.length?lt.map(x=>'<tr><td>'+esc(new Date(x.executedAt).toLocaleString())+'</td><td><b>'+esc(x.name||x.symbol||'Unknown token')+'</b><br><span class="muted small">'+esc(x.mint)+'</span></td><td>'+tag(x.side)+'</td><td>'+esc(x.tokenAmount)+'</td><td>'+esc(x.solAmount)+'</td><td>'+esc(x.feesSol)+'</td><td>'+pct(x.priceImpactPct)+'</td><td>'+pct(x.slippagePct)+'</td><td>'+esc(x.simulationProfile)+'</td><td>'+num(x.simulatedLatencyMs)+' ms</td></tr>').join(''):workerTradeEvents.length?workerTradeEvents.map(e=>{const data=e.data||{};const quote=e.kind==='PAPER_ENTRY'?data.buyQuote:data.sellQuote;const position=data.position||{};const feeUsd=quote?Number(quote.networkFeeUsd||0)+Number(quote.priorityFeeUsd||0)+Number(quote.providerFeeUsd||0)+Number(quote.pumpFeeUsd??(Number(quote.protocolFeeUsd||0)+Number(quote.creatorFeeUsd||0)))+Number(quote.poolFeeUsd||0)+Number(quote.transferFeeUsd||0):null;const valueUsd=quote?(e.kind==='PAPER_ENTRY'?quote.requestedUsd:quote.outputUsd):null;const quoteAge=quote?.observedAt&&e.occurredAt?Date.parse(e.occurredAt)-Date.parse(quote.observedAt):null;return '<tr><td>'+esc(e.occurredAt?new Date(e.occurredAt).toLocaleString():'—')+'</td><td><b>'+esc(short(e.mint||position.mint))+'</b><br><span class="muted small">'+esc(e.mint||position.mint)+'</span></td><td>'+tag(e.kind==='PAPER_ENTRY'?'BUY':'SELL')+'</td><td>'+esc(position.tokenAmountBaseUnits||'—')+'</td><td>'+usd2(valueUsd)+'</td><td>'+usd2(feeUsd)+'</td><td>'+pct(quote?.priceImpactPct)+'</td><td>—</td><td>Worker paper</td><td>'+(quoteAge===null?'—':num(quoteAge)+' ms')+'</td></tr>'}).join(''):'<tr><td colspan="10" class="empty">'+(workerPortfolio?'No Worker paper fills recorded yet':'No persisted paper trades yet')+'</td></tr>';
 $('#updatedAt').textContent='Last updated '+new Date().toLocaleTimeString();
 }catch(e){$('#healthDot').className='dot bad';$('#healthText').textContent='API ERROR';$('#diagnosis').textContent='Dashboard API unavailable';$('#diagnosisDetail').textContent=String(e)}}
async function workerAction(path){const button=path.includes('start')?$('#startMonitor'):$('#stopMonitor');button.disabled=true;try{const response=await fetch(path,{method:'POST'});const body=await response.json();if(!response.ok)throw Error(body.error||'Worker control request failed');await refresh()}catch(error){$('#workerBlocker').textContent=String(error)}finally{button.disabled=false}}
$('#startMonitor').addEventListener('click',()=>workerAction('/api/worker/start-monitor'));$('#stopMonitor').addEventListener('click',()=>workerAction('/api/worker/stop-monitor'));
$('#refresh').addEventListener('click',refresh);refresh();setInterval(refresh,5000);
</script></body></html>`;

app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(dashboardHtml));

app.addHook("onReady", async () => {
  increment("service.started");
  app.log.info({ mode: "paper", ready: false }, "Service started in safe degraded mode; live adapters are not connected");
});

// Vercel invokes the exported Fastify handler through api/index.ts.
// Persistent deployments (for example Google Cloud) start the HTTP listener here.
if (process.env.VERCEL !== "1") {
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}
