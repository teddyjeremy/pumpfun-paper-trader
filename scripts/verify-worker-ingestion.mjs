#!/usr/bin/env node
/**
 * Safe production smoke test for the Cloudflare Worker -> Vercel -> Neon path.
 *
 * It reads Worker health/status and uses a uniquely named, short-lived
 * PostgreSQL lease to prove that the shared ingestion token authenticates and
 * the Vercel API can write to the migrated database. It never starts/stops the
 * coordinator, submits paper events, creates trades, or signs transactions.
 */
import { randomUUID } from "node:crypto";

const required = ["PAPER_WORKER_URL", "PAPER_WORKER_CONTROL_TOKEN",
  "PAPER_EVENT_INGEST_URL", "PAPER_EVENT_INGEST_TOKEN"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(2);
}

const workerUrl = new URL(process.env.PAPER_WORKER_URL);
const apiUrl = new URL(process.env.PAPER_EVENT_INGEST_URL);
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
    throw new Error(`${path} returned HTTP ${response.status}: ${payload.error ?? "request failed"}`);
  }
  return payload;
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

let leaseName;
let ownerId;
let acquired = false;
let failure;
try {
  const healthResponse = await fetch(new URL("/health", workerUrl), {
    signal: AbortSignal.timeout(10_000), cache: "no-store"
  });
  const health = await healthResponse.json();
  check("Worker public health", healthResponse.ok && health.service === "pumpfun-paper-worker",
    `HTTP ${healthResponse.status}; mode=${health.mode ?? "unknown"}`);
  if (!healthResponse.ok || health.service !== "pumpfun-paper-worker") {
    throw new Error("Cloudflare Worker health check failed.");
  }

  const status = await request(workerUrl, "/status", process.env.PAPER_WORKER_CONTROL_TOKEN);
  check("Worker authenticated control API", status.mode === "paper" && status.tradingReady === false,
    `mode=${status.mode ?? "unknown"}; enabled=${Boolean(status.enabled)}; tradingReady=${String(status.tradingReady)}`);
  if (status.mode !== "paper" || status.tradingReady !== false) {
    throw new Error("Worker status did not match the expected fail-closed paper-only state.");
  }

  const apiHealthResponse = await fetch(new URL("/health", apiUrl), {
    signal: AbortSignal.timeout(10_000), cache: "no-store"
  });
  const apiHealth = await apiHealthResponse.json();
  check("Vercel API health", apiHealthResponse.ok && apiHealth.status === "ok",
    `HTTP ${apiHealthResponse.status}; status=${apiHealth.status ?? "unknown"}`);
  if (!apiHealthResponse.ok || apiHealth.status !== "ok") {
    throw new Error("Vercel API health check failed.");
  }

  leaseName = `smoke-test-${Date.now()}-${randomUUID().slice(0, 8)}`;
  ownerId = randomUUID();
  const lease = await request(apiUrl, "/internal/worker-lease", process.env.PAPER_EVENT_INGEST_TOKEN,
    { action: "acquire", leaseName, ownerId, ttlSeconds: 30 });
  acquired = lease.acquired === true;
  check("Shared ingestion token + Neon lease write", acquired,
    acquired ? "Vercel authenticated the shared token and acquired a unique database lease." :
      "Lease was not acquired; database write or lease ownership failed.");
  if (!acquired) throw new Error("Could not acquire the isolated smoke-test lease.");

  const heartbeat = await request(apiUrl, "/internal/worker-lease", process.env.PAPER_EVENT_INGEST_TOKEN,
    { action: "heartbeat", leaseName, ownerId, ttlSeconds: 30 });
  check("Neon lease heartbeat", heartbeat.acquired === true,
    heartbeat.acquired === true ? "Lease heartbeat persisted." : "Lease heartbeat was rejected.");
  if (heartbeat.acquired !== true) throw new Error("Smoke-test lease heartbeat failed.");
} catch (error) {
  failure = error;
} finally {
  if (acquired) {
    try {
      const release = await request(apiUrl, "/internal/worker-lease", process.env.PAPER_EVENT_INGEST_TOKEN,
        { action: "release", leaseName, ownerId });
      check("Smoke-test lease cleanup", release.released === true,
        release.released === true ? "Temporary lease released." : "Temporary lease was not released.");
      if (release.released !== true && !failure) failure = new Error("Temporary lease cleanup failed.");
    } catch (error) {
      check("Smoke-test lease cleanup", false, "Release request failed; the 30-second lease will expire automatically.");
      if (!failure) failure = error;
    }
  }
}

if (failure) {
  console.error(`Smoke test failed: ${failure instanceof Error ? failure.message : "unknown error"}`);
  process.exit(1);
}
if (checks.some((item) => !item.ok)) process.exit(1);
console.log("All safe Worker/API/Neon connectivity checks passed. No paper trades were created.");
