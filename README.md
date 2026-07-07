# SignalX

SignalX is a trading app for anyone looking to diversify their funds into systematic and algorithmic intraday trading strategies.

## Available Trades

- **ATM Straddle** — Simultaneously sells/buys the at-the-money CE and PE. Supports a skew check (see `NEXT_PUBLIC_DEFAULT_SKEW_PERCENT` below) so both legs are entered near their fair premium, plus configurable SL and target exit strategies per leg or combined.
- **ATM Strangle** — Same idea as the straddle but with CE and PE legs offset from the ATM strike, for a wider breakeven range.
- **Subscribe & Chase** — A trending 40-EMA strategy, available for Nifty futures only. Recomputes the 40-period EMA on hourly candles and trails the stop-loss as price moves in the trend's favor, converting to a market order on rollover. Entry, exit, and SL-update signals are posted to Slack.

## Prerequisites

1. **Kite Connect** — Go to https://kite.trade and sign up. Create an app and pay Zerodha the ₹500/month fee.
   - Copy the `API Key` and `API Secret` — you'll need them for environment variables.
   - Set the **Redirect URL** to `https://<your-vps-domain>/api/redirect_url_kite` after deployment.

2. **VPS** — A Linux VPS (Ubuntu 22.04+ recommended) with at least 1 vCPU and 1 GB RAM.

3. **Node.js** — v20+ (use [nvm](https://github.com/nvm-sh/nvm) to install).

4. **Yarn** — v4 (`npm install -g yarn`).

5. **PostgreSQL 16** — Install on the VPS:
   ```bash
   sudo apt install -y postgresql-16
   sudo -u postgres psql -c "CREATE DATABASE trading_db;"
   sudo -u postgres psql -c "CREATE USER trading_user WITH PASSWORD 'yourpassword';"
   sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE trading_db TO trading_user;"
   ```

6. **Redis 7** — Install on the VPS:
   ```bash
   sudo apt install -y redis-server
   sudo systemctl enable redis-server
   sudo systemctl start redis-server
   ```

7. **Grafana Cloud** (optional, for observability) — Sign up at https://grafana.com/products/cloud/. Navigate to **Connections → OpenTelemetry** to get your OTLP endpoint and API token.

---

## Setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/anil1kuppa/kha-ching.git
cd kha-ching
yarn install
```

### 2. Configure environment variables

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Refer to [.env.example](.env.example) for all available variables and their descriptions. Key variables to set:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string, e.g. `postgresql://trading_user:yourpassword@localhost:5432/trading_db` |
| `REDIS_URL` | Redis URL, e.g. `redis://127.0.0.1:6379` |
| `KITE_API_KEY` | Your Kite Connect API key |
| `KITE_API_SECRET` | Your Kite Connect API secret |
| `SECRET_COOKIE_PASSWORD` | Random 32+ character string for session encryption |
| `TZ` | Must be `Asia/Kolkata` |
| `MOCK_ORDERS` | Set `true` during testing — skips real order placement |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Grafana Cloud OTLP endpoint (optional) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Grafana Cloud auth header (optional) |

### 3. Apply database migrations

```bash
yarn drizzle:push
```

### 4. Build and start

```bash
yarn build
yarn start
```

The app runs on port `3000` by default. Use a reverse proxy (nginx, Caddy) to expose it over HTTPS.

---

## Running with Docker Compose

`docker-compose.yml` only builds and runs the app container — it does not provision Postgres or Redis. Before running `docker compose up`, make sure Docker, PostgreSQL, and Redis are all installed and PostgreSQL/Redis are reachable (either running on the host, or as separate containers), then point `DATABASE_URL` and `REDIS_URL` in `.env` at them:

```bash
cp .env.example .env   # fill in your values, including DATABASE_URL and REDIS_URL
docker compose up app          # production build
# or
docker compose up app-dev      # dev build with hot reload
```

The app health-check endpoint is `GET /api/health`.

---

## Environment Variables Reference

See [.env.example](.env.example) for the full list of environment variables with inline documentation.

### `NEXT_PUBLIC_DEFAULT_LOTS`
Default lots pre-filled in the trade form. For example, `2` lots if you regularly trade 150 quantity of Nifty options.

### `NEXT_PUBLIC_DEFAULT_SKEW_PERCENT`
Allowed skew (% difference between CE and PE premiums) before entering a straddle. 5–15 is a good range.

**Skew retry behavior:** Before entering a straddle, the app checks whether the live skew is within the threshold. If too high, it retries every 2 seconds. The allowed skew threshold widens dynamically over time:
- While more than 50% of the window remains → use `maxSkewPercent`
- After 50% of time has elapsed → blend linearly toward `thresholdSkewPercent`
- If the window expires → trade is taken regardless of skew if `takeTradeIrrespectiveSkew` is enabled, otherwise cancelled

### `NEXT_PUBLIC_DEFAULT_SQUARE_OFF_TIME`
Default square-off time in 24-hour `hh:mm` format, e.g. `15:20` for 3:20 PM.

### `NEXT_PUBLIC_DEFAULT_SLM_PERCENT`
Default SLM BUY order percentage placed after an initial order fills. Changeable per trade during setup.

---

## Development

```bash
yarn dev    # starts dev server with OTEL instrumentation
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Set `MOCK_ORDERS=true` to avoid placing real orders during development.

```bash
yarn test       # all tests
yarn unit-test  # unit tests only
yarn int-test   # integration tests (requires running Postgres + Redis)
```

---

## Data and Security

- All access tokens are saved in encrypted session cookies via `SECRET_COOKIE_PASSWORD`. **Do not share this value with anyone.**
- Redis stores job queues and scheduling data including Zerodha profile details. **Do not expose your Redis URL.**
- Zerodha tokens expire around 7:35 AM IST daily — log in to the app each morning after 7:45 AM to refresh.

---

## License

SignalX is [MIT licensed](https://github.com/aakashlpin/kha-ching/blob/master/LICENSE.md).
