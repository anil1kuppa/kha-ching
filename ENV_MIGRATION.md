# Environment Variables Migration Guide

This document shows the differences between the old `.env.local` and the new `.env.example` approach.

## Removed Variables (No Longer Used)

| Variable | Reason | Replacement |
|---|---|---|
| `DATABASE_HOST_URL` | Replaced by local PostgreSQL | `DB_HOST`, `DB_PORT`, etc. |
| `DATABASE_USER_KEY` | Replaced by local PostgreSQL | `DB_USER`, `DB_PASSWORD` |
| `DATABASE_API_KEY` | Replaced by local PostgreSQL | Direct TCP connection |
| `ORCL_HOST_URL` | Oracle database no longer used | PostgreSQL only |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase not used, direct Postgres | — |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Supabase not used | — |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase not used | — |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase not used | — |
| `PRODUCTION_REDS_URL` | Optional for production Redis | Keep if using production Redis |

## Renamed/Updated Variables

| Old Name | New Name | Change |
|---|---|---|
| `URL` | `URL` | Same (Kite redirect URL for local) |
| `ProductionURL` | `ProductionURL` | Same (Kite redirect URL for production) |
| `SECRET_COOKIE_PASSWORD` | `SECRET_COOKIE_PASSWORD` | Same (session encryption) |
| `REDIS_URL` | `REDIS_URL` | Same (local Redis) |
| `KITE_API_KEY` | `KITE_API_KEY` | Same |
| `KITE_API_SECRET` | `KITE_API_SECRET` | Same |

## New Database Variables

These are NEW and required for direct PostgreSQL connection:

```env
DB_HOST=localhost          # PostgreSQL hostname
DB_PORT=5432              # PostgreSQL port
DB_NAME=trading_db        # Database name
DB_USER=postgres          # PostgreSQL user
DB_PASSWORD=postgres      # PostgreSQL password
```

## New/Restructured Variables

| Variable | Type | Purpose | Default |
|---|---|---|---|
| `NEXT_PUBLIC_DEFAULT_LOTS` | Public | Default lots for trades | 2 |
| `NEXT_PUBLIC_DEFAULT_SKEW_PERCENT` | Public | Default skew percentage | 10 |
| `NEXT_PUBLIC_DEFAULT_SQUARE_OFF_TIME` | Public | Default square-off time | 15:20 |
| `NEXT_PUBLIC_DEFAULT_SLM_PERCENT` | Public | Default SLM percentage | 30 |
| `SIGNALX_API_KEY` | Private | SignalX API key | — |
| `MOCK_ORDERS` | Public | Enable mock orders in dev | true |

## Migration Steps

1. **Backup old .env.local**
   ```bash
   cp .env.local .env.local.backup
   ```

2. **Create new .env.local from template**
   ```bash
   cp .env.example .env.local
   ```

3. **Update with your values**
   ```bash
   # Copy from .env.local.backup:
   KITE_API_KEY=77ci27w4end21li3
   KITE_API_SECRET=atjmkwlx0vhkwyo3bxhy8hfgh69b8ep7
   SECRET_COOKIE_PASSWORD=6QZEEr1ZZZznkj84Uv81ZMjH5U5b5wpR
   SIGNALX_API_KEY=pAAzn2uLgfPuApGA
   ```

4. **Set database credentials**
   ```bash
   # For local Docker setup (default):
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=trading_db
   DB_USER=postgres
   DB_PASSWORD=postgres
   ```

5. **Verify Redis URL**
   ```bash
   # For local Docker setup:
   REDIS_URL=redis://127.0.0.1:6379
   ```

## Database Connection

### Old Approach
- Oracle database via `ORCL_HOST_URL`
- Supabase HTTP API via `DATABASE_HOST_URL` and `DATABASE_API_KEY`

### New Approach
- **Direct PostgreSQL connection** using `lib/dbUtils.ts`
- Direct TCP socket to PostgreSQL (no HTTP overhead)
- Connection pooling built-in
- Environment variables: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`

### In Docker
```yaml
# docker-compose.yml automatically:
DB_HOST: postgres    # Service name from docker-compose
DB_PORT: 5432
DB_NAME: trading_db
DB_USER: postgres
DB_PASSWORD: postgres
```

## Using dbUtils.ts

Instead of HTTP API calls to Supabase/Oracle:

```typescript
import { queryOne, insertOne, updateRows } from '@/lib/dbUtils'

// Simple, type-safe queries
const trade = await queryOne('SELECT * FROM trades WHERE id = $1', [tradeId])
await insertOne('trades', { symbol: 'NIFTY', quantity: 100 })
await updateRows('trades', { status: 'completed' }, 'id = $1', [tradeId])
```

## Checklist for Migration

- [ ] Copy `.env.example` to `.env.local`
- [ ] Update `KITE_API_KEY` and `KITE_API_SECRET`
- [ ] Update `SIGNALX_API_KEY`
- [ ] Update `SECRET_COOKIE_PASSWORD`
- [ ] Verify `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- [ ] Verify `REDIS_URL`
- [ ] Remove old Supabase variables from `.env.local`
- [ ] Remove `ORCL_HOST_URL` from `.env.local`
- [ ] Test local connection: `npm run dev` or `docker-compose up`
- [ ] Delete `.env.local.backup` when everything works

## Questions?

- Missing a variable? Check `.env.example` for the full list
- Database connection failing? Verify `DB_*` variables match your PostgreSQL setup
- Redis connection failing? Verify `REDIS_URL` matches your Redis setup
