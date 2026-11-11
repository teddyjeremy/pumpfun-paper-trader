# Pump.fun Paper Trader

A **paper-only** Pump.fun trading research and execution system. It does not sign transactions, hold a wallet key, submit real transactions, or use a real trading balance.

## Current status

This repository is an observability-first foundation. The migration-aware exit policy, schema extension, CI tests, dashboard shell and Google Cloud deployment scaffold are being added. Live Helius ingestion, official Pump SDK decoding/quotes, PumpSwap quotes, durable event writes and the complete paper executor are still required. Until those adapters are connected and verified, readiness must remain **not ready** and no fills may be simulated from invented prices.

## Trading rules

- Entries are allowed only while a token is on its Pump.fun bonding curve and passes the **original strategy rules**. The experimental concentrated-flow/relaxed entry path is not used.
- A position may remain open after graduation. Graduation is a venue transition, **not** an automatic sell signal.
- At graduation, the position manager must discover and verify the canonical PumpSwap pool, switch quote/market-data sources, and continue monitoring the existing position there.
- New entries are never opened on already-graduated tokens.
- There is **no maximum holding-time exit**. A position remains open until a defined dynamic sell signal or protective stop is triggered.
- Existing hard stop, trailing-stop and profit-lock rules remain active after migration.
- A reduction in buying is not sufficient by itself to sell. The initial dynamic paper-exit proposal requires a 50% or greater buy-volume decline versus the preceding three 5-second windows, plus sell volume at least 1.5x buy volume, more sellers than buyers, and non-positive price change in each of the latest three completed 5-second windows. These are initial test parameters, not proven optimal thresholds.
- If a sell signal occurs during migration handoff, preserve the signal and wait for a verified PumpSwap pool and fresh sell quote. Never fabricate an exit.
- A position slot is released only after the simulated sell is recorded and the position ledger confirms zero remaining token balance.
- One active position per mint; never buy the same coin twice.

## Initial paper settings

- Starting paper balance: $8.00
- Initial position principal: $1.00
- Initial maximum concurrent positions: 1
- No private key required
- No maximum holding time

The previously agreed portfolio-doubling position/stake schedule must be implemented and tested before increasing concurrency or stake. The safe initial setting remains one open position.

## Safety invariants

1. New entries are bonding-curve-only and must pass the original strategy's price, flow, wallet, creator, cluster and execution-cost rules.
2. Existing positions may continue on the canonical PumpSwap pool after graduation; migration alone never closes a position.
3. No new entries after curve completion or migration.
4. Unknown fees, missing/stale quotes, failed sellability checks, or missing critical risk data mean **skip** for entry.
5. A sell signal is not a fill. Record a fill only from a fresh, verified venue-specific quote and the configured paper latency model.
6. Net PnL includes protocol/creator fees, network/priority fees, price impact and slippage.
7. Money uses integer raw units / lamports and exact decimal arithmetic, never binary floating-point for accounting.
8. No real transactions or wallet signing exist in this project.

## Results and failure analysis

The system must expose:
- health/readiness and provider connectivity;
- event counters, ingestion lag, quote latency, stale quote rate and failures;
- every candidate's decision and exact rejection reasons;
- open positions, migration handoffs, active stops and sell signals;
- quote snapshots, cost breakdown and realized net PnL;
- categorized errors (provider, decode, risk, quote, execution simulation, graduation, persistence);
- a diagnostic summary of the highest-volume failure categories.

The dashboard must distinguish **no opportunity**, **rejected opportunity**, **provider outage**, **migration handoff**, **exit signal awaiting quote**, **unexecutable exit**, and **strategy bug**.

## Configuration and development

Copy `.env.example` to `.env`. Keep API keys out of source control. Use Google Cloud Secret Manager for deployed credentials.

- Node.js 22
- TypeScript strict mode
- Fastify API
- Zod configuration validation
- Pino structured logs
- Vitest
- PostgreSQL append-only ledger
- Vercel operator dashboard
- Google Cloud persistent worker

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Deployment

- Vercel hosts the operator dashboard/API adapter: https://pumpfun-paper-trader.vercel.app
- Google Cloud hosts the persistent market worker and position manager.
- See [docs/GOOGLE_CLOUD.md](docs/GOOGLE_CLOUD.md).

A successful deployment is not proof that live market adapters are working. Do not enable paper execution until readiness is true and the quote, migration, persistence and recovery tests pass.

## Disclaimer

This is a research and simulation tool, not investment advice. Paper fills are estimates, not evidence of real-world profitability.
