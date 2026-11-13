# Zero-cost Cloudflare worker runtime

## Architecture

- Vercel Hobby: operator dashboard and read-only dashboard API.
- Neon PostgreSQL: authoritative paper-trading ledger and dashboard data.
- Cloudflare Workers Free plus one SQLite-backed Durable Object: persistent Helius WebSocket coordinator.
- GitHub: source of truth, CI, and manual deployment workflow.
- No AWS or Google Cloud VM: the Cloudflare Free account does not require a payment card.

The Durable Object subscribes to Pump.fun program logs through Helius. A one-minute Cron Trigger checks the coordinator, reconnects after a disconnect or runtime restart, and rotates the outbound WebSocket before Cloudflare's 15-minute outbound-connection keep-alive limit.

## Important: transport scaffold only

The current implementation establishes PumpPortal launch discovery, selective Helius monitoring, verified Pump transaction decoding, impulse/pullback/reclaim and trade-flow feature snapshots, creator/linked-wallet risk audits, and strict strategy decision logging. Read-only SDK quote endpoints exist for curve and PumpSwap markets. It does not yet:
- connect a passing strategy decision to the exact-size buy and initial full-size sell quote lifecycle;
- execute and persist simulated paper entries from the Worker scheduler;
- schedule full-position sell quotes and dynamic exit evaluation for open positions;
- connect migration-aware position monitoring and retry recovery to those scheduled exits;
- prove all fee categories and Token-2022 transfer-fee treatment for every supported mint.

The Worker deliberately reports `tradingReady: false`. It cannot place paper entries or exits. Do not mark the bot operational until those missing components are implemented, tested, and connected to the ledger. No wallet signer or transaction-submission key belongs in this Worker.

## Free-plan limits and capacity check

Current documented Workers Free / Durable Objects Free allowances:
- Workers: 100,000 requests/day, 10 ms CPU per invocation, 128 MB memory.
- Durable Objects: 100,000 requests/day, 13,000 GB-seconds/day.
- SQLite-backed Durable Object storage: 5 million row reads/day, 100,000 row writes/day, 5 GB stored data.
- Each Durable Object `setAlarm()` counts as one row write; the coordinator uses a 60-second idle alarm and avoids unconditional per-minute snapshots.
- Incoming Durable Object WebSocket messages use a 20:1 request-counting ratio.

One 128 MB Durable Object kept active for 24 hours uses approximately 10,800 GB-seconds/day (0.125 GB × 86,400 seconds), about 83% of the 13,000 GB-second daily allowance. This leaves limited headroom. The one-minute Cron Trigger is limited to one coordinator and one small health/reconnect call.

The WebSocket message quota is a separate risk: 100,000 billed requests/day is approximately 2 million incoming WebSocket messages/day before counting other Durable Object requests. Real Pump.fun stream volume must be measured before enabling strategy decisions. If free limits are exceeded, Cloudflare can reject further operations. Monitor daily usage and keep the bot fail-closed when data is incomplete.

Cloudflare can restart Durable Objects and does not provide a dedicated-VM uptime guarantee on the Free plan. The one-minute trigger provides recovery checks, not a contractual 24/7 SLA. Treat this as best-effort continuous hosting, not guaranteed uninterrupted service.

## Create the Cloudflare account

1. Create a free account at https://dash.cloudflare.com/sign-up. The Free account signup uses an email address and password; no payment card is required.
2. Open Workers & Pages in the dashboard.
3. Confirm the account is on the Free plan. Do not enable paid Workers, add-ons, or usage-based products.
4. Copy the Cloudflare Account ID from the account overview.

## Connect the operator dashboard

The Fastify dashboard proxies Worker status and start/stop controls server-side. After the Worker is deployed, set these environment variables on the dashboard host (for example Vercel):

- `PAPER_WORKER_URL`: the deployed Worker base URL, such as `https://pumpfun-paper-worker.YOUR_SUBDOMAIN.workers.dev`.
- `PAPER_WORKER_CONTROL_TOKEN`: the same long random value configured as the Worker `CONTROL_TOKEN` secret.
- `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD`: operator-only HTTP Basic credentials.

Never put the Worker control token in browser code or a `NEXT_PUBLIC_` variable. The dashboard start/stop buttons control live discovery monitoring only; they do not authorize simulated fills. The Worker remains `tradingReady: false` until strategy, executable quote, entry/exit scheduler and durable ledger integration are complete.

## Configure Worker secrets

From the repository root, set the secrets using Wrangler. Never paste these values into GitHub issues, source files, or ChatGPT.

    npx wrangler@4 secret put HELIUS_API_KEY --config infra/cloudflare/worker/wrangler.jsonc
    npx wrangler@4 secret put CONTROL_TOKEN --config infra/cloudflare/worker/wrangler.jsonc

- HELIUS_API_KEY: the Helius RPC API key.
- PUMPFUN_PROGRAM_ID is a public configuration value already set in wrangler.jsonc to the official Pump bonding-curve program address. It is not a secret.
- CONTROL_TOKEN: a long random bearer token used to protect start, stop, and status endpoints.

## Configure the Worker-to-Neon ingestion token

Set the same random token in both environments:
- Cloudflare Worker secret: `PAPER_EVENT_INGEST_TOKEN_V2`
- Vercel production environment variable: `PAPER_EVENT_INGEST_TOKEN_V2` (encrypted)

The Worker and Vercel API prefer the V2 name. The legacy `PAPER_EVENT_INGEST_TOKEN` remains a fallback during rotation. After changing either value, redeploy the Worker and Vercel app, then rerun the production ingestion smoke test. Never expose or commit the token.

## Pause and resume observation safely

Optional Worker secret: `PAPER_OBSERVATION_PAUSED`.

- Set it to `true` to close provider streams and pause collection without deleting the active paper session.
- Set it to `false` (or remove it) after the storage quota resets or capacity is increased; the one-minute coordinator check reacquires the PostgreSQL lease and reconnects.
- The pause flag does not create positions, alter the ledger, or authorize paper entries.

Use this when the Free plan's 100,000 Durable Object row-write daily allowance is exhausted. Cloudflare states that Free daily limits reset at 00:00 UTC; Workers Paid includes 50 million Durable Object row writes per month before usage charges. See the official [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) page.

## Deploy manually

    npx wrangler@4 deploy --config infra/cloudflare/worker/wrangler.jsonc

The first deployment creates the SQLite-backed Durable Object namespace and installs the one-minute Cron Trigger. Keep the Worker on the Free plan.

Start the coordinator only after the Helius and Pump.fun program secrets are configured:

    curl -X POST "https://pumpfun-paper-worker.YOUR_SUBDOMAIN.workers.dev/start" -H "Authorization: Bearer YOUR_CONTROL_TOKEN"

Check status:

    curl "https://pumpfun-paper-worker.YOUR_SUBDOMAIN.workers.dev/status" -H "Authorization: Bearer YOUR_CONTROL_TOKEN"

Stop the coordinator:

    curl -X POST "https://pumpfun-paper-worker.YOUR_SUBDOMAIN.workers.dev/stop" -H "Authorization: Bearer YOUR_CONTROL_TOKEN"

The public /health endpoint intentionally exposes only basic service state. All control and detailed status endpoints require the bearer token.

## GitHub Actions deployment

The workflow .github/workflows/deploy-cloudflare-worker.yml deploys only when manually dispatched against main. It installs the repository dependencies first so Wrangler can bundle the imported Pump SDK and Solana packages. Pushes and pull requests do not deploy automatically. Add these repository Actions secrets after creating the Cloudflare account:
- CLOUDFLARE_API_TOKEN: scoped to the account with Workers Scripts edit permission.
- CLOUDFLARE_ACCOUNT_ID: the account identifier.

Helius and control secrets are configured directly in Cloudflare and are not copied into GitHub Actions.

## Rollout gates

1. Deploy the transport scaffold and confirm /health reports a connected Helius stream.
2. Measure incoming notification rate and Cloudflare Workers/DO daily usage for at least 24 hours.
3. Decode Pump.fun transaction instructions and verify buy/sell amounts against independently checked signatures.
4. Implement the existing strategy without relaxing its thresholds.
5. Integrate executable quote checks, fee/impact limits, creator/cluster evidence, durable Neon writes, idempotency, and restart recovery.
6. Replay historical launches and confirm that incomplete/stale data cannot produce a BUY or simulated fill.
7. Only then allow the Worker readiness state to become true.

Do not apply production Neon migrations or enable trade simulation as part of the infrastructure smoke test.
