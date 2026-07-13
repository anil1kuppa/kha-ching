import type { SignalXUser } from "../../types/misc"

import { syncGetKiteInstance } from "../kiteUtils"
import logger from "../logger"
import { withRemoteRetry } from "../utils"

async function orderbookSyncByTag({ orderTag, user }: { orderTag: string; user: SignalXUser }) {
  try {
    const kite = syncGetKiteInstance(user)
    const allOrders = await withRemoteRetry(() => kite.getOrders())
    const ordersForTag = allOrders.filter(order => order.tag === orderTag)
    logger.info(`Order tag is ${orderTag}`)

    // Local PostgreSQL storage of orders can be added here if needed
    return { success: true, count: ordersForTag.length, orderTag }
  } catch (e) {
    return Promise.reject(e)
  }
}

export default orderbookSyncByTag
