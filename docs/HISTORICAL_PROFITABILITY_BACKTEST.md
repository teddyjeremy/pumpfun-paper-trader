# Historical strategy profitability backtest

## Run

After restoring a completed historical collection artifact into `artifacts/`:

```bash
npm run backtest:profitability -- --date=YYYY-MM-DD --round-trip-cost-pct=4
```

The command writes `artifacts/pump-profitability-backtest-YYYY-MM-DD.json`.

## Two separate result tracks

1. **Strict strategy track** applies the 15-rule `evaluateStrictStrategyAudit` used by the paper strategy. Only a `BUY` decision is admitted to the portfolio ledger. `WATCH` candidates remain unfilled when evidence is missing; `REJECT` candidates are excluded. The portfolio ledger uses the current $2.70 paper starting balance, $1 initial stake, one initial slot, 50% stake growth at each doubling from $5 growth equity, and the $100 stake cap.
2. **Research price-path proxy** starts from the historical reclaim/flow pattern and replays the repository's hard stop, profit locks, trailing stop, and dynamic-exhaustion rules against observed Pump reserve-ratio prices. It is reported separately and never promoted into strict strategy PnL.

## Strict entry audit

The audit requires all 15 rules to pass: candidate age, +20% impulse, 10–40% pullback, +1% reclaim, three consecutive 2-second flow windows sampled one second apart, at least five distinct buyers, no buyer above 72%, creator-sale clearance, complete wallet/holder clearance, at least 70% attribution confidence, reviewed pullback/reclaim volume thresholds, 1–2 second signal freshness with next-observation confirmation, a fresh executable quote, and round-trip cost at or below 4%.

Missing evidence is `UNKNOWN`/WATCH, never an implicit pass. Reviewed volume thresholds require a separately approved chronological training/holdout calibration.

## Important limitations

The collected historical artifacts contain verified Pump trade events and reserve observations, not historical size-specific SDK BUY and full-balance SELL quotes. They also do not contain the complete historical wallet/holder evidence, reviewed volume calibration, or the exact per-trade network/priority/provider/rent cost estimates needed to prove an executable historical fill.

Therefore:
- Reserve-price proxy returns are estimates, not realized or executable PnL.
- The configured 4% round-trip haircut is a scenario assumption, not a recovered per-trade fee.
- Open-at-horizon proxy positions are marked, not realized exits.
- Only strict `BUY` rows enter the portfolio ledger; research-only price paths cannot inflate strategy PnL.
- The discovery sample is activity-ranked, so results do not represent all Pump launches.

Do not use the proxy result as evidence to enable real-money execution. A full execution-grade profitability backtest needs historical executable quote/fee snapshots and complete risk evidence at each candidate timestamp.
