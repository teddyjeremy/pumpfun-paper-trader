> **DEPRECATED — DO NOT USE FOR THIS DEPLOYMENT.** Google Cloud was dropped because this project must remain zero-cost and must not require a payment card. No GCP resources were provisioned. Use [the Cloudflare Free deployment guide](../cloudflare/DEPLOYMENT.md) instead. The remainder of this file is retained only as historical reference.

# Google Cloud deployment guide

## Deployment target

- **Compute Engine:** one small persistent Node.js 22 VM for the always-on market worker. The worker uses a single database-backed leader lease before it is allowed to process entries.
- **Neon PostgreSQL:** reuse the existing dedicated `pumpfun-paper-trader` database in Singapore for the first deployment. Do not create Cloud SQL yet; that would duplicate database cost and require a data migration.
- **Secret Manager:** Helius API key and Neon pooled `DATABASE_URL`.
- **Cloud Logging / Monitoring:** worker logs, heartbeat and alerting.
- **Vercel:** protected operator dashboard. It reads the ledger through its server-side database connection; no public write API is exposed.

Use `asia-southeast1` (Singapore) as the initial Compute Engine region/zone family to keep the worker near the existing Neon region. Confirm the actual Neon region and Helius endpoint latency before choosing a zone.

## Important readiness gate

This repository is still a foundation, not a complete live market worker. Discovery, official Pump.fun transaction decoding, current buy/sell quote integration, the full entry/exit loop, durable trade writes, and restart-safe leader lease must be implemented and tested before the VM is treated as an operating paper trader. Deploying the current server only proves that the service process can start; it does not mean coins are being monitored or trades are being simulated.

Keep `PUMPFUN_MODE=paper`. No wallet signer or transaction-submission key belongs in Google Cloud.

## Step 1 — Create or select the Google Cloud project

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a dedicated project, or select the project you intend to use.
3. Enable billing for that project.
4. Record the **Project ID** (not the display name) and project number.
5. In Billing → Budgets & alerts, create a monthly budget with alerts at 50%, 90%, and 100%. A budget alert is not a hard spending cap.

Do not provision a VM until the project and billing account are confirmed.

## Step 2 — Enable required APIs

In Cloud Shell, after selecting your project, run:

```bash
gcloud config set project YOUR_PROJECT_ID

gcloud services enable \
  compute.googleapis.com \
  secretmanager.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  iap.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com
```

Replace `YOUR_PROJECT_ID` with the actual project ID. Do not paste API keys or database URLs into Cloud Shell command history.

## Step 3 — Create the runtime service account and secrets

Create a dedicated runtime service account for the VM. Grant it only:
- Secret Manager Secret Accessor on the specific Helius and database secrets.
- Log Writer.
- Monitoring Metric Writer, if custom heartbeat metrics are used.

Create these secrets in Secret Manager:
- `helius-api-key`
- `paper-trader-database-url`

Add the Helius API key and the existing Neon **pooled** connection string through the Secret Manager Console's secret-value form. Never commit them, put them in GitHub variables, or send them in chat.

The VM service account must be able to read these two secrets. The GitHub deploy identity must not be granted access to their values.

## Step 4 — Create the VM

Use Compute Engine → VM instances → Create instance.

Initial conservative settings:
- Region: `asia-southeast1`
- Machine family: E2
- Start with a small instance; size up only after observing memory, CPU and stream throughput.
- Boot disk: balanced persistent disk, 20 GB.
- OS: Ubuntu LTS.
- Attach the dedicated runtime service account.
- Keep port 8080 closed to the public internet.
- Use IAP for SSH administration; do not open SSH to `0.0.0.0/0`.
- If the VM has an external IP for outbound RPC/database connectivity, keep inbound firewall rules restricted to IAP SSH only.

Install Node.js 22, Git, and the project under `/opt/pumpfun-paper-trader`. Install the systemd unit from `infra/gcp/paper-trader.service`. Configure the service to read its environment from a root-owned file under `/etc/pumpfun-paper-trader/`, populated from Secret Manager at setup/restart. The file must be mode 0600 and owned by root.

Required runtime environment:
- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT=8080`
- `PUMPFUN_MODE=paper`
- `HELIUS_API_KEY` from Secret Manager
- `DATABASE_URL` from Secret Manager
- the approved paper portfolio settings

Do not expose the worker's write-capable API publicly. Until an authenticated read-only interface is implemented, keep the service port private and use local health checks over IAP.

## Step 5 — Configure GitHub Actions Workload Identity Federation

Use Workload Identity Federation (WIF), not a long-lived service-account JSON key.

1. Create a Workload Identity Pool and OIDC provider for GitHub.
2. Restrict the provider condition to repository `teddyjeremy/pumpfun-paper-trader` and the protected `main` branch.
3. Create a separate deploy service account.
4. Grant the GitHub principal only the permissions required for IAP SSH/OS Login and restarting the VM service.
5. In GitHub repository Settings → Secrets and variables → Actions → Variables, configure:
   - `GCP_PROJECT_ID`
   - `GCP_WIF_PROVIDER`
   - `GCP_DEPLOY_SERVICE_ACCOUNT`
   - `GCP_VM_INSTANCE`
   - `GCP_VM_ZONE`
6. Keep the runtime service account separate from the deploy service account.

The manual workflow `.github/workflows/deploy-gcp.yml` deploys the current `main` branch to a VM that has already been provisioned. It does not create the project, VM, firewall, secrets, database or service account.

## Step 6 — Database and dashboard

The existing Neon database is separate from the worker VM. Before applying migrations:
1. Verify the Neon project and database.
2. Take a backup or create a Neon branch.
3. Review both `db/migrations/0001_initial_ledger.sql` and `0002_migration_aware_dynamic_exits.sql`.
4. Apply them only after explicit approval for the production database.
5. Confirm the latest schema migration is `0002_migration_aware_dynamic_exits`.

The dashboard's persistent portfolio endpoint requires both migrations. It reports:
- Full token mint/CA, name and symbol.
- Open positions with token quantity, principal, market phase, venue and active stop.
- Unrealized SOL only when a successful sell quote no older than 15 seconds covers the full remaining token quantity.
- Realized SOL/USD from closed ledger positions, fees, exit reason and zero-balance confirmation.
- Buy/sell trade history, amounts, fees, impact, slippage and simulated latency.

Unrealized USD remains unavailable until a timestamped SOL/USD price source is integrated and persisted. The dashboard must never substitute a chart price or stale quote for an executable sell quote.

## Step 7 — Verify before operating

- Confirm `/health` returns paper mode.
- Confirm `/ready` remains false until every required adapter and persistence invariant is implemented.
- Confirm PostgreSQL connection and migration version.
- Confirm the worker heartbeat and leader lease.
- Confirm no wallet signer, private key, or transaction submission code is present.
- Confirm a restart does not duplicate an entry or lose an open position.
- Confirm a missing/stale sell quote marks the position as blocked rather than closed.
- Confirm migration does not trigger an automatic sell.

## Cost and safety controls

- Reuse Neon initially; do not add Cloud SQL until a measured need justifies it.
- Set a budget alert before VM creation.
- Stop/delete the VM if it is not being used; persistent disks and reserved IPs can continue to incur charges.
- Keep database ingress private to approved credentials and TLS.
- Do not store secrets in repository files, GitHub plain variables, build arguments, logs, or dashboard HTML.
- Keep paper mode enforced in code and deployment configuration.
