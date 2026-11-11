# Google Cloud deployment

## Intended split

- **Google Cloud Run** runs the persistent market listener and paper-position manager.
- **Cloud SQL for PostgreSQL** stores the append-only event, quote, decision and position ledger.
- **Secret Manager** stores Helius and database credentials.
- **Vercel** remains the operator dashboard. It must read persisted, sanitized records and must never sign or submit Solana transactions.

The Cloud Run service is configured with one minimum and one maximum instance, instance CPU available outside HTTP requests, and a single request concurrency slot. This is a cost-bearing always-on setup, not a free deployment. PostgreSQL advisory locking/worker leases are still required because Cloud Run can restart an instance during maintenance or deployment.

## Prerequisites

1. Select or create a Google Cloud project and enable billing.
2. Enable Cloud Run, Cloud Build, Artifact Registry, Secret Manager and Cloud SQL Admin APIs.
3. Create an Artifact Registry Docker repository named `pumpfun-paper` in `asia-southeast1`.
4. Create a Cloud SQL PostgreSQL instance and database. Apply migrations in order.
5. Create Secret Manager secrets named `helius-api-key` and `database-url`; grant the Cloud Run runtime service account access to only those secrets.
6. Grant the Cloud Build service account Artifact Registry writer, Cloud Run developer, and Service Account User permissions for the selected runtime identity.
7. Set the Cloud Build substitutions if your project uses different names or region.

## Deploy

Run the build from the repository root:

```bash
gcloud builds submit --config cloudbuild.yaml .
```

The deployment intentionally disables unauthenticated access. Do not expose the worker's diagnostics publicly. If a separate dashboard API is needed, expose only authenticated, read-only endpoints and redact all provider credentials.

## Readiness gate

The repository currently contains the service/diagnostics foundation and a pure migration-aware exit-policy module. It does **not yet** contain a verified Helius live stream, official Pump SDK decoder/quote adapter, PumpSwap pool quote adapter, PostgreSQL event writer, or complete paper executor. The service must remain **not ready** until those adapters pass integration tests. A successful Cloud Run deployment is not proof that live paper trading is running.

Before enabling paper execution:
- verify launch, buy/sell and migration events against official Pump program interfaces;
- verify PumpSwap pool discovery and exact sell quotes after graduation;
- persist every event and quote before updating position state;
- use a database-backed singleton lease/advisory lock;
- recover open positions and stop levels after restart;
- confirm zero token balance in the simulated ledger before releasing a slot;
- test graceful SIGTERM handling and restart recovery.

## Cost and reliability

A Cloud Run service with minimum instances and instance-based CPU billing incurs charges while idle. Minimum instances are best-effort and instances can still restart. Keep durable state in PostgreSQL and design the worker to reconnect and resume; never rely on in-memory positions or timers as the source of truth.
