import type { SignalXUser } from "../../types/misc"
import { syncGetKiteInstance } from "../kiteUtils"
import logger from "../logger"
import { withRemoteRetry } from "../utils"

async function orderbookSync({ user }: { user: SignalXUser }): Promise<any> {
  try {
    const kite = syncGetKiteInstance(user)
    const allOrders = await withRemoteRetry(() => kite.getOrders())
    const completedOrders = allOrders.filter(order => order.status === "COMPLETE")
    if (completedOrders.length > 0) {
      logger.info(`Completed orders in ancillary queue`, completedOrders)
      // Local PostgreSQL storage of orders can be added here if needed
      return Promise.resolve({ success: true, count: completedOrders.length })
    } else return null
  } catch (e) {
    return Promise.reject(e)
  }
}

export default orderbookSync
