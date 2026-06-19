/**
 * Broker management lib
 *
 * Currently supporting Zerodha (Kite) only
 */
import { placeOrder as kitePlaceOrder, syncGetKiteInstance } from "./kiteUtils"

export const BROKERS = {
  ZERODHA: "ZERODHA",
}

export const placeOrder = async ({ order, user, broker }) => {
  if (broker === BROKERS.ZERODHA) {
    const kc = syncGetKiteInstance(user)
    return kitePlaceOrder(kc, order)
  }
}

// export const modifyOrder = async ({ user }) => {}

// export const getPositions = async ({ user }) => {}

// export const getOrders = async ({ user }) => {}

// export const getOrderHistoryById = async ({ user }) => {}
