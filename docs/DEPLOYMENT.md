# Deployment architecture

## Vercel

Vercel hosts the operator dashboard and stateless Fastify API adapter. The dashboard is protected by the Vercel team's deployment protection on the default `.vercel.app` domains.

- Project: `pumpfun-paper-trader`
- Runtime: Node.js 22.x
- Function region: `sin1` (Singapore)
- Entrypoint: `api/index.ts`
- Routing: `vercel.json` forwards application paths to the Fastify handler

The function must remain read-only with respect to any trading authority. It must not sign or submit Solana transactions. Process-memory diagnostics are ephemeral in serverless environments.

## Persistent worker

Do not run the launch listener or position manager as a Vercel function. They need a persistent Google Cloud runtime, restart supervision, bounded reconnect logic, and durable PostgreSQL state.

The worker must use Secret Manager for provider credentials. The dashboard must read persisted, sanitized records through authenticated APIs; never expose Helius credentials, RPC auth headers, wallet secrets, or raw sensitive environment values.

## Deployment verification

A Vercel build reaching `READY` confirms only that the artifact built and deployed. Verify runtime routes (`/`, `/health`, `/ready`, `/api/diagnostics`, `/api/tracking`) and inspect runtime logs before calling the dashboard operational.

## Known follow-up

The first framework-detected deployment built but its runtime handler was invalid because Vercel treated `src/server.ts` as a Fastify entrypoint. The project framework was changed to generic Node.js function routing so `api/index.ts` is the explicit handler. A new deployment must be checked against runtime logs before declaring the fix verified.
