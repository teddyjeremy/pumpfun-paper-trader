# Paper-session recording and bankroll rules

## Bankroll policy
- Initial simulated bankroll: USD 2.70.
- If marked portfolio equity is strictly below USD 1.00, add USD 2.70.
- Exactly USD 1.00 does not trigger a top-up.
- Record every top-up immutably: sequence, timestamp, replenishment number, balance before, amount, balance after, cumulative top-ups and cumulative contributed capital.
- Never erase losses or represent a top-up as trading profit.
- Reports must separate initial bankroll, top-up count, total top-ups, total capital contributed, current equity, realized PnL and return against contributed capital.

## Required session journal
Each session needs a unique ID, UTC start/end, strategy/config version and durable monotonic event sequence. Preserve:
1. Session start/stop, worker restarts, provider connections and heartbeats.
2. Every discovered mint, raw provider event reference, creator, curve, launch/migration times and verification.
3. Every market observation: source, slot/signature, observed/received timestamps, price, quote volume, buys/sells, unique buyers/sellers and coverage.
4. Every feature snapshot: impulse, pullback depth/duration, pullback low, reclaim, per-window buy/sell volume, buyer/seller counts, largest-buyer share and signal age.
5. Every strategy evaluation, config thresholds, per-rule PASS/FAIL/UNKNOWN, final decision and exact rejection reasons.
6. Risk evidence and coverage, including creator, linked wallets, holder concentration and unknown states.
7. Every quote request/result, age, size, route, token/SOL amounts, impact, slippage, network/protocol/creator fees and failures.
8. Every paper order, simulated fill, position update, mark, exit trigger/fill, costs and realized/unrealized PnL.
9. Every bankroll top-up and equity snapshot.
10. Every rejected/watch candidate's follow-up observations, peak price/time, multiple from rejection-time and discovery prices, 1.5x/2x/3x milestones, time-to-milestone and follow-up completeness.
11. Every dropped event, queue overflow, provider outage, reconnect, missing window, persistence failure and recovery.

## Missed-candidate outcomes
- Rejection must never delete a candidate's session history.
- Keep discovery price separate from decision-time price. A 3x from launch may still be a poor entry after a large pre-rejection run.
- Label follow-up COMPLETE, PARTIAL or MISSING. No observations means MISSING, not a loser.
- The ten Helius slots cannot guarantee continuous follow-up for every launch. Explicitly record coverage and gaps; never present incomplete outcomes as complete.
- Preserve raw observations separately from derived features and decisions for replay.

## Six-hour acceptance gate
The journal must be append-only, paginated, restart-safe, exportable and retained beyond the run. A rolling latest-N array is insufficient. Use partitioned durable pages or a database event table, idempotent event IDs and monotonic sequence numbers. Test restart during append, duplicate delivery, pagination boundaries, quota failures and export/replay.

IMPORTANT: src/paper/session-ledger.ts currently provides deterministic bankroll and candidate-outcome calculation primitives only. It is NOT yet connected to the Cloudflare Durable Object, discovery stream, Helius observations, decision engine or paper executor. The six-hour paper session remains blocked until that integration and its acceptance tests are complete.
