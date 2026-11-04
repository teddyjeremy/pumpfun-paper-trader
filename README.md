# Pump.fun Paper Trader

A **paper-only** Pump.fun bonding-curve research and execution simulator. It does not sign transactions, hold a wallet key, submit transactions, or route to PumpSwap.

## Current status

This repository starts as an observability-first foundation. Live launch ingestion, official SDK quote integration, persistence, and the dashboard are implemented in subsequent milestones. Until those adapters are connected and tested, the service must report itself as **not ready** and must not simulate fills from invented prices.

## Fixed paper portfolio

- Starting balance: $8.00
- Position principal: $1.00
- Maximum open positions: 3 ($3.00 allocated maximum)
- Maximum one buy in flight; sells may run concurrently (maximum 3)
- A slot is released only after the sell is complete and token balance is confirmed zero
- Maximum holding time: 60 seconds (initial experiment)
- No private key required

## Safety invariants

1. Only Pump.fun bonding-curve tokens are eligible.
2. Never trade PumpSwap or migrated tokens.
3. Graduation stops new entries. If the curve is unavailable at exit, record an unexecutable exit; never fabricate a fill or route elsewhere.
4. Unknown fees, missing quotes, stale quotes, failed sellability checks, or missing critical risk data mean **skip**.
5. Net PnL includes entry/exit protocol and creator fees, network/priority fees, price impact, and slippage.
6. Money uses integer raw units / decimal arithmetic, never binary floating-point for accounting.
7. No real transactions or wallet signing exist in this project.

## Results and failure analysis

The service is designed to expose:
- health/readiness and provider connectivity;
- event counters, ingestion lag, quote latency, stale quote rate and failures;
- every candidate's decision, risk/momentum scores and exact rejection reasons;
- paper positions, quote snapshots, cost breakdown and realized net PnL;
- categorized errors (provider, decode, risk, quote, execution simulation, graduation, persistence);
- a diagnostic summary that identifies the highest-volume failure categories.

The dashboard must distinguish **no opportunity**, **rejected opportunity**, **provider outage**, and **strategy bug**. A quiet bot is not automatically a broken bot.

## Configuration

Copy `.env.example` to `.env`. Keep API keys out of source control. In Google Cloud, use Secret Manager and grant the runtime service account access to the secret. Never paste keys into GitHub issues or commits.

## Development

- Node.js LTS
- TypeScript strict mode
- Fastify API
- Zod configuration validation
- Pino structured logs
- Vitest
- PostgreSQL persistence (migration/adapter milestone)
- Next.js dashboard (dashboard milestone)

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Readiness

The initial service intentionally starts in safe degraded mode until live provider adapters and quote verification are configured. See [docs/OPERATIONS.md](docs/OPERATIONS.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Disclaimer

This is a research and simulation tool, not investment advice. Paper fills are estimates, not evidence of real-world profitability. A three-hour run is an integration smoke test, not a strategy validation.


## Vercel dashboard deployment

The operator dashboard is deployed as a stateless Vercel Node.js function. The deployment is for viewing diagnostics and the current process snapshot; it is **not** the always-on Pump.fun listener or paper execution worker. In-memory counters reset between serverless instances and must not be treated as durable trading history.

Production dashboard: https://pumpfun-paper-trader.vercel.app

The Vercel project uses Node.js 22.x and Singapore function region. Deployment Protection is enabled for the default Vercel domains. Keep it protected unless you intentionally configure an authenticated public dashboard.

The persistent market worker, provider stream, and PostgreSQL ledger belong on Google Cloud (or another persistent runtime). Connect that worker to durable storage and expose a narrowly scoped authenticated dashboard API before presenting live results.
