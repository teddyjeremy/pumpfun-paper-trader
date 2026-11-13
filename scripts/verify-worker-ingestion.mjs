#!/usr/bin/env node
/**
 * Safe production smoke test for the deployed Cloudflare Worker -> Vercel -> Neon path.
 * The Worker writes a uniquely tagged, stopped audit-only session and retries the
 * same two events to prove persistence and idempotency. No market streams start,
 * no positions/quotes/fills are created, and no Solana transaction is signed or sent.
 */
const required = ["PAPER_WORKER_CONTROL_TOKEN"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(2);
}

const workerUrl = new URL(process.env.PAPER_WORKER_URL ?? "https://pumpfun-paper-worker.teddyjeremy12.workers.dev");
const apiUrl = new URL(process.env.PAPER_EVENT_INGEST_URL ?? "https://pumpfun-paper-trader-six.vercel.app");
if (workerUrl.protocol !== "https:" || apiUrl.protocol !== "https:") {
  console.error("Production smoke tests require HTTPS endpoints.");
  process.exit(2);
}

async function request(base, path, token, body) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store"
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`${path} returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) {
    const detail = typeof payload.detail === "string" ? `; detail=${payload.detail.slice(0, 240)}` : "";
    throw new Error(`${path} returned HTTP ${response.status}: ${payload.error ?? "request failed"}${detail}`);
  }
  return payload;
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

let failure;
try {
  const healthResponse = await fetch(new URL("/health", workerUrl), {
    signal: AbortSignal.timeout(10_000), cache: "no-store"
  });
  const health = await healthResponse.json();
  check("Worker public health", healthResponse.ok && health.service === "pumpfun-paper-worker",
    `HTTP ${healthResponse.status}; mode=${health.mode ?? "unknown"}`);
  if (!healthResponse.ok || health.service !== "pumpfun-paper-worker") throw new Error("Cloudflare Worker health check failed.");

  const status = await request(workerUrl, "/status", process.env.PAPER_WORKER_CONTROL_TOKEN);
  const blockers = Array.isArray(status.readinessBlockers) ? status.readinessBlockers : [];
  check("Worker authenticated control API", status.mode === "paper" && status.tradingReady === false,
    `mode=${status.mode ?? "unknown"}; enabled=${Boolean(status.enabled)}; tradingReady=${String(status.tradingReady)}; blockers=${blockers.join(" | ") || "none reported"}`);
  if (status.mode !== "paper" || status.tradingReady !== false) {
    throw new Error("Worker status did not match the expected fail-closed paper-only state.");
  }

  const apiHealthResponse = await fetch(new URL("/health", apiUrl), {
    signal: AbortSignal.timeout(10_000), cache: "no-store"
  });
  const apiHealth = await apiHealthResponse.json();
  check("Vercel API health", apiHealthResponse.ok && apiHealth.status === "ok",
    `HTTP ${apiHealthResponse.status}; status=${apiHealth.status ?? "unknown"}`);
  if (!apiHealthResponse.ok || apiHealth.status !== "ok") throw new Error("Vercel API health check failed.");

  const smoke = await request(workerUrl, "/smoke-ingestion", process.env.PAPER_WORKER_CONTROL_TOKEN, {});
  check("Worker-to-Neon lease acquisition and heartbeat", smoke.leaseAcquired === true && smoke.leaseHeartbeat === true,
    "Worker acquired and heartbeated its fenced Neon lease.");
  check("Worker event persistence", smoke.eventPersisted === true,
    `Two audit-only events persisted in smoke session ${smoke.sessionId ?? "unknown"}.`);
  check("Worker event idempotency", smoke.idempotentReplay === true,
    "Replaying the same two events produced duplicates without new inserts.");
  check("Lease handling", smoke.leaseRetained === true || smoke.leaseReleased === true,
    smoke.leaseRetained ? "Existing active-session lease was retained." : "Temporary smoke-test lease was released.");
  if (smoke.ok !== true || smoke.leaseAcquired !== true || smoke.leaseHeartbeat !== true ||
      smoke.eventPersisted !== true || smoke.idempotentReplay !== true ||
      (smoke.leaseRetained !== true && smoke.leaseReleased !== true)) {
    throw new Error("Worker-to-Neon ingestion smoke test returned incomplete acceptance evidence.");
  }
} catch (error) {
  failure = error;
}

if (failure) {
  console.error(`Smoke test failed: ${failure instanceof Error ? failure.message : "unknown error"}`);
  process.exit(1);
}
if (checks.some((item) => !item.ok)) process.exit(1);
console.log("All Worker/API/Neon smoke checks passed. Only a tagged audit-only smoke session was created; no paper trades were created.");
