# Pump.fun Paper Trader

A **paper-only** Pump.fun bonding-curve trading research and simulation system. It does not sign transactions, hold a wallet key, submit transactions, or execute real trades.

## Current status

This repository is the project foundation for a persistent paper-trading worker and operator dashboard. The Vercel project is already linked to this repository. Google Cloud deployment is scaffolded in `infra/gcp`; cloud resources have not yet been provisioned. Live discovery, official SDK quote integration, durable execution, and the full market-data loop remain implementation milestones. Until all required adapters and the ledger are verified, readiness must remain false and the system must not invent fills.

## Fixed initial paper portfolio

- Starting balance: **$2.70**
- Initial position principal: **$1.00**
- Initial maximum open positions: **1**
- Capacity increases by one at each portfolio-growth milestone (about $5, $10, $20, etc.); stake increases 50% at each milestone and is capped at $100. The deterministic policy is implemented in `src/strategy/portfolio-policy.ts`.
- A position slot is released only after a valid simulated exit and zero token balance confirmation.
- No maximum holding duration.
- No private key or real transaction capability.

## Strategy

The strict original entry strategy is the only enabled entry path. The experimental concentrated-flow relaxation is excluded. See [docs/STRATEGY.md](docs/STRATEGY.md).

Entry is limited to non-migrated Pump.fun bonding-curve tokens. If a held token graduates, migration is a market-state transition, **not an automatic sell**. The position must be monitored on a verified migrated market and exited using the same protective/dynamic exit manager. See [docs/MIGRATION_AND_DYNAMIC_EXITS.md](docs/MIGRATION_AND_DYNAMIC_EXITS.md).

## Safety invariants

1. Paper mode is enforced in code. No wallet signer or transaction submission exists.
2. Only Pump.fun bonding-curve tokens may be entered; migration while holding does not force an immediate exit.
3. Missing critical risk evidence, stale market data, unknown costs, missing quotes, or failed sellability checks block new entries.
4. Never fabricate a fill from chart prices, reserve-delta proxies, or stale quotes.
5. Net PnL includes protocol/creator fees, network/priority fees, impact, slippage, and simulated latency.
6. Accounting uses integer raw units / decimal arithmetic, never binary floating-point.
7. One active worker leader lease and idempotent entry/exit transitions prevent duplicate positions.
8. A migration or temporary quote outage never silently closes a position or releases a slot.
9. A global paper kill switch blocks new entries but continues monitoring open positions.

## Deployment layout

- **Google Cloud:** persistent Node.js 22 worker, PostgreSQL ledger, Secret Manager, Cloud Logging/Monitoring, and Cloud Storage checkpoints/archive.
- **Vercel:** protected operator dashboard and read-only API surface. It does not host the always-on market listener.
- Deployment blueprint: [infra/gcp/DEPLOYMENT.md](infra/gcp/DEPLOYMENT.md).

## Development

- Node.js 22
- TypeScript strict mode
- Fastify API
- Zod configuration validation
- Pino structured logs
- Vitest
- PostgreSQL persistence

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Readiness

The service intentionally reports not-ready until live discovery, verified curve/pool quotes, risk evidence, and durable ledger adapters are connected. See [docs/OPERATIONS.md](docs/OPERATIONS.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Disclaimer

This is a research and simulation tool, not investment advice. Paper fills are estimates, not evidence of real-world profitability. A successful deployment or multi-hour run validates integration and operations, not strategy profitability.
