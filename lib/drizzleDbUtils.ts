import { and, desc, eq, sql } from "drizzle-orm"
import { db } from "./drizzle"
import logger from "./logger"
import { accesstoken, chaseLog, chaseStatus, ema, jobExecutions, transactions } from "./schema"

export interface TransactionData {
  order_timestamp?: Date
  exchange?: string
  tradingsymbol?: string
  instrument_token?: number
  transaction_type?: string
  quantity?: number
  average_price?: number
  tag?: string
  order_id?: string
  variety?: string
  order_type?: string
  product?: string
}

export type EmaRow = {
  id: number
  createdAt: Date
  tradingsymbol: string
  ema: number
  instrumentToken: number
  highestHigh: number
  lowestLow: number
  lastClose: number
}

export type ChaseStatusRow = {
  id: number
  createdAt: Date | null
  updatedAt: Date | null
  status: string | null
  tradingsymbol: string | null
  instrumentToken: number | null
  stoploss: number | null
  entryPoint: number | null
  isSignalBreachingTolerance: boolean | null
}

/**
 * Persists a newly issued Zerodha access token, first triggering cleanup of old records.
 */
export async function storeAccessToken(access_token: string): Promise<void> {
  try {
    await db.execute(sql`SELECT cleanup_old_records()`)
    await db.insert(accesstoken).values({ accessToken: access_token })
  } catch (error) {
    logger.error("[storeAccessToken] error:", error)
  }
}

/**
 * Returns today's most recently stored access token (IST calendar day), or null if none exists.
 */
export async function getLatestAccessToken(): Promise<string | null> {
  try {
    const [row] = await db
      .select({ accessToken: accesstoken.accessToken })
      .from(accesstoken)
      .where(sql`(${accesstoken.createdAt} AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`)
      .orderBy(desc(accesstoken.createdAt))
      .limit(1)
    return row?.accessToken ?? null
  } catch (error) {
    logger.error("[getLatestAccessToken] error:", error)
    return null
  }
}

/**
 * Checks whether the given access token matches today's latest stored token.
 */
export async function checksameToken(access_token: string): Promise<boolean> {
  try {
    const latestToken = await getLatestAccessToken()
    if (!latestToken) {
      return false
    }
    return latestToken === access_token
  } catch (error) {
    logger.error("[checksameToken] error:", error)
    return false
  }
}

/**
 * Inserts a single trade transaction record and returns the inserted row.
 */
export async function insertTransaction(t: TransactionData): Promise<any> {
  try {
    const result = await db.execute(sql`
      INSERT INTO public.transactions (
        order_timestamp, exchange, tradingsymbol, instrument_token,
        transaction_type, quantity, average_price, tag,
        order_id, variety, order_type, product
      ) VALUES (
        ${t.order_timestamp}, ${t.exchange}, ${t.tradingsymbol}, ${t.instrument_token},
        ${t.transaction_type}, ${t.quantity}, ${t.average_price}, ${t.tag},
        ${t.order_id}, ${t.variety}, ${t.order_type}, ${t.product}
      ) RETURNING *
    `)
    const row = (result.rows[0] as any) ?? null
    logger.info("[insertTransaction] Successfully inserted transaction:", row?.id)
    return row
  } catch (error) {
    logger.error("[insertTransaction] Error inserting transaction:", error)
    throw error
  }
}

/**
 * Batch-inserts transactions, silently skipping duplicates (conflict-do-nothing).
 */
export async function insertMultipleTransactions(
  transactionsData: TransactionData[]
): Promise<{ inserted: number; failed: number; skipped: number }> {
  if (transactionsData.length === 0) {
    return { inserted: 0, failed: 0, skipped: 0 }
  }

  try {
    const values = transactionsData.map(t => ({
      orderTimestamp: t.order_timestamp,
      exchange: t.exchange,
      tradingsymbol: t.tradingsymbol,
      instrumentToken: t.instrument_token,
      transactionType: t.transaction_type,
      quantity: t.quantity,
      averagePrice: t.average_price != null ? String(t.average_price) : undefined,
      tag: t.tag,
      orderId: t.order_id,
      variety: t.variety,
      orderType: t.order_type,
      product: t.product,
    }))

    const result = await db
      .insert(transactions)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: transactions.id })

    const inserted = result.length
    const skipped = transactionsData.length - inserted
    logger.info(
      `[insertMultipleTransactions] Inserted ${inserted}, skipped ${skipped} (duplicates)`
    )
    return { inserted, failed: 0, skipped }
  } catch (error) {
    logger.error("[insertMultipleTransactions] Error during batch insert:", error)
    throw error
  }
}

/**
 * Fetch job execution values from DB by id.
 */
export async function getValuesfromDB(id: string): Promise<Record<string, unknown> | null> {
  const rows = await db.select().from(jobExecutions).where(eq(jobExecutions.id, id))
  return rows[0] ?? null
}

/**
 * Partially updates a job execution record by id and returns the updated row.
 * Throws if no record matches the given id.
 */
export async function patchDbTrade(
  id: string,
  patchProps: Partial<typeof jobExecutions.$inferInsert>
): Promise<Record<string, unknown>> {
  try {
    const updatedRows = await db
      .update(jobExecutions)
      .set(patchProps)
      .where(eq(jobExecutions.id, id))
      .returning()

    if (updatedRows.length === 0) {
      throw new Error(`[patchDbTrade] No record found with id: ${id}`)
    }

    logger.info(`[patchDbTrade] Successfully updated job execution id: ${id}`)
    return updatedRows[0]
  } catch (error) {
    logger.error("[patchDbTrade] Error patching trade record:", error)
    throw error
  }
}

/**
 * Returns the most recent EMA row for a trading symbol, or null if none exists.
 */
export async function getLatestEma(tradingsymbol: string): Promise<EmaRow | null> {
  const [row] = await db
    .select()
    .from(ema)
    .where(eq(ema.tradingsymbol, tradingsymbol))
    .orderBy(desc(ema.createdAt))
    .limit(1)

  if (!row) {
    return null
  }

  return {
    id: row.id,
    createdAt: row.createdAt ?? new Date(),
    tradingsymbol: row.tradingsymbol,
    ema: row.ema ?? 0,
    instrumentToken: row.instrumentToken ?? 0,
    highestHigh: row.highestHigh ?? 0,
    lowestLow: row.lowestLow ?? 0,
    lastClose: row.lastClose ?? 0,
  }
}

/**
 * Returns the latest EMA row for a trading symbol on a specific calendar date (IST), or null if none exists.
 */
export async function getEmaByDate(tradingsymbol: string, date: Date): Promise<EmaRow | null> {
  const [row] = await db
    .select()
    .from(ema)
    .where(
      and(
        eq(ema.tradingsymbol, tradingsymbol),
        sql`(${ema.createdAt} AT TIME ZONE 'Asia/Kolkata')::date = (${date}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`
      )
    )
    .orderBy(desc(ema.createdAt))
    .limit(1)

  if (!row) {
    return null
  }

  return {
    id: row.id,
    createdAt: row.createdAt ?? new Date(),
    tradingsymbol: row.tradingsymbol,
    ema: row.ema ?? 0,
    instrumentToken: row.instrumentToken ?? 0,
    highestHigh: row.highestHigh ?? 0,
    lowestLow: row.lowestLow ?? 0,
    lastClose: row.lastClose ?? 0,
  }
}

/**
 * Inserts a new EMA snapshot row.
 */
export async function insertEma(row: {
  createdAt?: Date
  tradingsymbol: string
  ema: number
  instrumentToken: number
  highestHigh: number
  lowestLow: number
  lastClose: number
}): Promise<void> {
  await db.insert(ema).values({
    createdAt: row.createdAt ?? new Date(),
    tradingsymbol: row.tradingsymbol,
    ema: row.ema,
    instrumentToken: row.instrumentToken,
    highestHigh: row.highestHigh,
    lowestLow: row.lowestLow,
    lastClose: row.lastClose,
  })
}

/**
 * Fetches the singleton chase-status row (id = 1), or null if it hasn't been created yet.
 */
export async function getChaseStatus(): Promise<ChaseStatusRow | null> {
  const [row] = await db
    .select()
    .from(chaseStatus)
    .where(eq(chaseStatus.id, 1))
  return row ?? null
}

/**
 * Partially updates the singleton chase-status row (id = 1), setting `updatedAt` automatically.
 */
export async function updateChaseStatus(fields: {
  status?: string
  tradingsymbol?: string
  stoploss?: number
  createdAt?: Date
  updatedAt?: Date
  entryPoint?: number
  instrumentToken?: number
  isSignalBreachingTolerance?: boolean
}): Promise<{ success: boolean; error?: unknown }> {
  try {
    await db
      .update(chaseStatus)
      .set({
        ...(fields.status !== undefined && { status: fields.status as any }),
        ...(fields.tradingsymbol !== undefined && { tradingsymbol: fields.tradingsymbol }),
        ...(fields.stoploss !== undefined && { stoploss: fields.stoploss }),
        ...(fields.createdAt !== undefined && { createdAt: fields.createdAt }),
        ...(fields.entryPoint !== undefined && { entryPoint: fields.entryPoint }),
        ...(fields.instrumentToken !== undefined && { instrumentToken: fields.instrumentToken }),
        ...(fields.isSignalBreachingTolerance !== undefined && {
          isSignalBreachingTolerance: fields.isSignalBreachingTolerance,
        }),
        updatedAt: fields.updatedAt ?? new Date(),
      })
      .where(eq(chaseStatus.id, 1))
    return { success: true }
  } catch (error) {
    logger.error("[updateChaseStatus] error:", error)
    return { success: false, error }
  }
}

/**
 * Returns today's SUBSCRIBE_CHASE job execution (for its lot size), or null if none was scheduled today.
 */
export async function getSubscribeChaseJob(): Promise<{ lots: number | null } | null> {
  const [row] = await db
    .select({ lots: jobExecutions.lots })
    .from(jobExecutions)
    .where(
      and(
        eq(jobExecutions.strategy, "SUBSCRIBE_CHASE" as any),
        sql`${jobExecutions.runAt}::date = current_date`
      )
    )
    .limit(1)
  return row ?? null
}

/**
 * Inserts a chase-order log entry recording a fill's symbol, side, and price.
 */
export async function insertChaseLog(row: {
  tradingsymbol: string
  transactionType: string
  averagePrice: number
  createdAt?: Date
}): Promise<void> {
  await db.insert(chaseLog).values({
    tradingsymbol: row.tradingsymbol,
    transactionType: row.transactionType,
    averagePrice: String(row.averagePrice),
    createdAt: row.createdAt ?? new Date(),
  })
}

export default {
  storeAccessToken,
  getLatestAccessToken,
  checksameToken,
  insertTransaction,
  insertMultipleTransactions,
  patchDbTrade,
  getLatestEma,
  getEmaByDate,
  insertEma,
  getChaseStatus,
  updateChaseStatus,
  insertChaseLog,
}
