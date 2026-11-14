#!/usr/bin/env node
const workerUrl = new URL(process.env.PAPER_WORKER_URL ?? "https://pumpfun-paper-worker.teddyjeremy12.workers.dev");

async function getJson(path) {
  const response = await fetch(new URL(path, workerUrl), {
    signal: AbortSignal.timeout(8_000),
    cache: "no-store"
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return payload;
}

const health = await getJson("/health");
if (health.service !== "pumpfun-paper-worker" || health.mode !== "paper" ||
    health.paused !== true || health.enabled !== false) {
  throw new Error("Worker did not expose the expected quota-protection paused health state.");
}
const status = await getJson("/status");
if (status.paused !== true || status.enabled !== false || status.tradingReady !== false) {
  throw new Error("Worker status does not confirm a disabled, paused, non-trading state.");
}
console.log("PASS Worker quota-protection pause: health/status are static, paper-only and disabled.");
