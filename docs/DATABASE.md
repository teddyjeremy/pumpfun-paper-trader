# PostgreSQL persistence

The paper trader has a dedicated Neon project named `pumpfun-paper-trader` in `aws-ap-southeast-1` (Singapore). It is separate from the user's other Neon projects.

## Connection handling

- Vercel Production has an encrypted `DATABASE_URL` environment variable.
- Never commit the URI, paste it into logs, or expose it through an API response.
- The Google Cloud worker must receive the same credential through Secret Manager when it is provisioned.
- Use a pooled Neon connection string for application traffic.
- The Vercel function uses a small PostgreSQL pool and short connection timeout.
- The dashboard exposes only configured/connected/schema-ready booleans and the latest migration version.

## Initial ledger

`db/migrations/0001_initial_ledger.sql` creates:
- tokens and time-series token snapshots
- risk assessments and opportunity decisions
- exact execution quote and fee records
- positions and trades with a zero-balance close invariant
- market-window aggregates
- provider health and append-only system events
- schema migration tracking

All on-chain amounts are represented as integer base units / lamports or exact PostgreSQL NUMERIC values. Do not use JavaScript floating-point values for ledger accounting.

## Migration status

The initial schema was prepared and successfully tested on an isolated Neon temporary branch on 2026-11-04. The production `main` branch has not yet received the migration. Apply it only after the operator explicitly approves the production database change. The temporary test branch must be finalized (apply or discard) so it is cleaned up.

## Current limitations

The database connection diagnostic is wired into the dashboard, but the trading pipeline does not yet write opportunities, quotes, positions, or trades. Do not interpret an empty ledger as zero losses or zero profit. The dashboard must continue to show unavailable PnL until real paper executions are persisted.
