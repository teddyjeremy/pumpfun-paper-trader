# Deployment architecture

## Vercel dashboard

The Vercel project is already linked to this repository:

- Project: pumpfun-paper-trader
- Repository: teddyjeremy/pumpfun-paper-trader
- Runtime: Node.js 22.x
- Function region: Singapore (sin1)
- Entrypoint: api/index.ts

The dashboard is a read-only operator surface. It must not run the persistent market listener, hold a wallet key, sign transactions, or expose write-capable execution endpoints. Keep Deployment Protection enabled. Dashboard requests must read sanitized, persisted records from the Google Cloud worker/API using server-side authentication.

## Google Cloud worker

Run the persistent Node.js 22 market worker on a dedicated Compute Engine VM under systemd. Use Cloud SQL PostgreSQL for the durable event, quote, position and trade ledger; Secret Manager for provider/database credentials; Cloud Logging and Monitoring for operations; and Cloud Storage for compressed raw archives and resumable checkpoints.

The worker must use a database-backed leader lease and idempotency keys. The Vercel dashboard is not the worker and cannot be relied on for continuous WebSocket subscriptions or position management.

## Position lifecycle

New entries are allowed only on non-migrated Pump.fun bonding curves. A position already open at graduation transitions to migration-pending, then to a verified migrated pool (initially PumpSwap). Migration does not automatically sell. Continue applying protective and dynamic exits to the migrated market. If no fresh executable quote is available, keep the position open as exit-blocked, alert, and retry; never fabricate a fill or release the position slot.

There is no maximum holding duration. Protective stops and confirmed dynamic exit signals determine when a position closes.

## Deployment verification

A Vercel build reaching READY confirms only that the dashboard artifact built and deployed. Verify runtime routes (/health, /ready, /api/diagnostics, /api/tracking, /api/results/summary), authenticated access to the cloud worker, and runtime logs before calling the dashboard operational.

Google Cloud resources are not yet provisioned. See [infra/gcp/DEPLOYMENT.md](../infra/gcp/DEPLOYMENT.md) for prerequisites and deployment plan.
