# Docker Setup Guide for kha-ching

This project uses Docker and Docker Compose to run PostgreSQL, Redis, and the Node.js application in isolated containers.

## Prerequisites

- Docker (version 20.10+)
- Docker Compose (version 2.0+)

## Quick Start

### 1. Set up environment variables

Copy the example environment file and update it with your configuration:

```bash
cp .env.example .env
```

Edit `.env` and add your Kite API credentials and other configuration:

```env
DB_HOST=postgres
DB_PORT=5432
DB_NAME=trading_db
DB_USER=postgres
DB_PASSWORD=postgres

REDIS_URL=redis://redis:6379

KITE_API_KEY=your_api_key
KITE_API_SECRET=your_api_secret
KITE_REDIRECT_URL=http://localhost:3000/api/redirect_url_kite

SESSION_SECRET=your_session_secret_key_here_min_32_chars_recommended
```

### 2. Start the containers

```bash
docker-compose up -d
```

This will:
- Create and start a PostgreSQL database container
- Create and start a Redis container
- Build and start the Node.js application container

The application will be available at `http://localhost:3000`

### 3. View logs

```bash
# View all services
docker-compose logs -f

# View specific service
docker-compose logs -f app
docker-compose logs -f postgres
docker-compose logs -f redis
```

### 4. Stop containers

```bash
# Stop all services
docker-compose down

# Stop and remove volumes (clean slate)
docker-compose down -v
```

## Services

### PostgreSQL

- **Container**: `kha-ching-postgres`
- **Port**: 5432 (exposed locally)
- **Credentials**: Configured via `DB_USER` and `DB_PASSWORD` in `.env`
- **Volume**: `postgres_data` (persistent)
- **Health Check**: Enabled

### Redis

- **Container**: `kha-ching-redis`
- **Port**: 6379 (exposed locally)
- **Volume**: `redis_data` (persistent)
- **Health Check**: Enabled

### Application (Node.js/Next.js)

- **Container**: `kha-ching-app`
- **Port**: 3000 (exposed locally)
- **Environment**: Development mode with hot reloading
- **Dependencies**: Waits for PostgreSQL and Redis to be healthy before starting

## Database Initialization

If you need to initialize the database schema, you can:

1. Connect to the PostgreSQL container:
```bash
docker-compose exec postgres psql -U postgres -d trading_db
```

2. Run SQL migration files if needed:
```bash
docker-compose exec postgres psql -U postgres -d trading_db -f /path/to/migration.sql
```

## Using dbUtils.ts

The `lib/dbUtils.ts` module provides a simple interface to interact with PostgreSQL:

```typescript
import { query, queryOne, insertOne, updateRows, deleteRows } from '@/lib/dbUtils'

// Query
const users = await queryAll('SELECT * FROM users')

// Query one
const user = await queryOne('SELECT * FROM users WHERE id = $1', [userId])

// Insert
const newUser = await insertOne('users', { name: 'John', email: 'john@example.com' })

// Update
const updated = await updateRows('users', { name: 'Jane' }, 'id = $1', [userId])

// Delete
const deleted = await deleteRows('users', 'id = $1', [userId])
```

## Troubleshooting

### Container won't start

Check the logs:
```bash
docker-compose logs app
```

Common issues:
- Port already in use: Change the PORT in `.env`
- Database connection failed: Ensure PostgreSQL container is running and healthy
- Dependencies not installed: Run `pnpm install` locally first

### Reset everything

```bash
# Stop and remove containers and volumes
docker-compose down -v

# Rebuild images
docker-compose build --no-cache

# Start fresh
docker-compose up -d
```

### Access PostgreSQL from your machine

```bash
psql -h localhost -U postgres -d trading_db
# Password: (from DB_PASSWORD in .env)
```

### Access Redis from your machine

```bash
redis-cli -h localhost
```

## Production Deployment

For production, modify `docker-compose.yml`:

1. Set `NODE_ENV=production`
2. Use specific image tags instead of `latest`
3. Remove volume mounts for source code
4. Use a strong `DB_PASSWORD` and `SESSION_SECRET`
5. Consider using external PostgreSQL and Redis services instead of containers
6. Use environment-specific `.env.production` file

Example production adjustments:

```yaml
app:
  environment:
    NODE_ENV: production
  volumes:
    - /app/node_modules  # Only mount node_modules
  # Remove source code mounts
```

## Development Tips

### Rebuild on changes

The development setup includes hot reloading:
```bash
docker-compose up -d
# Changes to source files will automatically reload
```

### Run commands inside container

```bash
# Run tests
docker-compose exec app npm run test

# Run linting
docker-compose exec app npm run lint

# Access the application shell
docker-compose exec app sh
```

### Database backups

```bash
# Backup PostgreSQL
docker-compose exec postgres pg_dump -U postgres trading_db > backup.sql

# Restore PostgreSQL
docker-compose exec -T postgres psql -U postgres trading_db < backup.sql
```
