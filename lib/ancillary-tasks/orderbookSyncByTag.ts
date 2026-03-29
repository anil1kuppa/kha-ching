import { SignalXUser } from '../../types/misc'

import {
  syncGetKiteInstance,
  withRemoteRetry
} from '../utils'

async function orderbookSyncByTag ({
  orderTag,
  user
}: {
  orderTag: string
  user: SignalXUser
}) {
  try {
    const kite = syncGetKiteInstance(user)
    const allOrders = await withRemoteRetry(() => kite.getOrders())
    const ordersForTag = allOrders.filter(order => order.tag === orderTag)
    console.log(`Order tag is ${orderTag}`)

    // Local PostgreSQL storage of orders can be added here if needed
    return { success: true, count: ordersForTag.length, orderTag }
  } catch (e) {
    return Promise.reject(e)
  }
}

export default orderbookSyncByTag
