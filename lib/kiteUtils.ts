/**
 * Kite-related utility functions
 * Handles all interactions with Kite API through the kiteconnect SDK
 */

import dayjs from "dayjs"
import isSameOrBefore from "dayjs/plugin/isSameOrBefore"
import memoizer from "memoizee"

import { KiteConnect, HistoricalData } from "kiteconnect"
import type {
  Connect,
  Exchanges,
  Instrument,
  MarginOrder,
  Order,
  Variety,
} from "kiteconnect"

import logger from "./logger"
import type { COMPLETED_BY_TAG } from "./constants"

dayjs.extend(isSameOrBefore)
const ms = seconds => seconds * 1000

export type PlaceOrderParams = Parameters<Connect["placeOrder"]>[1]

type KiteConnectInstance = InstanceType<typeof KiteConnect>

/**
 * Calculate 40-period Exponential Moving Average (EMA) from candle data.
 *
 * @param candles - Array of candle data with open/high/low/close/volume
 * @param prevEMA - Previous EMA value, if available (for incremental calculation)
 * @returns Object with ema, highestHigh, lowestLow, lastClose or null if insufficient data
 */
export const calculate40EMA = (
  candles: HistoricalData[],
  prevEMA: number | null = null
): {
  ema: number
  highestHigh: number
  lowestLow: number
  lastClose: number
} | null => {
  const period = 40
  const multiplier = 2 / (period + 1)

  const today = new Date().toISOString().split("T")[0]
  const filteredCandles = candles.filter(candle => candle.date.toISOString().startsWith(today))

  if (filteredCandles.length === 0) {
    logger.error("kiteUtils.calculate40EMA: No candles found for the date", {
      date: today,
      candleCount: candles.length,
    })
    return null
  }

  if (prevEMA === null && candles.length < period) {
    logger.error("kiteUtils.calculate40EMA: Not enough candles for the calculation", {
      candleCount: candles.length,
      required: period,
    })
    return null
  }

  const highestHigh = Math.round(Math.max(...filteredCandles.map(candle => candle.high)))
  const lowestLow = Math.round(Math.min(...filteredCandles.map(candle => candle.low)))
  const lastClose = Math.round(filteredCandles[filteredCandles.length - 1].close)

  const hlcValues = candles.map(candle => (candle.high + candle.low + candle.close) / 3)

  let ema: number
  if (prevEMA === null) {
    const sma40 = hlcValues.slice(0, period).reduce((acc, value) => acc + value, 0) / period
    const emaArray = [sma40]

    for (let i = period; i < hlcValues.length; i++) {
      emaArray.push(hlcValues[i] * multiplier + emaArray[emaArray.length - 1] * (1 - multiplier))
    }

    ema = emaArray[emaArray.length - 1]
  } else {
    ema = hlcValues[hlcValues.length - 1] * multiplier + prevEMA * (1 - multiplier)
  }
 logger.info("[kiteUtils.calculate40EMA]: Calculated EMA", {
    ema,
    highestHigh,
    lowestLow,
    lastClose,
  });

  return {
    ema: Math.round(ema),
    highestHigh,
    lowestLow,
    lastClose,
  }
}

/**
 * Create a KiteConnect client instance.
 *
 * @param accessToken - Optional Kite session access token for authenticated requests.
 * @returns A KiteConnect SDK client instance.
 * @throws If the KITE_API_KEY environment variable is not configured.
 */
export function getKiteInstance(accessToken?: string): KiteConnectInstance {
  const apiKey = process.env.KITE_API_KEY

  if (!apiKey) {
    logger.error("kiteUtils.getKiteInstance: missing KITE_API_KEY environment variable")
    throw new Error("KITE_API_KEY environment variable not set")
  }

  return new (KiteConnect as any)({
    api_key: apiKey,
    ...(accessToken && { access_token: accessToken }),
  })
}

/**
 * Return the most recent trading day before today using hourly equity candle data.
 *
 * @returns A Date object representing the previous trading day.
 * @throws If there is no historical candle data available for the reference period.
 */
export async function getPreviousTradingDay(accessToken: string): Promise<Date> {
  const kite = getKiteInstance(accessToken)
  const today = new Date()
  let fiveDaysBack = new Date(today)
  fiveDaysBack.setDate(fiveDaysBack.getDate() - 5)
  const candles: HistoricalData[] = await kite.getHistoricalData(
    256265, // NIFTY 50 instrument token
    "day",
    fiveDaysBack,
    today
  )

  if (!Array.isArray(candles) || candles.length === 0) {
    logger.error("kiteUtils.getPreviousTradingDay: no candle data found for NIFTY 50", {
      instrumentToken: 256265,
      from: fiveDaysBack,
      to: today,
      candleCount: Array.isArray(candles) ? candles.length : 0,
    })
    throw new Error("No candle data found for NIFTY 50")
  }

  const lastCandle = candles[candles.length - 1]
  logger.info(`[kiteUtils.getPreviousTradingDay] last candle date=${lastCandle.date} open=${lastCandle.open} high=${lastCandle.high} low=${lastCandle.low} close=${lastCandle.close}`)

  // Sort it and find the last candle which is before today (in case the last candle is for today but we want the previous trading day)
  if (new Date(lastCandle.date).toDateString() === today.toDateString()) {
    const previousCandle = candles
      .slice(0, -1)
      .reverse()
      .find(candle => new Date(candle.date).toDateString() !== today.toDateString())

    if (!previousCandle) {
      logger.error("kiteUtils.getPreviousTradingDay: no previous trading day found in candle data", {
        instrumentToken: 256265,
        from: fiveDaysBack,
        to: today,
      })
      throw new Error("No previous trading day found in candle data")
    }

    return new Date(previousCandle.date)
  }

  logger.info(`[kiteUtils.getPreviousTradingDay] last candle date ${lastCandle.date} is the previous trading day`)
  const result = new Date(lastCandle.date)
  logger.info(`[kiteUtils.getPreviousTradingDay] ${result.toDateString()}`)
  return result
}

/**
 * Calculate EMA for an instrument using historical hourly candles.
 *
 * @param instrument - Kite instrument object with a valid instrument_token.
 * @param prevEma - Prior EMA value used to seed the calculation, or null if unavailable.
 * @returns EMA statistics or null if candle data is insufficient.
 */
export async function calculateEma(
  instrument: Instrument,
  prevEma: number | null,
  accessToken: string
): Promise<{ ema: number; highestHigh: number; lowestLow: number; lastClose: number } | null> {
  const instrumentToken = Number(instrument.instrument_token)
  if (Number.isNaN(instrumentToken)) {
    logger.error("kiteUtils.calculateEma: invalid instrument_token", {
      tradingsymbol: instrument.tradingsymbol,
      instrumentToken: instrument.instrument_token,
    })
    throw new Error(`Invalid instrument_token for ${instrument.tradingsymbol}`)
  }
  let candles: HistoricalData[] = []
  const kite = getKiteInstance(accessToken)
  const now = dayjs()

  if (prevEma === null) {
    // If no previous EMA, we need at least 40 candles to calculate the initial SMA
candles = await kite.getHistoricalData(
      instrumentToken,
      "60minute",
      now.subtract(50, "day").toDate(),
      now.toDate()
    )

    if (!Array.isArray(candles) || candles.length < 40) {
      logger.error("kiteUtils.calculateEma: not enough historical candles for initial EMA", {
        tradingsymbol: instrument.tradingsymbol,
        candleCount: Array.isArray(candles) ? candles.length : 0,
        required: 40,
      })
      throw new Error(
        `Not enough historical candles to calculate initial EMA for ${instrument.tradingsymbol}. Found: ${Array.isArray(candles) ? candles.length : 0}, Required: 40`
      )
    }
  } else {
    // If we have a previous EMA, we can calculate the new EMA with just the latest candle, but we still need to fetch the latest candle to get the current price and high/low for the day
    candles = await kite.getHistoricalData(
      instrumentToken,
      "60minute",
      now.subtract(4, "day").toDate(),
      now.toDate()
    )

    if (!Array.isArray(candles) || candles.length === 0) {
      logger.error("kiteUtils.calculateEma: no historical candles found to update EMA", {
        tradingsymbol: instrument.tradingsymbol,
        instrumentToken,
        from: now.subtract(4, "day").toDate(),
        to: now.toDate(),
      })
      throw new Error(
        `No historical candles found for ${instrument.tradingsymbol} to update EMA.`
      )
    }
  }

  if (!Array.isArray(candles)) {
    logger.error("kiteUtils.calculateEma: unexpected Kite historical candle response", {
      tradingsymbol: instrument.tradingsymbol,
      instrumentToken,
    })
    throw new Error(`Unexpected Kite historical candle response for ${instrument.tradingsymbol}`)
  }

  return calculate40EMA(candles, prevEma)
}

/** Creates a KiteConnect instance synchronously from a session user object. Throws if the user has no valid access token. */
/**
 * Create a KiteConnect instance from a session user object.
 *
 * @param user - User object containing a Kite session access token.
 * @returns A KiteConnect SDK client instance authenticated with the user's token.
 * @throws If the user object is missing a valid access token.
 */
export function syncGetKiteInstance(user): KiteConnectInstance {
  const accessToken = user?.session?.access_token
  if (!accessToken) {
    logger.error("kiteUtils.syncGetKiteInstance: missing access_token in user object", {
      user,
    })
    throw new Error("missing access_token in `user` object, or `user` is undefined")
  }

  const apiKey = process.env.KITE_API_KEY
  if (!apiKey) {
    logger.error("kiteUtils.syncGetKiteInstance: missing KITE_API_KEY environment variable")
    throw new Error("KITE_API_KEY environment variable not set")
  }

  return new (KiteConnect as any)({
    api_key: apiKey,
    access_token: accessToken,
  })
}

/** Wraps the SDK placeOrder call, defaulting market_protection to 2% if not explicitly set. */
/**
 * Place an order through Kite, defaulting market protection if not provided.
 *
 * @param kite - Authenticated KiteConnect instance.
 * @param variety - Order variety (e.g. REGULAR, AMO, CO).
 * @param order - Order payload accepted by Kite.
 * @returns The Kite placeOrder response.
 */
export async function placeOrder(
  kite: KiteConnectInstance,
  variety: Variety,
  order: PlaceOrderParams
): Promise<any> {
  return kite.placeOrder(variety, {
    ...order,
    market_protection: (order as any).market_protection ?? 2,
  } as PlaceOrderParams)
}

/** Fetches all orders for the session regardless of status. */
/**
 * Fetch all orders for the current Kite session.
 *
 * @param accessToken - User's Kite session access token for authenticated requests.
 * @returns An array of Kite Order objects.
 */
export async function fetchOrdersFromKite(accessToken: string): Promise<Order[]> {
  try {
    const kite = getKiteInstance(accessToken)

    logger.info("[fetchOrdersFromKite] Fetching orders from Kite API")

    const orders = await kite.getOrders()

    if (!orders || orders.length === 0) {
      logger.info("[fetchOrdersFromKite] No orders found")
      return []
    }

    logger.info(`[fetchOrdersFromKite] Fetched ${orders.length} orders from Kite API`)

    // Transform orders to match the Order interface if needed
    return orders as Order[]
  } catch (error) {
    logger.error("[fetchOrdersFromKite] Error fetching orders from Kite:", {
      error,
      accessToken,
      apiKey: process.env.KITE_API_KEY,
    })
    throw error
  }
}

/** Fetches instruments for the given exchange. For NFO, filters to index derivatives only (NIFTY, BANKNIFTY, FINNIFTY). Uses a public endpoint — no access token required. */
/**
 * Fetch instruments for a given exchange, filtered to index derivatives for NFO.
 *
 * @param exchange - Exchange to fetch instruments from (default: NFO).
 * @returns An array of Kite Instrument objects.
 */
export async function asyncGetIndexInstruments(exchange = "NFO"): Promise<Instrument[]> {
  const kite = getKiteInstance()
  const instruments = await kite.getInstruments(exchange as Exchanges)

  if (exchange === "NFO") {
    return instruments.filter(
      item => item.name === "NIFTY" || item.name === "BANKNIFTY" || item.name === "FINNIFTY"
    )
  }
logger.info(`[asyncGetIndexInstruments] Fetched ${instruments.length} instruments for exchange: ${exchange}`);
  return instruments
}

/**
 * Memoized wrapper for asyncGetIndexInstruments to reduce repeated Kite instrument calls.
 *
 * @returns A cached promise resolving to an array of Kite Instrument objects.
 */
export const getIndexInstruments = memoizer(asyncGetIndexInstruments, {
  maxAge: dayjs().get("hours") < 18 ? ms(18 - dayjs().get("hours")) * 60 * 60 : ms(1 * 60),
  promise: true,
})

/**
 * Return the first 40 FnO instruments for the requested underlying and type.
 *
 * @param nfoSymbol - Underlying symbol such as NIFTY, BANKNIFTY, or FINNIFTY.
 * @param instrumentType - Instrument type to filter (CE, PE, FUT).
 * @returns A filtered and sorted list of Kite Instrument objects.
 */
const getFnOExpiriesRaw = async (
  nfoSymbol = "NIFTY", //NIFTY,BANKNIFTY,FINNIFTY
  instrumentType = "CE" //CE,PE/FUT
): Promise<Instrument[]> => {
  logger.info(`[kiteUtils.getFnOExpiries] nfoSymbol:${nfoSymbol};instrumentType=${instrumentType} `)
  const instrumentsData = await getIndexInstruments()

  const todayStart = dayjs().startOf("day")

  const rows: Instrument[] = instrumentsData
    .filter(
      item =>
        (nfoSymbol ? item.name === nfoSymbol : true) &&
        (instrumentType ? item.instrument_type === instrumentType : true) &&
        // only include expiries from today onwards
        dayjs(item.expiry).valueOf() >= todayStart.valueOf()
    )
    .sort((row1, row2) => (dayjs(row1.expiry).isSameOrBefore(dayjs(row2.expiry)) ? -1 : 1))

  return rows.slice(0, 40)
}

/**
 * Memoized FnO expiry instrument lookup for the configured underlying and type.
 *
 * @param nfoSymbol - Underlying symbol such as NIFTY, BANKNIFTY, or FINNIFTY.
 * @param instrumentType - Instrument type to filter (CE, PE, FUT).
 * @returns A cached list of Kite Instrument objects for the requested filters.
 */
export const getFnOExpiries = memoizer(getFnOExpiriesRaw, {
  maxAge: dayjs().get("hours") < 18 ? ms(18 - dayjs().get("hours")) * 60 * 60 : ms(1 * 60),
  promise: true,
})

/**
 * Get memoized expiry dates for NIFTY/BANKNIFTY/FINNIFTY option instruments.
 *
 * @returns A cached list of expiry date strings in ascending order.
 */
export const getNiftyOptionExpiries = memoizer(getFnOExpiries, {
  maxAge: dayjs().get("hours") < 18 ? ms(18 - dayjs().get("hours")) * 60 * 60 : ms(1 * 60),
  promise: true,
})

/**
 * Fetch the total initial margin required for a basket of orders.
 *
 * @param accessToken - User's Kite session access token.
 * @param orders - Margin orders to evaluate.
 * @returns The total required margin for the basket.
 */
export async function orderBasketMargins(
  accessToken: string,
  orders: MarginOrder[]
): Promise<number> {
  const kite = getKiteInstance(accessToken)
  const result = await kite.orderBasketMargins(orders, true, "compact")
  return result.initial.total
}

/**
 * Fetch completed Kite orders for a given tag and aggregate them by tradingsymbol.
 *
 * @param orderTag - Kite order tag used to group orders.
 * @param kite - Authenticated Kite SDK instance used to fetch orders.
 * @returns Aggregated completed orders by trading symbol.
 */
export async function getCompletedOrdersbyTag(
  orderTag: string,
  kite: any
): Promise<COMPLETED_BY_TAG[]> {
  try {
    logger.info(`[getCompletedOrdersbyTag] Fetching completed orders for tag: ${orderTag}`)

    const orders = await kite.getOrders()

    // Filter for COMPLETE orders with the given tag
    const completedOrders = orders.filter(
      (order: any) => order.status === "COMPLETE" && order.tag === orderTag
    )

    if (completedOrders.length === 0) {
      logger.info(`[getCompletedOrdersbyTag] No completed orders found for tag: ${orderTag}`)
      return []
    }

    // Group by trading symbol and aggregate points and quantity
    const pendingOrders = completedOrders.reduce(
      (prev: Record<string, { points: number; quantity: number }>, curr: any) => {
        if (!prev[curr.tradingsymbol]) {
          prev[curr.tradingsymbol] = {
            points: curr.transaction_type === "SELL" ? curr.average_price : -1 * curr.average_price,
            quantity: curr.transaction_type === "SELL" ? -1 * curr.quantity : curr.quantity,
          }
        } else {
          prev[curr.tradingsymbol].points +=
            curr.transaction_type === "SELL" ? curr.average_price : -1 * curr.average_price
          prev[curr.tradingsymbol].quantity +=
            curr.transaction_type === "SELL" ? -1 * curr.quantity : curr.quantity
        }
        return prev
      },
      {}
    )

    // Convert to array format
    const completeOrdersByTag: COMPLETED_BY_TAG[] = Object.keys(pendingOrders).map(key => ({
      tradingsymbol: key,
      quantity: pendingOrders[key].quantity,
      points: pendingOrders[key].points,
    }))

    logger.info(
      `[getCompletedOrdersbyTag] Found ${completeOrdersByTag.length} trading symbols with completed orders`
    )

    return completeOrdersByTag
  } catch (error) {
    logger.error(`[getCompletedOrdersbyTag] Error fetching completed orders:`, {
      error,
      accessToken: (kite as any).access_token,
      apiKey: process.env.KITE_API_KEY,
    })
    throw error
  }
}

/**
 * Cancel the first TRIGGER PENDING order matching tradingsymbol + transaction type.
 */
export async function cancelOrder(
  tradingsymbol: string,
  transactionType: string,
  accessToken: string
): Promise<void> {
  const kite = getKiteInstance(accessToken)
  const orders = (await kite.getOrders()) as Order[]
  const orderToCancel = orders.find(
    o =>
      o.tradingsymbol === tradingsymbol &&
      o.transaction_type === transactionType &&
      o.status === "TRIGGER PENDING"
  )
  if (!orderToCancel) {
    logger.warn(
      `[cancelOrder] No TRIGGER PENDING ${transactionType} order found for ${tradingsymbol}`
    )
    return
  }
  await kite.cancelOrder("regular", orderToCancel.order_id)
  logger.info(`[cancelOrder] Cancelled order ${orderToCancel.order_id} for ${tradingsymbol}`)
}

/**
 * Place a regular order on Kite using an access token directly.
 */
export async function placeKiteOrder(
  accessToken: string,
  params: PlaceOrderParams
): Promise<any> {
  const kite = getKiteInstance(accessToken)
  return placeOrder(kite, "regular", params)
}

/**
 * Modify or place a SL order for an existing open position. Falls back to a market order if
 * the stoploss is already breached at time of placement.
 */
export async function placeSL(
  tradingsymbol: string,
  transactionType: string,
  quantity: number,
  accessToken: string,
  stoploss: number
): Promise<void> {
  const kite = getKiteInstance(accessToken)

  const positions = (await kite.getPositions()) as any
  const position = positions.net?.find(
    (p: any) => p.tradingsymbol === tradingsymbol && p.quantity !== 0
  )
  if (!position) {
    logger.warn(`[placeSL] No open position found for ${tradingsymbol}`)
    return
  }
  const actualTransactionType = position.quantity > 0 ? "SELL" : "BUY"
  if (actualTransactionType !== transactionType) {
    logger.error(
      `[placeSL] Transaction type mismatch for ${tradingsymbol}: expected ${actualTransactionType}, got ${transactionType}`
    )
    return
  }

  const price = transactionType === "BUY" ? stoploss + 5 : stoploss - 5
  const orders = (await kite.getOrders()) as Order[]
  const existingSL = orders.find(
    o =>
      o.tradingsymbol === tradingsymbol &&
      o.transaction_type === transactionType &&
      o.status === "TRIGGER PENDING"
  )

  if (existingSL) {
    await kite.modifyOrder("regular", existingSL.order_id, {
      trigger_price: stoploss,
      price,
    } as any)
    logger.info(`[placeSL] Modified SL order ${existingSL.order_id} to ${stoploss} for ${tradingsymbol}`)
    return
  }

  const ltpKey = `NFO:${tradingsymbol}`
  const ltpData = await kite.getLTP(ltpKey)
  const ltp = (ltpData as any)[ltpKey]?.last_price
  if (ltp === undefined) {
    logger.error(`[placeSL] Failed to fetch LTP for ${tradingsymbol}`)
    return
  }

  const stoplossBreached =
    (transactionType === "BUY" && stoploss < ltp) ||
    (transactionType === "SELL" && stoploss > ltp)

  if (stoplossBreached) {
    logger.warn(`[placeSL] Stoploss ${stoploss} already breached for ${tradingsymbol}, placing market order`)
    await placeOrder(kite, "regular", {
      tradingsymbol,
      exchange: "NFO",
      transaction_type: transactionType,
      quantity,
      order_type: "MARKET",
      product: "NRML",
      tag: "chase",
    } as PlaceOrderParams)
  } else {
    await placeOrder(kite, "regular", {
      tradingsymbol,
      exchange: "NFO",
      transaction_type: transactionType,
      quantity,
      order_type: "SL",
      product: "NRML",
      tag: "chase",
      trigger_price: stoploss,
      price,
    } as PlaceOrderParams)
  }
  logger.info(`[placeSL] Placed SL order for ${tradingsymbol} at ${stoploss}`)
}

/**
 * Fetch LTPs for multiple instruments using the Kite SDK.
 * @param instruments - Array of { exchange, tradingSymbol }
 * @param user - session user object containing access_token
 * @returns Mapping from tradingSymbol -> { exchange, tradingSymbol, instrumentToken, lastPrice }
 */
export async function getMultipleInstrumentPrices(instruments: Array<{ exchange: string; tradingSymbol: string }>, user: any) {
  const kite = syncGetKiteInstance(user)

  const results = await Promise.all(
    instruments.map(async ({ exchange, tradingSymbol }) => {
      const key = `${exchange}:${tradingSymbol}`
      const res = await kite.getLTP(key)
      const data = res[key]
      return [tradingSymbol, {
        exchange,
        tradingSymbol,
        instrumentToken: data?.instrument_token,
        lastPrice: data?.last_price,
      }]
    })
  )

  return Object.fromEntries(results)
}

export async function getNetPositionQty(kite: any, tradingsymbol: string): Promise<number> {
  const positions = await kite.getPositions()
  const net = (positions.net as any[]).find((p: any) => p.tradingsymbol === tradingsymbol)
  return net?.quantity ?? 0
}
