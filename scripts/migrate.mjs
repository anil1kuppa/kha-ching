import "dotenv/config"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import pg from "pg"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const { Pool } = pg
const __dirname = dirname(fileURLToPath(import.meta.url))

const url = process.env.DATABASE_URL?.trim()
if (!url) {
  console.error("DATABASE_URL is not set")
  process.exit(1)
}

const pool = new Pool({ connectionString: url })
const db = drizzle(pool)

console.log("[migrate] Applying pending migrations...")
await migrate(db, { migrationsFolder: resolve(__dirname, "../drizzle") })
console.log("[migrate] Done")

await pool.end()
