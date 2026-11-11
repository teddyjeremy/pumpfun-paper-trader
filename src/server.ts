import Fastify from "fastify";
import { config } from "./config.js";
import { diagnose, increment, snapshot } from "./diagnostics/registry.js";
import { trackingSnapshot } from "./diagnostics/tracker.js";
import { getPersistenceStatus } from "./persistence/postgres.js";
import { calculatePortfolioPolicy } from "./strategy/portfolio-policy.js";

export const app = Fastify({
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

app.get("/api/tracking", async () => trackingSnapshot());
app.get("/api/persistence", async () => getPersistenceStatus());

app.get("/api/results/summary", async () => {
  const state = snapshot();
  const counters = state.counters;
  const initialPortfolioPolicy = calculatePortfolioPolicy(config.PAPER_STARTING_BALANCE_USD, {
    initialStakeUsd: config.PAPER_POSITION_SIZE_USD,
    firstCapacityThresholdUsd: config.PAPER_FIRST_CAPACITY_THRESHOLD_USD,
    maxStakeUsd: config.PAPER_MAX_POSITION_SIZE_USD,
    hardMaxOpenPositions: config.PAPER_HARD_MAX_OPEN_POSITIONS
  });
  return {
    mode: "paper",
    portfolio: {
      startingBalanceUsd: config.PAPER_STARTING_BALANCE_USD,
      positionSizeUsd: initialPortfolioPolicy.stakePerPositionUsd,
      maxOpenPositions: initialPortfolioPolicy.maxConcurrentPositions,
      maxAllocatedUsd: initialPortfolioPolicy.stakePerPositionUsd * initialPortfolioPolicy.maxConcurrentPositions,
      realizedNetPnlUsd: null,
      openPositions: null,
      note: "Shows initial-equity sizing until durable live equity is connected; PnL is intentionally null, not guessed."
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
<div class="intro"><div><div class="eyebrow">Operations / overview</div><h2>Trading control room</h2><div class="muted small">Observe discovery, screening, execution quality and system health.</div></div><div class="pill">PAPER MODE · NO WALLET SIGNING · NO REAL ORDERS · NO TIME CAP</div></div>
<div class="grid">
<section class="panel"><div class="metric-label">Starting paper balance</div><div class="metric">$2.70</div><div class="metric-note">Initial paper equity</div></section>
<section class="panel"><div class="metric-label">Position principal</div><div class="metric">$1.00</div><div class="metric-note">Initial stake · scales with equity</div></section>
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
<section class="panel"><div class="section-head"><h3>Graduation watch</h3></div><div class="metric" id="graduationCount">0</div><div class="metric-note" id="graduationDetail">Approaching / graduated / unavailable</div></section>
<section class="panel"><div class="section-head"><h3>Execution latency</h3></div><div class="list" id="latency"><div class="empty">No samples yet</div></div></section>
</div>
<div class="section panel"><div class="section-head"><h3>Database persistence</h3><span class="tag warn" id="dbTag">CHECKING</span></div><div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div><div class="metric-label">PostgreSQL</div><div class="metric" id="dbConnected">—</div></div><div><div class="metric-label">Schema</div><div class="metric" id="dbSchema">—</div></div><div><div class="metric-label">Migration</div><div class="metric" id="dbMigration">—</div></div></div><div class="metric-note" id="dbNote">Connection status is checked without exposing credentials.</div></div>
<div class="section panel"><div class="section-head"><h3>Recent candidates</h3><span class="muted small">Latest 100 tracked records</span></div><div class="table-wrap"><table><thead><tr><th>Mint</th><th>Stage</th><th>Decision</th><th>Risk</th><th>Momentum</th><th>Round-trip cost</th><th>Updated</th></tr></thead><tbody id="candidates"><tr><td colspan="7" class="empty">No candidate records yet</td></tr></tbody></table></div></div>
<div class="section panel"><div class="section-head"><h3>Positions</h3><span class="muted small">Graduation changes venue, not the sell decision · no holding-time cap</span></div><div class="table-wrap"><table><thead><tr><th>Mint</th><th>State</th><th>Venue</th><th>Active stop</th><th>Last exit signal</th><th>Entry cost</th><th>Exit value</th><th>Fees</th><th>Net PnL</th><th>Zero balance</th></tr></thead><tbody id="positions"><tr><td colspan="10" class="empty">No paper positions recorded</td></tr></tbody></table></div></div>
<div class="foot"><span>Auto-refresh every 5 seconds · All values are telemetry, not trading advice.</span><span id="updatedAt">Last updated —</span></div>
</main>
<script>
const $=s=>document.querySelector(s);
const money=v=>v===null||v===undefined?'—':'$'+Number(v).toFixed(4);
const pct=v=>v===null||v===undefined?'—':Number(v).toFixed(2)+'%';
const num=v=>v===null||v===undefined?'—':Number(v).toLocaleString();
const short=v=>!v?'—':String(v).length>15?String(v).slice(0,6)+'…'+String(v).slice(-5):String(v);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tag=(v)=>'<span class="tag '+(v==='reject'||v==='exit_unexecutable'||v==='exit_blocked'?'bad':v==='open'||v==='open_migrated'||v==='paper_entry'?'good':v==='watch'||v==='sell_pending'||v==='migration_pending'?'warn':'')+'">'+esc(v||'unknown')+'</span>';
function bars(obj){const entries=Object.entries(obj||{});const max=Math.max(1,...entries.map(x=>Number(x[1])||0));return entries.map(([k,v])=>'<div class="bar-row"><span>'+esc(k.replaceAll('_',' '))+'</span><div class="track"><div class="fill" style="width:'+Math.max(0,Math.min(100,(Number(v)||0)/max*100))+'%"></div></div><b>'+num(v)+'</b></div>').join('')||'<div class="empty">No funnel data yet</div>'}
function list(items,empty){return items.length?items.map(x=>'<div class="list-item"><span>'+esc(x[0])+'</span><b>'+esc(x[1])+'</b></div>').join(''):'<div class="empty">'+empty+'</div>'}
function latency(x){return x&&x.samples?num(x.p50Ms)+' / '+num(x.p95Ms)+' ms':'—'}
async function refresh(){try{
 const [d,r,t,db]=await Promise.all([fetch('/api/diagnostics',{cache:'no-store'}).then(x=>{if(!x.ok)throw Error('Diagnostics '+x.status);return x.json()}),fetch('/api/results/summary',{cache:'no-store'}).then(x=>{if(!x.ok)throw Error('Summary '+x.status);return x.json()}),fetch('/api/tracking',{cache:'no-store'}).then(x=>{if(!x.ok)throw Error('Tracking '+x.status);return x.json()}),fetch('/api/persistence',{cache:'no-store'}).then(x=>{if(!x.ok)throw Error('Persistence '+x.status);return x.json()})]);
 const ready=!!d.readiness?.ready;$('#healthDot').className='dot '+(ready?'good':'bad');$('#healthText').textContent=ready?'READY':'DEGRADED';$('#readyTag').className='tag '+(ready?'good':'warn');$('#readyTag').textContent=ready?'READY':'NOT READY';
 $('#diagnosis').textContent=d.diagnosis?.status||'Unknown';$('#diagnosisDetail').textContent=(d.diagnosis?.notes||[]).join(' ')||'No diagnosis details';
 const blockers=d.readiness?.blockers||[];$('#blockers').innerHTML=blockers.length?blockers.map(x=>'<div class="list-item"><span>'+esc(x)+'</span>'+tag('blocked')+'</div>').join(''):'<div class="empty">No readiness blockers reported</div>';
 const f=t.funnel||{};$('#funnel').innerHTML=bars(f);$('#funnelTotal').textContent=num(f.discovered||0)+' discovered';
 const reasons=(t.decisions?.rejectionReasons||[]).map(x=>[x.reason,x.count]);$('#rejections').innerHTML=list(reasons,'No rejections recorded');
 const q=t.quotes||{};$('#quoteSuccess').textContent=num(q.success||0);$('#quoteFailed').textContent=num((q.missing||0)+(q.stale||0));$('#quoteCost').textContent=num(q.costRejected||0);$('#quoteSell').textContent=num(q.sellabilityFailed||0);$('#roundTrip').textContent=pct(q.averageRoundTripCostPct);
 const p=t.provider||{};$('#providerState').textContent=p.connected?'Connected':'Not connected';$('#providerLag').textContent=p.latestSlotLag===null?'No provider telemetry':'Latest slot lag: '+num(p.latestSlotLag)+' · reconnects '+num(p.reconnects);
 const g=t.graduation||{};$('#graduationCount').textContent=num(g.approaching||0)+' / '+num(g.graduated||0)+' / '+num(g.curveUnavailable||0);$('#graduationDetail').textContent='Approaching / graduated / curve unavailable';
 const l=t.latency||{};$('#latency').innerHTML=list([['Discovery',latency(l.discovery)],['Enrichment',latency(l.enrichment)],['Risk',latency(l.risk)],['Buy quote',latency(l.buyQuote)],['Sell quote',latency(l.sellQuote)],['Simulation',latency(l.simulatedExecution)]],'No latency samples');
 const candidates=t.candidates||[];$('#candidates').innerHTML=candidates.length?candidates.slice(0,30).map(c=>'<tr><td title="'+esc(c.mint)+'">'+esc(short(c.mint))+'</td><td>'+tag(c.stage)+'</td><td>'+tag(c.decision)+'</td><td>'+num(c.riskScore)+'</td><td>'+num(c.momentumScore)+'</td><td>'+pct(c.roundTripCostPct)+'</td><td>'+esc(new Date(c.lastUpdatedAt).toLocaleTimeString())+'</td></tr>').join(''):'<tr><td colspan="7" class="empty">No candidate records yet — market adapters are not connected.</td></tr>';
 const positions=t.positions?.records||[];$('#positions').innerHTML=positions.length?positions.slice().reverse().map(p=>'<tr><td>'+esc(short(p.mint))+'</td><td>'+tag(p.state)+'</td><td>'+tag(p.activeVenue||'unknown')+'</td><td>'+money(p.activeStopPriceUsd)+'</td><td>'+tag(p.lastExitSignal||'none')+'</td><td>'+money(p.entryCostUsd)+'</td><td>'+money(p.exitValueUsd)+'</td><td>'+money(p.feesUsd)+'</td><td>'+money(p.realizedNetPnlUsd)+'</td><td>'+tag(p.tokenBalanceZeroConfirmed?'confirmed':'pending')+'</td></tr>').join(''):'<tr><td colspan="10" class="empty">No paper positions recorded</td></tr>';
 $('#openPositions').textContent=num(t.positions?.open??0);
 $('#dbConnected').textContent=db.connected?'Connected':db.configured?'Offline':'Not configured';$('#dbSchema').textContent=db.schemaReady?'Ready':'Pending';$('#dbMigration').textContent=db.migrationVersion||'—';$('#dbTag').className='tag '+(db.schemaReady?'good':db.connected?'warn':'bad');$('#dbTag').textContent=db.schemaReady?'PERSISTENT':db.connected?'SCHEMA PENDING':'OFFLINE';$('#dbNote').textContent=db.error||'Database connection and migration status verified.';
 const pnl=t.positions?.realizedNetPnlUsd??r.portfolio?.realizedNetPnlUsd;$('#pnl').textContent=money(pnl);$('#pnlNote').textContent=pnl===null?'No realized PnL until persisted trades exist':'Net of recorded fees and execution costs';
 $('#updatedAt').textContent='Last updated '+new Date().toLocaleTimeString();
 }catch(e){$('#healthDot').className='dot bad';$('#healthText').textContent='API ERROR';$('#diagnosis').textContent='Dashboard API unavailable';$('#diagnosisDetail').textContent=String(e)}}
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
