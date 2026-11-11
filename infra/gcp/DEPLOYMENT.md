# Google Cloud deployment plan

The Vercel project already exists and is linked to this repository. Google Cloud will host the persistent paper-trading worker; Vercel remains the operator dashboard.

## Target architecture

- Compute Engine VM running the Node.js 22 worker under systemd (one active worker).
- Cloud SQL for PostgreSQL ledger and quote/event history.
- Secret Manager for Helius/RPC credentials and database credentials.
- Cloud Logging and Monitoring alerts for stream disconnects, slot lag, quote failures, database errors, and invariant violations.
- Cloud Storage for compressed raw event archives and resumable checkpoints.
- Vercel dashboard reads sanitized, authenticated API data; it does not run the market listener.

The worker must be restart-safe and use a database-backed leader lease so a restart or accidental second VM cannot create duplicate positions. Persist checkpoints after bounded batches.

## Deployment prerequisites

1. Create/select a Google Cloud project and enable billing.
2. Enable Compute Engine, Cloud SQL Admin, Secret Manager, Cloud Logging, Cloud Monitoring, and Cloud Storage APIs.
3. Choose a region close to the RPC provider and database; keep VM and Cloud SQL in the same region.
4. Create a dedicated runtime service account with least-privilege access to only the required secrets, database connection, bucket, and logging.
5. Create Cloud SQL PostgreSQL and apply db/migrations.
6. Store provider and database secrets in Secret Manager. Never place credentials in Git, build args, instance metadata, or dashboard variables.
7. Provision a small VM, install Docker/Node 22, deploy the reviewed image, and enable the systemd unit.
8. Configure Vercel server-side API credentials and allow only authenticated read-only dashboard requests.

## Operational requirements

- No public PostgreSQL ingress.
- Restrict worker/API ingress; do not expose a write-capable trading API.
- Use TLS for database connections and authenticated dashboard-to-worker requests.
- Configure automatic VM restart and systemd restart-on-failure.
- Configure a health endpoint and alert if the worker misses heartbeats.
- Set budget alerts before provisioning billable resources.
- Back up Cloud SQL and test restore.
- Keep paper mode enforced in code and deployment IAM; no wallet signing keys are provisioned.

## Current status

This is a deployment blueprint, not a claim that Google Cloud resources have already been created. Project ID, region, billing, and cloud credentials must be supplied/configured in the user's Google Cloud account before provisioning.
