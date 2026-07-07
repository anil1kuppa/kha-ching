import { eq } from "drizzle-orm"
import type { KiteOrder } from "../../types/kite"
import type {
  ATM_STRADDLE_TRADE,
  ATM_STRANGLE_TRADE,
  SUPPORTED_TRADE_CONFIG,
} from "../../types/trade"
import { USER_OVERRIDE, STATUS_TRIGGER_PENDING } from "../constants"
import { db } from "../drizzle"
import { patchDbTrade } from "../drizzleDbUtils"
import { type PlaceOrderParams, placeOrder, syncGetKiteInstance, getCompletedOrdersbyTag, remoteOrderSuccessEnsurer } from "../kiteUtils"
import logger from "../logger"
import { jobExecutions } from "../schema"
import { withRemoteRetry } from "../utils"

export async function doDeletePendingOrders(orders: KiteOrder[], kite: any) {
  const allOrders: KiteOrder[] = await withRemoteRetry(() => kite.getOrders())
  const openOrders: KiteOrder[] = allOrders.filter(order => order.status === STATUS_TRIGGER_PENDING)

  const openOrdersForPositions = orders
    .map(order =>
      openOrders.find(
        openOrder =>
          openOrder.product === order.product && //MIS or NRML
          openOrder.exchange === order.exchange && //NRML
          openOrder.tradingsymbol === order.tradingsymbol &&
          // reverse trade on same exchange + tradingsybol is not possible,
          // so doing `abs`
          Math.abs(openOrder.quantity) === Math.abs(order.quantity)
      )
    )
    .filter(o => o)

  // some positions might have squared off during the day when the SL hit
  return Promise.all(
    openOrdersForPositions.map(async (openOrder: KiteOrder) =>
      withRemoteRetry(() => kite.cancelOrder(openOrder.variety, openOrder.order_id))
    )
  )
}

export async function doSquareOffPositions(
  orders: KiteOrder[],
  kite: any,
  initialJobData: Partial<SUPPORTED_TRADE_CONFIG>
) {
  const openPositions = await withRemoteRetry(() => kite.getPositions())
  const { net } = openPositions
  //orders would always have +ve value and filter based on transaction_type
  const openPositionsForOrders = orders
    .filter(o => o)
    .map(order => {
      const position = net.find(
        openPosition =>
          openPosition.tradingsymbol === order.tradingsymbol &&
          openPosition.exchange === order.exchange &&
          openPosition.product === order.product &&
          (openPosition.quantity < 0
            ? // openPosition is short order
              order.transaction_type == "SELL"
            : // long order
              order.transaction_type == "BUY")
      )

      if (!position) {
        return null
      }
      const absquantity: number = Math.min(order.quantity, Math.abs(position.quantity))

      return {
        ...position,
        quantity: position.quantity < 0 ? absquantity * -1 : absquantity,
      }
    })
    .filter(o => o)

  const remoteRes = await Promise.all(
    openPositionsForOrders.map(async order => {
      const exitOrder = {
        tradingsymbol: order.tradingsymbol,
        quantity: Math.abs(order.quantity),
        exchange: order.exchange,
        transaction_type:
          order.quantity < 0 ? kite.TRANSACTION_TYPE_BUY : kite.TRANSACTION_TYPE_SELL,
        order_type: kite.ORDER_TYPE_MARKET,
        product: order.product,
        tag: initialJobData.orderTag,
      }
      // console.log('square off position...', exitOrder)
      return remoteOrderSuccessEnsurer({
        _kite: kite,
        orderProps: exitOrder,
        instrument: (initialJobData as ATM_STRADDLE_TRADE | ATM_STRANGLE_TRADE).instrument!,
        ensureOrderState: kite.STATUS_COMPLETE,
        user: initialJobData.user!,
      })
    })
  )

  if ((initialJobData as ATM_STRANGLE_TRADE | ATM_STRADDLE_TRADE).onSquareOffSetAborted) {
    try {
      await patchDbTrade(initialJobData.id!, {
        userOverride: USER_OVERRIDE.ABORT,
      })
    } catch (error) {
      logger.error("error in onSquareOffSetAborted", error)
    }
  }

  return remoteRes
}

//Squares off the order after checking if the position is open
async function squareOffOrder(order: KiteOrder, kite: any) {
  const openPositions = await withRemoteRetry(() => kite.getPositions())
  const { net } = openPositions
  const openPositionsforOrders = net.filter(
    position =>
      position.tradingsymbol === order.tradingsymbol &&
      position.exchange === order.exchange &&
      position.product === order.product &&
      (position.quantity < 0
        ? // openPosition is short order
          order.transaction_type == "SELL"
        : // long order
          order.transaction_type == "BUY")
  )

  if (openPositionsforOrders.length == 0) {
    return Promise.resolve("No open positions.")
  }

  const exitOrder = {
    tradingsymbol: order.tradingsymbol,
    quantity: Math.min(order.quantity, Math.abs(openPositionsforOrders[0].quantity)),
    exchange: order.exchange,
    transaction_type:
      order.transaction_type === kite.TRANSACTION_TYPE_SELL
        ? kite.TRANSACTION_TYPE_BUY
        : kite.TRANSACTION_TYPE_SELL,
    order_type: kite.ORDER_TYPE_MARKET,
    product: order.product,
    tag: order.tag,
  }
  logger.info(`Placing order ${exitOrder.tradingsymbol} and quantity - ${exitOrder.quantity}`)
  await withRemoteRetry(() => placeOrder(kite, kite.VARIETY_REGULAR, exitOrder as PlaceOrderParams))
}

//Squares off the tag
export async function squareOffTag(orderTag: string, kite: any): Promise<any> {
  /*
  1. Do not square off it's aborted
  2. Check if there are orders which are yet to be squared off
  2. Cancel Pending orders if any
  3. Square off the orders
  */
  logger.info(`[autoSquareOff] squareOfforders ${orderTag} `)
  const execRows = await db
    .select({ userOverride: jobExecutions.userOverride })
    .from(jobExecutions)
    .where(eq(jobExecutions.orderTag, orderTag))
  if (execRows[0]?.userOverride === USER_OVERRIDE.ABORT) {
    logger.error("Not squaring off as user aborted")
    Promise.resolve("Not suqaring off")
  }
  const orderSummarybyTag = (await getCompletedOrdersbyTag(orderTag, kite)).filter(
    summary => summary.quantity != 0
  )
  const allOrders: KiteOrder[] = await withRemoteRetry(() => kite.getOrders())
  // orderSummarybyTag.filter(summary=>(summary.quantity!=0))
  //                   .forEach(async summary=>
  for (const summary of orderSummarybyTag) {
    for (const openOrder of allOrders.filter(
      order =>
        order.status === STATUS_TRIGGER_PENDING &&
        order.tag === orderTag &&
        order.tradingsymbol === summary.tradingsymbol
    )) {
      logger.info(`Cancelling orderId ${openOrder.order_id} ; variety ${openOrder.variety}`)
      await withRemoteRetry(() => kite.cancelOrder(openOrder.variety, openOrder.order_id))
      /*
                        await withRemoteRetry(async () =>
                getInstrumentPrice(kite,current.tradingsymbol, 'NFO'));
                */
      //kite.cancelOrder(openOrder.variety, openOrder.order_id);
    }
    /*allOrders.filter(order => (order.status === 'TRIGGER PENDING' && order.tag === orderTag))
                        .forEach(async (openOrder) => {
                          await withRemoteRetry(() => kite.cancelOrder(openOrder.variety, openOrder.order_id))
                        })*/
    for (const order of allOrders.filter(
      order =>
        order.status === "COMPLETE" &&
        order.tag === orderTag &&
        order.tradingsymbol === summary.tradingsymbol &&
        (summary.quantity > 0
          ? order.transaction_type === "BUY"
          : order.transaction_type === "SELL")
    )) {
      await squareOffOrder(order, kite)
    }
    /*allOrders.filter(order=>
                          (order.status==='COMPLETE' && order.tag===orderTag && order.tradingsymbol===summary.tradingsymbol
                          && (summary.quantity>0?(order.transaction_type==='BUY'):(order.transaction_type==='SELL'))))
                          .forEach(async order=>
                            await squareOffOrder(order,kite))
                            */
  }

  return Promise.resolve("Orders squared off")
}

export async function cancelCoOrders(user): Promise<any> {
  const kite = syncGetKiteInstance(user)
  const allOrders: KiteOrder[] = await withRemoteRetry(() => kite.getOrders())
  const openOrders: KiteOrder[] = allOrders.filter(
    order => order.status === STATUS_TRIGGER_PENDING && order.variety === kite.VARIETY_CO
  )
  await Promise.all(
    openOrders
      .filter(order => order.order_id)
      .map(order => withRemoteRetry(() => kite.cancelOrder(kite.VARIETY_CO, order.order_id!)))
  )
}
/* Squares off the orders */
async function autoSquareOffStrat({
  rawKiteOrdersResponse,
  deletePendingOrders,
  initialJobData,
}: {
  rawKiteOrdersResponse: KiteOrder[]
  deletePendingOrders: boolean
  initialJobData: SUPPORTED_TRADE_CONFIG
}): Promise<any> {
  const { user } = initialJobData
  const kite = syncGetKiteInstance(user)
  const completedOrders = rawKiteOrdersResponse
  const execRows = await db
    .select({ userOverride: jobExecutions.userOverride })
    .from(jobExecutions)
    .where(eq(jobExecutions.id, initialJobData.id!))
  if (execRows[0]?.userOverride === USER_OVERRIDE.ABORT) {
    logger.error("Not squaring off as user aborted")
    return
  }

  if (deletePendingOrders) {
    try {
      await doDeletePendingOrders(completedOrders, kite)
      // console.log('🟢 deletePendingOrders success', res)
    } catch (e) {
      logger.error("🔴 deletePendingOrders failed")
      logger.error("deletePendingOrders error", e)
    }
  }
  logger.info("Calling SquareOff positions")
  return doSquareOffPositions(completedOrders, kite, initialJobData)
}

export default autoSquareOffStrat
