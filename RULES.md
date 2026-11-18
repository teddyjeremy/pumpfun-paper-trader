# Overnight paper rules

> **Research only — not the production paper strategy.** These one-minute candle-path comparisons are not authorized for forward paper fills. The production strategy remains the fail-closed 15-rule audit in `src/paper/strategy-audit.ts`. The standalone `npm run paper` polling mode is blocked until it uses fresh exact-size SDK quotes, verified sellability, complete risk evidence and the durable Worker journal.

No strategy is approved for forward paper entries. The earlier one-minute candle-path comparison favored a light-filter launch candidate, but the expanded 2026-11-14 risk replay supersedes it for risk-cleared decisions: 65 of 218 discovered launches were selected, only 2 reached a market-pattern setup, and **0 passed the complete risk gates**. Both setup candidates showed direct creator sales; wallet-cluster clearance remained UNKNOWN. The table below is retained as preliminary exploratory research only, not as a current profitability claim or an authorized strategy.

## What was compared

## Expanded risk replay — 2026-11-14

The completed replay artifact is recorded in [`data/helius/expanded-risk-replay-2026-11-14.json`](data/helius/expanded-risk-replay-2026-11-14.json) and comes from [GitHub Actions run #43715745622](https://github.com/teddyjeremy/pumpfun-paper-trader/actions/runs/43715745622).

- Discovery found **218** launches; the replay selected **65** (29.8%), chosen by highest activity rank rather than random sampling.
- All **65** selected launch collections completed; none was marked incomplete.
- **63** had no qualifying market-pattern setup.
- **2** reached a setup, but **0** were risk-cleared. Both were `RISK_NOT_CLEARED`.
- Both setup candidates had `creatorSellRiskStatus=REJECT_OBSERVED`; wallet-cluster risk remained `UNKNOWN` despite `NO_HIGH_CONFIDENCE_LINKS`. Absence of a detected link is not clearance without complete holder and wallet evidence.
- Their reserve-price outcomes are labeled `UNKNOWN`, with net return and round-trip cost left null. These are not strategy trades and must not be used to estimate executable expectancy.

This replay therefore provides **no eligible trade sample** for calibration or strategy promotion. Keep the production Worker paused and retain all mandatory creator, cluster, quote, freshness, and persistence gates. The sample is still activity-biased and cannot establish population-wide performance.


Source: `data/helius/tokens.csv`, 746 pump.fun tokens from 2026-11-08 through 2026-11-14. Price paths exist for the coins GeckoTerminal/GMGN still had candles for. **409 tokens have no path and are excluded from every pnl number.** Day counts are piled on Nov 13–14 (283 and 431). Nov 8–12 together are 32 tokens. Holdout is **2026-11-14**. Train is everything earlier.

Costs used on every fill, from the live fee config and recent pump transactions:

- Venue fee **125 bps per side** (bonding curve is 95 protocol + 30 creator; low-mcap PumpSwap is the same total).
- **30 bps** extra per side for slippage on a tiny order.
- **15,000 lamports per transaction** (the 75th percentile of landed pump fees, base fee included). Two signatures, so **$0.0022** round trip at SOL **$73.50**.
- New token-account rent **1,488,440 lamports ($0.109)**. Closing the account returns it. Rent is locked capital, not a loss, unless the sell never lands.

Round-trip variable cost is **3.08%** of stake. At a **$0.35** stake the all-in cost is about **$0.013** plus the locked rent.

| Family | Rule | Train trades | Train expectancy | Holdout trades | Holdout expectancy |
|---|---|---:|---:|---:|---:|
| Launch, no rug filter | Buy the 1-minute price, sell at 2x or 15 min | 65 | $0.035 | 102 | $0.020 |
| **Launch + light rug filter (default)** | Same, skip early dev sells and creator hold above 8% | 57 | $0.034 | **77** | **$0.029** |
| Launch + strict rug filter | Also require 11 buyers in 60s, top-10 excl. LP under 70%, launch-slot buyers under 6, bundler rate under 0.3 | 24 | $0.062 | 24 | $0.037 |
| Momentum | Buy the 5-minute print only after a 20% run-up | — | $0.037 | 49 | **-$0.004** |
| Graduation | Same 1-minute entry, only coins that reached PumpSwap | — | $0.043 | 36 | $0.026 |
| Copy-trading | Buy when tracked wallets cluster | not tested | — | not tested | — |

The earlier candle-path table did not include complete creator/cluster evidence or executable full-size SDK round-trip quotes. Its positive expectancy values are not risk-cleared trade outcomes. No candidate is selected for forward execution.

Momentum's holdout expectancy is negative. It is not enabled.

Copy-trading is not enabled. `wallets.json` keeps all 61 supplied wallets. 51 of them show up on a single token, and the file has no per-mint buy times, so "N wallets within X seconds" cannot be simulated. Three repeat names have a positive rough pnl and no clustered-launch flag (`copyEligible: true`). They are not an entry signal.

## Portfolio sizing update (2026-11-16)

The research runner now uses the repository's agreed portfolio constraints rather than the earlier $0.35 / two-slot sizing used for the historical comparison table above:

- Starting simulated equity: **$2.70** (the repository's existing research bankroll; this is separate from the $1 initial position stake).
- Initial position stake: **$1.00**.
- Initial concurrent positions: **1**.
- At each achieved doubling of realized portfolio equity: add **one** concurrent slot and increase the next stake by **50%**.
- Maximum position stake: **$100**.
- A position keeps its slot occupied until its recorded exit; a mint can be entered only once.
- The historical runner scales each $1 reference-trade PnL to the stake active at that entry and reserves token-account rent while a position is open.

The historical comparison metrics in this document were generated with the older $0.35 stake and two-slot cap. They are retained as historical evidence, **not** presented as results under the new sizing policy. The checked-in `data/helius/backtest-report.json` explicitly labels its embedded portfolio/throughput figures as stale; regenerate it with `npm run backtest:rules` before using any portfolio metrics. The generated `chosen-strategy.json` is marked research-only and `authorizedForPaperTrading=false` because the expanded risk replay has zero risk-cleared candidates. This remains candle-path research only: no output from this runner authorizes a Worker entry or relaxes creator/cluster, freshness, calibration, exact-size quote, sellability, cost, or durable-journal gates.

## Preliminary candidate entry rules (not authorized)

1. Wait until **1 minute** after launch. Do not buy the create slot. A 5% stop cannot save a same-block rug, and these paths are 5-minute snapshots, so the first tradable print we trust is the 1-minute price.
2. Reject the mint if **mint authority or freeze authority is still set**. In this file every coin that had a 1-minute price had already revoked both, so the filter did not change the backtest. Live, a set authority is a skip. Public RPC can read this with no Helius credits.
3. Reject if the creator **sold in the first 5 minutes** (`dev_sold_early_5m`, or a creator sell seen in the launch transactions).
4. Reject if the creator still holds **more than 8%** of supply.
5. Missing rug fields do not count as a pass or a fail, except authorities and the creator read on a live entry: if the create transaction cannot be read, the paper loop skips the mint.
6. Stricter flags were measured and not adopted as hard gates because they cut the book from 77 holdout trades to 24. When a later CSV supplies them, `maxTop10HolderPct`, `maxBundledBuyPct`, `min` unique buyers, and `maxCreatorPriorRugs` can be tightened without a code change. The shipped thresholds for those columns are deliberately loose (top-10 100, prior rugs 99) so they do not pretend the strict filter won.

## Preliminary candidate exit rules (not authorized)

- **Take profit: +100%** (sell at 2x the 1-minute price).
- **Stop: -5%** from the entry price. On these 5-minute snapshots the next print often gaps through that stop. Holdout losers exited at about **-$0.087** on a $0.35 stake (about **-25%** of the position, not -5%, and not -100%). Worst holdout print was **-81%**. Train losers averaged about **-19%** of the position. The stop is there so a loser is a partial loss. It does not cap the loss at 5% when the candle gaps.
- **Trailing stop is not active** before the take-profit. Arming it earlier gave back the 2x winners this sample depends on.
- **Max hold: 15 minutes.** Whatever is left is sold at the 15-minute print, or at the 5-minute print if that is the last one we have.

## Size, fees, and why 500 trades a day is not the plan

- Bankroll **$2.40**.
- Stake **$0.35**.
- **2** positions at once.
- Daily kill switch: stop opening new trades after equity is **20%** under the UTC day's starting equity. It did not fire on the holdout day.
- Rent of **$0.11** per open token account comes back when the account is closed. Two open positions lock about $0.22 on top of the stakes.
- The smallest stake whose fixed network fee is smaller than this sample's per-trade edge is only a few cents. That is not a useful live size: rent is $0.11 and a gap can take most of the position. **$0.35** is the size that was actually simulated.

Holdout, after the two-slot cap: **60 trades taken**, 17 skipped, ending equity **$4.24** from $2.40, max drawdown **17.5%**. That is one biased day of coins that already had charts, not a forecast.

**500 trades a day is not supported.** The entire holdout day produced 77 qualified signals before the slot cap, and 60 after it. Filling every 15-minute slot would still require a stream of setups this sample does not contain. The other ~350 Nov 14 tokens in the file have no price path; treating them as winners would be made up.

## Holdout vs train (default rule, $0.35, after fees)

| | Train (through Nov 13) | Holdout (Nov 14) |
|---|---:|---:|
| Trades | 57 | 77 |
| Win rate | 38.6% | 40.3% |
| Average win | $0.193 | $0.201 |
| Average loss | -$0.065 | -$0.087 |
| Expectancy | $0.034 | $0.029 |
| Total pnl | $1.97 | $2.22 |

Wins are large because the target is 2x. Most trades do not hit it (holdout: 12 take-profits, 36 time stops, 29 stops or gaps).

## How to run

```bash
npm run backtest:rules      # rewrites data/helius/backtest-report.json
npm run paper -- --replay   # holdout day only
npm run paper -- --once     # one live poll, paper fills only
npm run paper               # leave it running
```

`npm run paper -- --live` exits. Nothing in this command signs or sends a transaction.

`HELIUS_API_KEY` is optional. If it is set, the poll may call Helius `getAssetBatch` for new mints, 10 credits a call, cached on disk, and it stops at 400 credits for the session. Mint and freeze flags are also read from public RPC, which needs no key. The bot still runs with the key unset.

`RUG_SIGNALS_CSV` can point at a later file with `mint`, `dev_sold_pct`, `top10_holder_pct`, `bundled_buy_pct`, `honeypot`, `creator_prior_rugs`, and the other columns parsed by `parseRugCsv`. An empty cell does not reject the mint.
