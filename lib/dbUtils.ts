import { Pool, QueryResult } from 'pg'
import * as dotenv from 'dotenv'

dotenv.config()

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'trading_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err)
})

/**
 * Execute a query and return results
 */
export async function query<T = any>(
  sql: string,
  params?: any[]
): Promise<QueryResult<T>> {
  try {
    const result = await pool.query<T>(sql, params)
    return result
  } catch (error) {
    console.error('Database query error:', error)
    throw error
  }
}

/**
 * Get a single row from a query
 */
export async function queryOne<T = any>(
  sql: string,
  params?: any[]
): Promise<T | null> {
  const result = await query<T>(sql, params)
  return result.rows.length > 0 ? result.rows[0] : null
}

/**
 * Get all rows from a query
 */
export async function queryAll<T = any>(
  sql: string,
  params?: any[]
): Promise<T[]> {
  const result = await query<T>(sql, params)
  return result.rows
}

/**
 * Insert a row and return the inserted row
 */
export async function insertOne<T = any>(
  table: string,
  data: Record<string, any>,
  returning = '*'
): Promise<T | null> {
  const keys = Object.keys(data)
  const values = Object.values(data)
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')

  const sql = `
    INSERT INTO ${table} (${keys.join(', ')})
    VALUES (${placeholders})
    RETURNING ${returning}
  `

  const result = await query<T>(sql, values)
  return result.rows.length > 0 ? result.rows[0] : null
}

/**
 * Update rows and return updated rows
 */
export async function updateRows<T = any>(
  table: string,
  data: Record<string, any>,
  whereClause: string,
  params?: any[],
  returning = '*'
): Promise<T[]> {
  const keys = Object.keys(data)
  const values = Object.values(data)
  const setClause = keys.map((key, i) => `${key} = $${i + 1}`).join(', ')

  const allParams = [...values, ...(params || [])]
  const paramOffset = keys.length

  const sql = `
    UPDATE ${table}
    SET ${setClause}
    WHERE ${whereClause.replace(/\$(\d+)/g, (match, num) => `$${parseInt(num) + paramOffset}`)}
    RETURNING ${returning}
  `

  const result = await query<T>(sql, allParams)
  return result.rows
}

/**
 * Delete rows and return deleted rows
 */
export async function deleteRows<T = any>(
  table: string,
  whereClause: string,
  params?: any[],
  returning = '*'
): Promise<T[]> {
  const sql = `
    DELETE FROM ${table}
    WHERE ${whereClause}
    RETURNING ${returning}
  `

  const result = await query<T>(sql, params)
  return result.rows
}

/**
 * Close the pool
 */
export async function closePool(): Promise<void> {
  await pool.end()
}

/**
 * Get pool instance (for advanced usage)
 */
export function getPool(): Pool {
  return pool
}

const dbUtils = {
  query,
  queryOne,
  queryAll,
  insertOne,
  updateRows,
  deleteRows,
  closePool,
  getPool,
}

export default dbUtils
