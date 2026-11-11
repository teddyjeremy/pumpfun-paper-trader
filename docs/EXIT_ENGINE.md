# Exit engine implementation

The evaluator and lifecycle are paper-only deterministic modules. They consume verified observations and never fetch data or execute transactions.

- New entries are permitted only while a Pump.fun bonding curve is active.
- Graduation changes the monitored market; it is never an automatic sell.
- Verify the migrated pool for the held mint and enabled venue (initially PumpSwap), and obtain a fresh size-specific sell quote before marking the position migrated.
- If verification or quoting fails, retain the position and slot as `exit_blocked`, alert and retry.
- Hard stop: -5% net return after modeled costs.
- Trailing activates after +10%; it sits 40% below the highest completed observation.
- Profit locks: +5% after +10%; +15% after +50%; +40% after +100%; +80% after +200%.
- Active stop is the maximum of hard stop, trailing floor, profit-lock floor and previously stored stop; it never moves down.
- Dynamic calibration v1 requires at least two independent bearish observations in each of two consecutive complete comparable windows. Candidate signals: buy/sell quote-volume ratio below 1.0; buy-volume decline >=40%; unique-buyer-rate decline >=40%; sell-volume expansion >=50%; price-response decline >=40%; liquidity decline >=20%; large-holder distribution detected.
- These are initial paper-calibration values, not statistically optimized thresholds. Missing metrics remain unknown, never zero. A triggered exit without a fresh full-position sell quote is blocked.
- There is no maximum holding duration. Position age is telemetry only.

The pure evaluator and lifecycle are unit-tested but must still be connected to verified Pump.fun/PumpSwap adapters, the durable ledger and paper executor before readiness can become true.
