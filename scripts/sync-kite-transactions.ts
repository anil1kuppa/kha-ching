/**
 * Kite Transactions Sync Cron Script
 * Reads orders from Kite API and syncs them to public.transactions table
 * Call this from your cron job: node ./scripts/sync-kite-transactions.js
 *
 * Example cron setup (runs at 4 PM IST - end of trading day):
 * 0 16 * * 1-5 cd /path/to/app && node scripts/sync-kite-transactions.js >> logs/transactions-sync.log 2>&1
 * (0 16 * * 1-5 = 4 PM IST, Monday-Friday only)
 */

import {
  insertMultipleTransactions,
  TransactionData,
  getLatestAccessToken,
} from "../lib/drizzleDbUtils"
import { fetchOrdersFromKite } from "../lib/kiteUtils"
import type { Order } from "kiteconnect"
import console from "../lib/logging"

function convertKiteOrderToTransaction(order: Order): TransactionData {
  return {
    order_timestamp: order.order_timestamp ?? undefined,
    exchange: order.exchange,
    tradingsymbol: order.tradingsymbol,
    instrument_token: order.instrument_token,
    transaction_type: order.transaction_type,
    quantity: order.quantity,
    average_price: Math.round(order.average_price * 100) / 100,
    tag: order.tag ?? undefined,
    order_id: order.order_id,
    variety: order.variety,
    order_type: undefined,
    product: order.product,
  }
}

/**
 * Sync all orders to transactions table
 * Duplicates are automatically ignored by the database (ON CONFLICT DO NOTHING)
 */
async function syncKiteTransactions(): Promise<void> {
  try {
    console.log("[sync-kite-transactions] Starting Kite transactions sync")

    // Step 1: Get the latest access token
    const accessToken = await getLatestAccessToken()

    if (!accessToken) {
      console.log("[sync-kite-transactions] No access token found. Skipping sync.")
      return
    }

    console.log("[sync-kite-transactions] Retrieved access token")

    // Step 2: Fetch all orders from Kite API
    const allOrders = await fetchOrdersFromKite(accessToken)

    if (allOrders.length === 0) {
      console.log("[sync-kite-transactions] No orders to process")
      return
    }

    console.log(`[sync-kite-transactions] Processing ${allOrders.length} orders`)

    // Step 3: Convert orders to transaction data
    const transactionsData: TransactionData[] = allOrders.map(convertKiteOrderToTransaction)

    // Step 4: Insert into database (duplicates handled by ON CONFLICT DO NOTHING)
    const result = await insertMultipleTransactions(transactionsData)

    console.log(
      `[sync-kite-transactions] Sync complete: ${result.inserted} inserted, ${result.skipped} skipped (duplicates)`
    )
  } catch (error) {
    console.error("[sync-kite-transactions] Error syncing transactions:", error)
    throw error
  }
}

// Run the sync
async function main() {
  try {
    await syncKiteTransactions()
    process.exit(0)
  } catch (error) {
    console.error("[sync-kite-transactions] Fatal error:", error)
    process.exit(1)
  }
}

main()
