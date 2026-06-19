# kha-ching (SignalX)

Algorithmic trading toolkit for systematic intraday trading on Indian stock markets via Zerodha's Kite Connect API.

## Tech Stack

- **Framework:** Next.js 16 (App + API routes), React 18, Material-UI 5
- **Language:** TypeScript 5 (mixed JS/TS codebase)
- **Database:** PostgreSQL via Drizzle ORM (`lib/drizzle.ts`, `lib/schema.ts`)
- **Queue:** BullMQ 5 with IORedis (`lib/queue.ts`, `lib/queue-processor/`)
- **Broker:** Zerodha Kite Connect (`lib/kiteUtils.ts`, `lib/broker.js`)
- **Auth:** next-iron-session (encrypted cookies)
- **Observability:** OpenTelemetry → Grafana Cloud (`otel.js`)
- **Server:** Express (`server.js`) with Bull Board at `/queues`
- **Package manager:** Yarn 4 (use `yarn`, not `npm`)

## Commands

```bash
yarn dev           # Dev server (with OTEL instrumentation)
yarn build         # Production build
yarn start         # Production server (sets TZ=Asia/Kolkata, runs bootup health check)
yarn lint          # Biome linter
yarn format        # Biome formatter
yarn test          # All tests (Jest)
yarn unit-test     # Unit tests only
yarn int-test      # Integration tests only
yarn drizzle:generate  # Generate DB migrations
yarn drizzle:push      # Apply migrations to DB
```

## Architecture

### Queue-Driven Trading

Trade execution is fully decoupled via BullMQ queues defined in `lib/queue.ts`:

- **tradingQueue** — Entry order placement (`lib/queue-processor/tradingQueue.ts`)
- **exitTradingQueue** — Exit order handling (`lib/queue-processor/exitTradingQueue.ts`)
- **ancillaryQueue** — Orderbook sync and housekeeping (`lib/queue-processor/ancillaryQueue.ts`)
- **targetPnLQueue** — Profit target logic (`lib/queue-processor/targetPnLQueue.ts`)
- **squareOffQueue** — Forced position closure (`lib/queue-processor/squareOffQueue.js`)

### Database Schema (`lib/schema.ts`)

Three main tables managed by Drizzle ORM:
- `tradePlans` — User-defined trade strategies and parameters
- `jobExecutions` — BullMQ job lifecycle tracking (plan reference FK)
- `accesstoken` — Zerodha session tokens

Query helpers live in `lib/drizzleDbUtils.ts`.

### Trading Strategies (`lib/strategies/`)

- `atmStraddle.ts` — ATM straddle (simultaneous PE + CE)
- `strangle.ts` — Strangle (offset strikes)

Each strategy resolves strikes, places orders, and schedules exit jobs.

### Exit Strategies (`lib/exit-strategies/`)

- `autoSquareOff.ts` — Time-based and PnL-based forced exit
- `individualLegExitOrders.ts` — Per-leg stop-loss and target orders

### Key Utilities

- `lib/utils.ts` — Option expiry calculation, strike selection, order placement wrappers
- `lib/constants.ts` — Instrument names, strategy enums, error strings
- `lib/kiteUtils.ts` — Kite Connect SDK wrapper with memoized instrument fetch (5–9 hrs)
- `lib/browserUtils.ts` — Frontend scheduling helpers, time conversion

## Environment Variables

Copy `.env.example` to `.env`. Required vars:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis endpoint |
| `KITE_API_KEY` / `KITE_API_SECRET` | Zerodha broker credentials |
| `SECRET_COOKIE_PASSWORD` | Session encryption (min 32 chars) |
| `TZ` | Must be `Asia/Kolkata` |
| `MOCK_ORDERS` | Set `true` to simulate orders without placing them |

## Docker

Production deployment uses multi-stage Docker build:

```bash
docker compose up          # Full local stack (Postgres, Redis, OTEL Collector, app)
docker compose up app      # App only (expects external Postgres/Redis)
```

Services in `docker-compose.yml`:
- `postgres:16-alpine` on port 5432
- `redis:7-alpine` on port 6379
- `otel-collector` for telemetry
- `app` (dev profile via `COMPOSE_PROFILES=local`)

Health check endpoint: `GET /api/health`

## Testing

```bash
yarn test           # All suites
yarn unit-test      # Faster, unit only (--detectOpenHandles)
yarn int-test       # Integration (needs running DB/Redis)
```

Test setup: `__tests__/setupEnv.ts`. Coverage collected from `pages/**` and `lib/**`.

## Code Style

- **Linter/Formatter:** Biome (not ESLint/Prettier) — configured in `biome.json`
- Line width: 100, indent: 2 spaces, trailing commas: ES5
- Pre-commit hook runs `biome check --staged --apply` via Husky
- Mixed JS/TS — new code should be TypeScript; types in `types/`

## Important Domain Notes

- All trading is Indian derivatives (Nifty, BankNifty, FinNifty options)
- Market timezone is `Asia/Kolkata` (IST) — always set `TZ` env var
- `MOCK_ORDERS=true` must be set in development to avoid real order placement
- Zerodha access tokens are stored in the `accesstoken` DB table and in encrypted session cookies
- Instruments list is cached aggressively (5–9 hours) via memoized Kite API calls

## File Map

```
lib/
  schema.ts          # Drizzle ORM table definitions
  drizzle.ts         # DB connection pool
  drizzleDbUtils.ts  # Query helpers (Drizzle ORM wrappers)
  queue.ts           # BullMQ queue instances
  queue-processor/   # Job handlers per queue
  strategies/        # Entry strategy logic
  exit-strategies/   # Exit/stop-loss logic
  watchers/          # Continuous order watchers (SLM, SLL)
  kiteUtils.ts       # Kite Connect wrapper
  utils.ts           # Core trading utilities
  constants.ts       # Enums, instrument names, error strings
pages/
  api/               # ~20 Next.js API routes
  dashboard.js       # Trading dashboard
  plan.tsx           # Plan creation/management
components/
  trades/            # Per-strategy form + display components
  lib/               # Shared UI components
types/
  trade.ts           # SUPPORTED_TRADE_CONFIG — core trade type
  plans.ts           # Trade plan shapes
  kite.ts            # Kite API response types
```
