# Exit engine implementation

The evaluator and lifecycle are paper-only deterministic modules. They consume verified observations and never sign or submit transactions.

- New entries are permitted only while a Pump.fun bonding curve is active.
- Graduation changes the monitored market; it is never an automatic sell.
- Verify the migrated pool for the held mint and enabled venue (initially PumpSwap), and obtain a fresh size-specific sell quote before an exit.
- If verification or quoting fails, retain the position, record the blocker and retry.
- Hard stop: -5% net return after modeled costs.
- Trailing activates after +10%; it sits 40% below the highest completed observation.
- Profit locks: +5% after +10%; +15% after +50%; +40% after +100%; +80% after +200%.
- Active stop is the maximum of hard stop, trailing floor, profit-lock floor and previously stored stop; it never moves down.
- Dynamic calibration v1 requires at least two independent bearish observations in each of two consecutive complete comparable windows. Candidate signals: buy/sell quote-volume ratio below 1.0; buy-volume decline >=40%; unique-buyer-rate decline >=40%; sell-volume expansion >=50%; price-response decline >=40%; liquidity decline >=20%; large-holder distribution detected.
- These are initial paper-calibration values, not statistically optimized thresholds. Missing metrics remain unknown, never zero. A triggered exit without a fresh full-position sell quote is blocked.
- There is no maximum holding duration. Position age is telemetry only.

## Worker integration

The Durable Object alarm now runs a paper-only exit pass every 5 seconds while any position remains open. For each position it:

1. Refreshes the authoritative Pump curve or canonical PumpSwap pool/vault state.
2. Requests a sell quote for the entire token balance.
3. Requires exact unsigned-message fee evidence and a fresh SOL/USD reference.
4. Runs the protective/dynamic evaluator and atomically records an exit when a configured stop triggers.
5. Defers HOLD marks until every remaining open position has a fresh sell quote; partial portfolio marks are not committed.

The Pump bonding-curve event decoder currently provides observed events, not proof of complete event-stream delivery. Those observations are therefore explicitly marked `OBSERVED_EVENTS_ONLY` and are rejected by the dynamic-exit evidence builder; they must not trigger dynamic exhaustion. A future collector must prove contiguous, complete event coverage before any 2/5/10/30-second window can be marked complete. PumpSwap trade-event decoding and large-holder distribution time series are also not connected. Pump curve observations are never relabelled as PumpSwap observations after migration. Protective stops remain active and still require a fresh full-position quote.

This integration is not paper-trading readiness by itself. Strategy volume-threshold calibration, complete wallet-history and holder-risk clearance, account/rent/fee budget verification, restart recovery, Neon persistence and dashboard confirmation remain required. `tradingReady` stays false until the full simulated entry-to-exit path is verified.
