# Pump.fun Paper Trader

A **paper-only** Pump.fun strategy and execution research system. It never holds a wallet key, signs transactions, submits real orders, or uses real funds.

## Current status

This repository is an observability-first foundation. The original strategy and migration-aware position lifecycle are specified in [docs/STRATEGY.md](docs/STRATEGY.md) and [docs/MIGRATION_AND_DYNAMIC_EXITS.md](docs/MIGRATION_AND_DYNAMIC_EXITS.md). The pure exit and portfolio policies now have unit tests. Live Helius ingestion, official Pump SDK decoding/quotes, PumpSwap pool quotes, durable event writes and the restart-safe paper executor are still required. Until those adapters are connected and verified, readiness must remain **not ready** and no fills may be simulated from invented prices.

## Strategy decisions

- Keep the original strict entry strategy. The experimental concentrated-flow/relaxed entry path is excluded.
- New entries are permitted only on an active Pump.fun bonding curve.
- If a position is open when the coin graduates, migration changes the venue, not the sell decision. Verify the canonical PumpSwap pool, switch market data and quote source, and continue managing the existing position.
- There is no maximum holding-time exit.
- Keep the original -5% hard stop, +10% trailing activation, 40%-below-high trailing level and profit-lock ladder.
- Dynamic selling requires sustained, independently corroborated deterioration. A reduction in buys alone is not a sell signal.
- Initial paper portfolio: $2.70, $1.00 initial stake and one concurrent position. At about $5 equity, capacity becomes two and stake increases 50%; at about $10, capacity becomes three and stake increases another 50%. Stake is capped at $100. The policy is implemented in `src/strategy/portfolio-policy.ts`.
- A slot is released only after a valid simulated sell and zero token balance are confirmed. Never buy the same mint twice.

## Safety invariants

1. Paper mode is enforced in configuration. No wallet signing or real transaction submission exists.
2. Missing or stale critical evidence, unknown fees, missing executable quotes, or failed sellability checks mean **no new entry**.
3. Graduation alone never closes a position. A migrated position remains tracked through pool verification and quote handoff.
4. Never fabricate a fill from a chart price, reserve-delta proxy, or stale quote.
5. Net PnL includes protocol/creator fees, network/priority fees, price impact and slippage.
6. Money/accounting uses integer raw units and exact decimal arithmetic, not binary floating-point.
7. No time-based exit is permitted. Position age is telemetry only.

## Dashboard and deployment

- Vercel hosts the operator dashboard and read-only diagnostics surface.
- Google Cloud hosts the persistent worker under a supervised Compute Engine/systemd service, with Cloud SQL PostgreSQL, Secret Manager, Cloud Storage checkpoints and Cloud Monitoring.
- See [infra/gcp/DEPLOYMENT.md](infra/gcp/DEPLOYMENT.md).

The existing Vercel preview is for the operator UI only; it does not mean the live market worker is running. Do not enable paper execution until the readiness endpoint is true and the provider, quote, persistence, migration and restart-recovery tests pass.

## Development

- Node.js 22
- TypeScript strict mode
- Fastify API
- Zod configuration validation
- Pino structured logs
- Vitest
- PostgreSQL append-only event/quote/position ledger

```bash
npm install
npm run dev
npm test
npm run typecheck
```

Copy `.env.example` to `.env`. Keep provider/database credentials out of source control; use Google Cloud Secret Manager in deployed environments.

## Disclaimer

This is a research and simulation tool, not investment advice. Paper fills are estimates, not evidence of real-world profitability.
