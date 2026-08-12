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

import { eq } from "drizzle-orm"
import logger from "./logger"
import type { COMPLETED_BY_TAG } from "./constants"
import { EXPIRY_TYPE, INSTRUMENT_DETAILS, USER_OVERRIDE, STATUS_TRIGGER_PENDING, type INSTRUMENTS } from "./constants"
import { db } from "./drizzle"
import { allSettled } from "./es6-promise"
import { jobExecutions } from "./schema"
import type { KiteOrder } from "../types/kite"
import type { SignalXUser } from "../types/misc"
import { millisecondsTill7, closest, delay, finiteStateChecker, orderStateChecker, RemoteRetryTimeoutError, withRemoteRetry, isMockOrder, ms } from "./utils"

dayjs.extend(isSameOrBefore)

export type PlaceOrderParams = Parameters<Connect["placeOrder"]>[1]

export type TradingSymbolInterface = Instrument
export interface StrikeInterface {
  PE_STRING: string
  CE_STRING: string
  LOT_SIZE: number
}

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

/**
 * Fetch instruments for a given exchange, filtered to index derivatives for NFO.
 *
 * @param exchange - Exchange to fetch instruments from (default: NFO).
 * @returns An array of Kite Instrument objects.
 */
export async function asyncGetIndexInstruments(exchange = "NFO"): Promise<Instrument[]> {
  const kite = getKiteInstance()
  const instruments = await kite.getInstruments(exchange as Exchanges)
logger.info(`[asyncGetIndexInstruments] Fetched ${instruments.length} instruments for exchange: ${exchange}`);
  if (exchange === "NFO") {
    return instruments.filter(
      item => item.name === "NIFTY" || item.name === "BANKNIFTY" || item.name === "FINNIFTY"
    )
  }
  return instruments
}

/**
 * Memoized wrapper for asyncGetIndexInstruments to reduce repeated Kite instrument calls.
 *
 * @returns A cached promise resolving to an array of Kite Instrument objects.
 */
export const getIndexInstruments = memoizer(asyncGetIndexInstruments, {
  maxAge: millisecondsTill7(),
  promise: true,
})

/**
 * Filter the cached index instruments by any combination of symbol, strike, instrument type,
 * and trading symbol, then sort results by expiry date ascending.
 *
 * @param nfoSymbol - Underlying name to filter on (e.g. NIFTY, BANKNIFTY).
 * @param strike - Strike price to match exactly.
 * @param instrumentType - Option type to filter (CE or PE).
 * @param tradingsymbol - Exact Kite trading symbol to match.
 * @returns Matching instruments sorted by nearest expiry first.
 */
export const getSortedMatchingIntrumentsData = async ({
  nfoSymbol,
  strike,
  instrumentType,
  tradingsymbol,
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  tradingsymbol?: string
}): Promise<Instrument[]> => {
  const instrumentsData = await getIndexInstruments()
  return instrumentsData
    .filter(
      item =>
        (nfoSymbol ? item.name === nfoSymbol : true) &&
        (strike ? item.strike == strike : true) && // eslint-disable-line
        (tradingsymbol ? item.tradingsymbol === tradingsymbol : true) &&
        (instrumentType ? item.instrument_type === instrumentType : true)
    )
    .sort((row1, row2) => (dayjs(row1.expiry).isSameOrBefore(dayjs(row2.expiry)) ? -1 : 1))
}

/**
 * Return all OTM option instruments for a given underlying, strike, type, and expiry date.
 * CE options have a strike above the pivot; PE options have a strike below.
 *
 * @param nfoSymbol - Underlying name (e.g. NIFTY, BANKNIFTY).
 * @param strike - Pivot strike; OTM CE strikes are above it, PE strikes below.
 * @param instrumentType - Option type: CE or PE.
 * @param expiry - Expiry date string to filter on.
 * @returns Instruments sorted by strike ascending.
 */
export const getOTMOptions = async ({
  nfoSymbol,
  strike,
  instrumentType,
  expiry,
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  expiry?: string
}): Promise<Instrument[]> => {
  const instrumentsData = await getIndexInstruments()
  return instrumentsData
    .filter(
      item =>
        (nfoSymbol ? item.name === nfoSymbol : true) &&
        (strike ? (instrumentType === "CE" ? item.strike > strike : item.strike < strike) : true) &&
        (instrumentType ? item.instrument_type === instrumentType : true) &&
        (expiry ? item.expiry === expiry : true)
    )
    .sort((row1, row2) => (row1.strike < row2.strike ? -1 : 1))
}

/**
 * Fetch OHLC data for an instrument and annotate it with an intraday trend direction.
 * Trend is "CE" when last price is below open (bearish) and "PE" when above (bullish).
 *
 * @param kite - Authenticated KiteConnect instance.
 * @param symbol - Instrument key in "EXCHANGE:TRADINGSYMBOL" format.
 * @param instrument - Instrument identifier passed through to the Kite OHLC call.
 * @returns Object with `trend` and `last_price`, or undefined on error.
 */
export async function getOHLC({ kite, symbol, instrument }): Promise<any> {
  try {
    const data = await kite.getOHLC(symbol)
    logger.info("getOHLC data", data)
    if (data[symbol].last_price < data[symbol].ohlc.open) data[symbol].trend = "CE"
    else data[symbol].trend = "PE"
    return {
      trend: data[symbol].trend,
      last_price: data[symbol].last_price,
    }
  } catch (e) {
    logger.info(`Excpetion is coming: ${e}`)
  }
}

/**
 * Fetch the last traded price (LTP) for an instrument via the Kite LTP API.
 *
 * @param kite - Authenticated KiteConnect instance.
 * @param underlying - Trading symbol of the instrument (e.g. NIFTY, BANKNIFTY25JUNFUT).
 * @param exchange - Exchange segment (e.g. NSE, NFO).
 * @returns The last traded price as a number.
 */
export async function getInstrumentPrice(
  kite,
  underlying: string,
  exchange: string
): Promise<number> {
  const instrumentString = `${exchange}:${underlying}`
  const underlyingRes = await kite.getLTP(instrumentString)
  return Number(underlyingRes[instrumentString].last_price)
}

/**
 * Compute the percentage price skew between two option legs using their LTPs.
 * Skew is the absolute mid-point percentage difference between the two prices.
 *
 * @param kite - Authenticated KiteConnect instance.
 * @param instrument1 - Trading symbol of the first leg (e.g. CE string).
 * @param instrument2 - Trading symbol of the second leg (e.g. PE string).
 * @param exchange - Exchange segment for both instruments.
 * @returns Object with each instrument's price and the computed skew percentage.
 */
export async function getSkew(kite, instrument1, instrument2, exchange) {
  const [price1, price2] = await Promise.all([
    getInstrumentPrice(kite, instrument1, exchange),
    getInstrumentPrice(kite, instrument2, exchange),
  ])
  const skew = Math.floor((Math.abs(price1 - price2) / ((price1 + price2) / 2)) * 100)
  return {
    [instrument1]: price1,
    [instrument2]: price2,
    skew,
  }
}

/**
 * Look up the nearest (current) weekly expiry trading symbol for a given strike.
 * When no instrumentType is provided, returns a StrikeInterface with PE_STRING, CE_STRING,
 * and LOT_SIZE. With an instrumentType, returns the matching Instrument directly.
 *
 * @param nfoSymbol - Underlying name (e.g. NIFTY, BANKNIFTY).
 * @param strike - Strike price to match.
 * @param instrumentType - Option type (CE or PE); omit to get both legs.
 * @param tradingsymbol - Exact trading symbol override.
 * @returns TradingSymbolInterface, StrikeInterface, or null if not found.
 */
export const getCurrentExpiryTradingSymbol = async ({
  nfoSymbol,
  strike,
  instrumentType,
  tradingsymbol,
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  tradingsymbol?: string
}): Promise<TradingSymbolInterface | StrikeInterface | null> => {
  const rows = await getSortedMatchingIntrumentsData({
    nfoSymbol,
    strike,
    instrumentType,
    tradingsymbol,
  })
  if (instrumentType) {
    return rows.length ? rows[0] : null
  }
  const relevantRows = rows.slice(0, 2)
  const peStrike = relevantRows?.find(item => item.instrument_type === "PE")?.tradingsymbol
  const ceStrike = relevantRows?.find(item => item.instrument_type === "CE")?.tradingsymbol
  const lotSize = relevantRows?.find(item => item.instrument_type === "PE")?.lot_size
  if (!peStrike || !ceStrike) return null
  return {
    PE_STRING: peStrike,
    CE_STRING: ceStrike,
    LOT_SIZE: Number(lotSize!),
  }
}

/**
 * Look up the next weekly expiry trading symbol for a given strike (second-nearest expiry).
 * When no instrumentType is provided, returns a StrikeInterface with PE_STRING, CE_STRING,
 * and LOT_SIZE. With an instrumentType, returns the matching Instrument directly.
 *
 * @param nfoSymbol - Underlying name (e.g. NIFTY, BANKNIFTY).
 * @param strike - Strike price to match.
 * @param instrumentType - Option type (CE or PE); omit to get both legs.
 * @param tradingsymbol - Exact trading symbol override.
 * @returns TradingSymbolInterface, StrikeInterface, or null if not found.
 */
export const getNextExpiryTradingSymbol = async ({
  nfoSymbol,
  strike,
  instrumentType,
  tradingsymbol,
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  tradingsymbol?: string
}): Promise<TradingSymbolInterface | StrikeInterface | null> => {
  const rows = await getSortedMatchingIntrumentsData({
    nfoSymbol,
    strike,
    instrumentType,
    tradingsymbol,
  })
  if (instrumentType) {
    return rows.length ? rows[1] : null
  }
  const relevantRows = rows.slice(2, 4)
  const peStrike = relevantRows?.find(item => item.instrument_type === "PE")?.tradingsymbol
  const ceStrike = relevantRows?.find(item => item.instrument_type === "CE")?.tradingsymbol
  const lotSize = relevantRows?.find(item => item.instrument_type === "PE")?.lot_size
  if (!peStrike || !ceStrike) return null
  return {
    PE_STRING: peStrike,
    CE_STRING: ceStrike,
    LOT_SIZE: Number(lotSize!),
  }
}

/**
 * Look up the monthly (last Thursday of the current calendar month) expiry trading symbol.
 * Falls back to the next month if no instruments remain in the current month.
 * When no instrumentType is provided, returns a StrikeInterface with PE_STRING, CE_STRING,
 * and LOT_SIZE. With an instrumentType, returns the matching Instrument directly.
 *
 * @param nfoSymbol - Underlying name (e.g. NIFTY, BANKNIFTY).
 * @param strike - Strike price to match.
 * @param instrumentType - Option type (CE or PE); omit to get both legs.
 * @param tradingsymbol - Exact trading symbol override.
 * @returns TradingSymbolInterface, StrikeInterface, or null if not found.
 */
export const getMonthlyExpiryTradingSymbol = async ({
  nfoSymbol,
  strike,
  instrumentType,
  tradingsymbol,
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  tradingsymbol?: string
}): Promise<TradingSymbolInterface | StrikeInterface | null> => {
  const instrumentsData = await getSortedMatchingIntrumentsData({
    nfoSymbol,
    strike,
    instrumentType,
    tradingsymbol,
  })
  let rows = instrumentsData.filter(
    item => dayjs().get("month") === dayjs(item.expiry).get("month")
  )
  if (!rows.length) {
    const month = dayjs().get("month") === 11 ? 0 : dayjs().get("month")
    rows = instrumentsData.filter(item => dayjs(item.expiry).get("month") === month)
  }
  rows = rows.sort((row1, row2) => (dayjs(row1.expiry).isSameOrBefore(dayjs(row2.expiry)) ? -1 : 1))
  const rowsLength = rows.length
  if (instrumentType) {
    return rows.length ? rows[rowsLength - 1] : null
  }
  const relevantRows = rows.slice(rowsLength - 2, rowsLength)
  const peStrike = relevantRows?.find(item => item.instrument_type === "PE")?.tradingsymbol
  const ceStrike = relevantRows?.find(item => item.instrument_type === "CE")?.tradingsymbol
  const lotSize = relevantRows?.find(item => item.instrument_type === "PE")?.lot_size
  if (!peStrike || !ceStrike) return null
  return {
    PE_STRING: peStrike,
    CE_STRING: ceStrike,
    LOT_SIZE: Number(lotSize!),
  }
}

/**
 * Route to the correct expiry trading symbol lookup based on the requested EXPIRY_TYPE.
 * Delegates to getCurrentExpiryTradingSymbol, getNextExpiryTradingSymbol, or
 * getMonthlyExpiryTradingSymbol accordingly.
 *
 * @param nfoSymbol - Underlying name (e.g. NIFTY, BANKNIFTY).
 * @param strike - Strike price to match.
 * @param instrumentType - Option type (CE or PE); omit to get both legs as StrikeInterface.
 * @param tradingsymbol - Exact trading symbol override.
 * @param expiry - Which expiry to target: CURRENT (default), NEXT, or MONTHLY.
 * @returns TradingSymbolInterface, StrikeInterface, or null if not found.
 */
export const getExpiryTradingSymbol = async ({
  nfoSymbol,
  strike,
  instrumentType,
  tradingsymbol,
  expiry = EXPIRY_TYPE.CURRENT,
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  tradingsymbol?: string
  expiry?: EXPIRY_TYPE
}): Promise<TradingSymbolInterface | StrikeInterface | null> => {
  logger.info("Fetching trading symbol for expiry type: ", expiry)
  switch (expiry) {
    case EXPIRY_TYPE.MONTHLY:
      return getMonthlyExpiryTradingSymbol({ nfoSymbol, strike, instrumentType, tradingsymbol })
    case EXPIRY_TYPE.NEXT:
      return getNextExpiryTradingSymbol({ nfoSymbol, strike, instrumentType, tradingsymbol })
    default:
      return getCurrentExpiryTradingSymbol({ nfoSymbol, strike, instrumentType, tradingsymbol })
  }
}

/**
 * Derive the hedge option trading symbol for a short leg at a given strike.
 * The hedge strike is offset from the short strike by `distance` step sizes in
 * the protective direction (below for PE, above for CE).
 *
 * @param strike - The short leg's strike price.
 * @param distance - Number of strike steps away from the short leg.
 * @param type - Option type of the short leg: CE or PE.
 * @param nfoSymbol - Underlying name (e.g. NIFTY, BANKNIFTY).
 * @param expiryType - Which expiry to use for the hedge leg.
 * @returns The trading symbol string for the hedge instrument, or undefined if not found.
 */
export const getHedgeForStrike = async ({
  strike,
  distance,
  type,
  nfoSymbol,
  expiryType = EXPIRY_TYPE.CURRENT,
}: {
  strike: number
  distance: number
  type: string
  nfoSymbol: string
  expiryType: EXPIRY_TYPE
}): Promise<string | undefined> => {
  const hedgeStrike = strike + distance * (type === "PE" ? -1 : 1)
  const { tradingsymbol } = (await getExpiryTradingSymbol({
    nfoSymbol,
    strike: hedgeStrike,
    instrumentType: type,
    expiry: expiryType,
  })) as TradingSymbolInterface
  return tradingsymbol
}

/**
 * Check whether the user has sufficient margin to place a basket of orders.
 * Compares available equity margin against the total initial margin required.
 *
 * @param user - Session user object containing a valid Kite access token.
 * @param orders - Array of margin orders to evaluate.
 * @returns `true` if margin is sufficient, `false` otherwise.
 */
export const ensureMarginForBasketOrder = async (user, orders) => {
  const kite = syncGetKiteInstance(user)
  const margins = await kite.getMargins()
  const net = margins.equity?.net ?? 0
  logger.info("[ensureMarginForBasketOrder]", { net })
  const totalMarginRequired = await orderBasketMargins(user.session.access_token, orders)
  logger.info("[ensureMarginForBasketOrder]", { totalMarginRequired })
  const canPunch = totalMarginRequired < net
  if (!canPunch) {
    logger.error("🔴 [ensureMarginForBasketOrder] margin check failed!")
  }
  return canPunch
}

interface LTP_TYPE {
  tradingsymbol: string
  strike: number
  last_price: number
}

interface TRADING_SYMBOL_BY_OPTION_PRICE_TYPE {
  nfoSymbol?: string
  price: number
  instrumentType?: string
  pivotStrike: number
  user: SignalXUser
  greaterThanEqualToPrice?: boolean
  expiry?: EXPIRY_TYPE
}

/**
 * Find the OTM CE and PE instruments whose last traded prices are closest to the target price.
 * Fetches all OTM options for the given underlying around the pivot strike, prices them via
 * the Kite LTP API, and returns the best-matching CE and PE pair.
 *
 * @param nfoSymbol - Underlying name (e.g. NIFTY, BANKNIFTY).
 * @param price - Target option premium to match.
 * @param pivotStrike - ATM strike used as the OTM search pivot.
 * @param user - Session user object with a valid Kite access token.
 * @param greaterThanEqualToPrice - When true, only consider options priced at or above target.
 * @param expiry - Expiry type: CURRENT, NEXT, or MONTHLY.
 * @returns Tuple of [CE instrument, PE instrument] closest to the target price.
 */
export const getOTMStrangleByOptionPrice = async ({
  nfoSymbol,
  price,
  pivotStrike,
  user,
  greaterThanEqualToPrice = false,
  expiry = EXPIRY_TYPE.CURRENT,
}: TRADING_SYMBOL_BY_OPTION_PRICE_TYPE): Promise<Partial<Instrument>[]> => {
  logger.info(
    `[kiteUtils.getOTMStrangleByOptionPrice] nfoSymbol ${nfoSymbol}, price:${price}, pivotStrike:${pivotStrike}`
  )
  const kite = syncGetKiteInstance(user)
  const expiryArray = await getNiftyOptionExpiries()
  let expiryDate: string
  if (expiry === EXPIRY_TYPE.CURRENT) expiryDate = expiryArray[0]
  else if (expiry === EXPIRY_TYPE.NEXT) expiryDate = expiryArray[1]
  else {
    const month = dayjs(expiryArray[0]).month()
    expiryDate = expiryArray[0]
    for (let i = 1; i < 10; i++) {
      if (!(month === dayjs(expiryArray[i]).month())) {
        expiryDate = expiryArray[i - 1]
        break
      }
    }
  }

  const otmCEOptions = await getOTMOptions({ nfoSymbol, strike: pivotStrike, instrumentType: "CE", expiry: expiryDate })
  const otmPEOptions = await getOTMOptions({ nfoSymbol, strike: pivotStrike, instrumentType: "PE", expiry: expiryDate })

  const otmCEInstruments = otmCEOptions.map(row => ({ exchange: kite.EXCHANGE_NFO, tradingSymbol: row.tradingsymbol }))
  const otmPEInstruments = otmPEOptions.map(row => ({ exchange: kite.EXCHANGE_NFO, tradingSymbol: row.tradingsymbol }))

  const otmCEPrices = await getMultipleInstrumentPrices(otmCEInstruments, user)
  const otmPEPrices = await getMultipleInstrumentPrices(otmPEInstruments, user)

  const getStrike = (inst: string) => Number(inst.replace(nfoSymbol!, "").slice(5, 10))

  const CEformattedPrices: LTP_TYPE[] = otmCEInstruments.map(({ tradingSymbol }) => {
    const { instrumentToken, lastPrice } = otmCEPrices[tradingSymbol]
    return { tradingsymbol: tradingSymbol, strike: getStrike(tradingSymbol), instrument_token: instrumentToken, last_price: lastPrice }
  })
  const PEformattedPrices: LTP_TYPE[] = otmPEInstruments.map(({ tradingSymbol }) => {
    const { instrumentToken, lastPrice } = otmPEPrices[tradingSymbol]
    return { tradingsymbol: tradingSymbol, strike: getStrike(tradingSymbol), instrument_token: instrumentToken, last_price: lastPrice }
  })

  return [
    closest(price, CEformattedPrices, "last_price", greaterThanEqualToPrice) as Partial<Instrument>,
    closest(price, PEformattedPrices, "last_price", greaterThanEqualToPrice) as Partial<Instrument>,
  ]
}

/**
 * Find the single option instrument (CE or PE) whose LTP is closest to the target price,
 * searching across 61 strikes centred on the pivot (30 on each side).
 *
 * @param nfoSymbol - Underlying name (e.g. NIFTY, BANKNIFTY).
 * @param price - Target option premium to match.
 * @param instrumentType - Option type to search: CE or PE.
 * @param pivotStrike - Centre strike for the search range.
 * @param user - Session user object with a valid Kite access token.
 * @param greaterThanEqualToPrice - When true, only consider options priced at or above target.
 * @param expiry - Expiry type: CURRENT, NEXT, or MONTHLY.
 * @returns The instrument object closest in price to the target.
 */
export const getTradingSymbolsByOptionPrice = async ({
  nfoSymbol,
  price,
  instrumentType,
  pivotStrike,
  user,
  greaterThanEqualToPrice = false,
  expiry = EXPIRY_TYPE.CURRENT,
}: TRADING_SYMBOL_BY_OPTION_PRICE_TYPE): Promise<Partial<Instrument>> => {
  const kite = syncGetKiteInstance(user)
  const totalStrikes = 61
  const { strikeStepSize } = INSTRUMENT_DETAILS[nfoSymbol!]
  const strikes = [...new Array(totalStrikes)]
    .map((_, idx) =>
      idx === 0 ? idx : idx < totalStrikes / 2 ? idx * -1 : idx - Math.floor(totalStrikes / 2)
    )
    .map(idx => pivotStrike + idx * strikeStepSize)
    .sort((a, b) => a - b)

  const instruments = await Promise.all(
    strikes.map(async (strike: number) => {
      const tradingSymbolInterface = (await getExpiryTradingSymbol({
        nfoSymbol,
        strike,
        instrumentType,
        expiry,
      })) as TradingSymbolInterface
      const tradingsymbol = tradingSymbolInterface?.tradingsymbol
      logger.info(`[getTradingSymbolsByOptionPrice] Trading symbol is ${tradingsymbol}`)
      return { exchange: kite.EXCHANGE_NFO, tradingSymbol: tradingsymbol }
    })
  )

  const priceDataByTradingSymbol = await getMultipleInstrumentPrices(instruments, user)
  const getStrike = (inst: string) => Number(inst.replace(nfoSymbol!, "").slice(5, 10))

  const formattedPrices: LTP_TYPE[] = instruments.map(({ tradingSymbol }) => {
    const { instrumentToken, lastPrice } = priceDataByTradingSymbol[tradingSymbol]
    return { tradingsymbol: tradingSymbol, strike: getStrike(tradingSymbol), instrument_token: instrumentToken, last_price: lastPrice }
  })

  return closest(price, formattedPrices, "last_price", greaterThanEqualToPrice) as Partial<Instrument>
}

/**
 * Place an order and ensure it reaches a confirmed terminal state, with retries.
 * Handles freeze-quantity splitting, user abort checks, mock-order mode, broker
 * NetworkException / OrderException recovery, and rejected-order retries.
 *
 * Resolves with `{ successful: true, response }` when all legs are confirmed,
 * `{ successful: false }` when state cannot be determined within the timeout,
 * or throws on exhausted retries or non-retryable broker errors.
 *
 * @param _kite - Pre-existing KiteConnect instance; derived from `user` if omitted.
 * @param ensureOrderState - The target Kite order status to wait for (e.g. STATUS_COMPLETE).
 * @param orderProps - Kite order payload to place.
 * @param instrument - Instrument identifier used to look up the freeze quantity.
 * @param onFailureRetryAfterMs - Delay in ms between retry attempts (default 15 s).
 * @param retryAttempts - Maximum number of placement attempts (default 3).
 * @param orderStatusCheckTimeout - Max ms to wait for the order to reach terminal state (default 2 min).
 * @param remoteRetryTimeout - Max ms for `withRemoteRetry` calls during recovery (default 1 min).
 * @param user - Session user object with a valid Kite access token.
 * @param attemptCount - Internal retry counter; always pass 0 (or omit) from call sites.
 */
export const remoteOrderSuccessEnsurer = async (args: {
  _kite?: Record<string, unknown>
  ensureOrderState: string
  orderProps: Partial<KiteOrder>
  instrument: INSTRUMENTS
  onFailureRetryAfterMs?: number
  retryAttempts?: number
  orderStatusCheckTimeout?: number
  remoteRetryTimeout?: number
  user: SignalXUser
  attemptCount?: number
}): Promise<{
  successful: boolean
  response?: KiteOrder[]
}> => {
  const {
    _kite,
    ensureOrderState,
    orderProps,
    onFailureRetryAfterMs = ms(15),
    retryAttempts = 3,
    orderStatusCheckTimeout = ms(2 * 60),
    remoteRetryTimeout = ms(60),
    user,
    instrument,
    attemptCount = 0,
  } = args

  if (attemptCount >= retryAttempts) {
    logger.error("🔴 [remoteOrderSuccessEnsurer] all attempts exhausted. Terminating!")
    throw new RemoteRetryTimeoutError("remoteOrderSuccessEnsurer attempts exhausted")
  }

  if (attemptCount > 0) {
    await delay(onFailureRetryAfterMs)
    logger.info("retry attempt", { attemptCount: attemptCount + 1, retryAttempts })
  }

  const dbTradeRows = await db
    .select({ userOverride: jobExecutions.userOverride })
    .from(jobExecutions)
    .where(eq(jobExecutions.orderTag, orderProps.tag!))

  const userOverride = dbTradeRows[0]?.userOverride
  if (userOverride === USER_OVERRIDE.ABORT) {
    logger.error("🔴 [remoteOrderSuccessEnsurer] user override ABORT. Terminating!")
    throw Error(USER_OVERRIDE.ABORT)
  }

  const kite = (_kite ?? syncGetKiteInstance(user)) as any

  const { freezeQty } = INSTRUMENT_DETAILS[instrument]
  if (orderProps.quantity! > freezeQty) {
    const ordersCount = Math.ceil(orderProps.quantity! / freezeQty)
    const freezeQtyOrders = [...new Array(ordersCount).fill(null)].map((_, idx) => {
      if (idx === ordersCount - 1) {
        return { ...orderProps, quantity: orderProps.quantity! - idx * freezeQty }
      }
      return { ...orderProps, quantity: freezeQty }
    })

    const orderResults: any = await allSettled(
      freezeQtyOrders.map(order => remoteOrderSuccessEnsurer({ ...args, orderProps: order }))
    )

    const isSuccessful = orderResults.every(
      orderResult => orderResult.status === "fulfilled" && orderResult.value?.successful
    )

    return {
      successful: isSuccessful,
      response: orderResults
        .map(orderResult =>
          orderResult.status === "fulfilled" && orderResult.value?.successful
            ? orderResult.value.response
            : null
        )
        .filter(o => o)
        .reduce((accum, ordersArr) => [...accum, ...ordersArr], []),
    }
  }

  try {
    const mockOrders = isMockOrder()
    if (mockOrders) {
      logger.info("mock order", orderProps)
    }
    logger.info(`[remoteOrderSuccessEnsurer] Order details are ${JSON.stringify(orderProps)}`)
    const orderAckResponse = mockOrders
      ? { order_id: "" }
      : await placeOrder(kite, kite.VARIETY_REGULAR, orderProps as PlaceOrderParams)
    const { order_id: ackOrderId } = orderAckResponse
    const { promise: isOrderInUltimateStatePr, cancel: cancelOrderStateCheck } = orderStateChecker(
      kite,
      ackOrderId,
      ensureOrderState
    )
    try {
      const ultimateStateOrder = await finiteStateChecker(
        isOrderInUltimateStatePr,
        orderStatusCheckTimeout,
        cancelOrderStateCheck
      )
      return { successful: true, response: [ultimateStateOrder] }
    } catch (e) {
      logger.error("🔴 [remoteOrderSuccessEnsurer] caught", e)
      if (e instanceof RemoteRetryTimeoutError) {
        return { successful: false, response: [orderAckResponse] }
      }
      if (e?.message === kite.STATUS_REJECTED) {
        logger.info("🟢 [remoteOrderSuccessEnsurer] retrying rejected order", orderProps)
        return remoteOrderSuccessEnsurer({ ...args, attemptCount: attemptCount + 1 })
      }
      throw e
    }
  } catch (e) {
    logger.error("🔴 [remoteOrderSuccessEnsurer] placeOrder failed?", e)

    if (
      e?.status === "error" &&
      (e?.error_type === "PermissionException" || e?.error_type === "InputException")
    ) {
      logger.error("🔴 [remoteOrderSuccessEnsurer] non-retryable error", e?.error_type)
      throw e
    }

    if (
      e?.status === "error" &&
      (e?.error_type === "NetworkException" || e?.error_type === "OrderException")
    ) {
      try {
        const orders = await withRemoteRetry(() => kite.getOrders(), remoteRetryTimeout)
        const matchedOrder = orders.find(
          order =>
            order.tag === orderProps.tag &&
            order.tradingsymbol === orderProps.tradingsymbol &&
            order.quantity === orderProps.quantity &&
            order.product === orderProps.product &&
            order.transaction_type === orderProps.transaction_type &&
            order.exchange === orderProps.exchange
        )

        if (!matchedOrder) {
          return remoteOrderSuccessEnsurer({ ...args, attemptCount: attemptCount + 1 })
        }

        const {
          promise: isMatchedOrderInUltimateStatePr,
          cancel: cancelMatchedOrderStateCheck,
        } = orderStateChecker(kite, matchedOrder.order_id, ensureOrderState)
        try {
          const ultimateStateOrder = await finiteStateChecker(
            isMatchedOrderInUltimateStatePr,
            orderStatusCheckTimeout,
            cancelMatchedOrderStateCheck
          )
          return { successful: true, response: [ultimateStateOrder] }
        } catch (e) {
          if (e?.message === kite.STATUS_REJECTED) {
            return remoteOrderSuccessEnsurer({ ...args, attemptCount: attemptCount + 1 })
          }
          throw e
        }
      } catch (e) {
        logger.error("🔴 [remoteOrderSuccessEnsurer] caught with no response from broker", e)
        return { successful: false }
      }
    }

    logger.error("🔴 [remoteOrderSuccessEnsurer] unhandled parent caught", e)
    return { successful: false }
  }
}

/**
 * Fetch the next 40 FnO expiry instruments for the requested underlying and type,
 * sorted by expiry date ascending and filtered to expiries from today onwards.
 *
 * @param nfoSymbol - Underlying symbol: NIFTY, BANKNIFTY, or FINNIFTY (default NIFTY).
 * @param instrumentType - Instrument type to filter: CE, PE, or FUT (default CE).
 * @returns Up to 40 Kite Instrument objects sorted by nearest expiry first.
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
  maxAge: millisecondsTill7(),
  promise: true,
})

/**
 * Get memoized expiry dates for NIFTY/BANKNIFTY/FINNIFTY option instruments.
 *
 * @returns A cached list of expiry date strings in ascending order.
 */
export const getNiftyOptionExpiries = memoizer(getFnOExpiries, {
  maxAge: millisecondsTill7(),
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
      o.status === STATUS_TRIGGER_PENDING
  )
  if (!orderToCancel) {
    logger.warn(
      `[cancelOrder] No TRIGGER PENDING ${transactionType} order found for ${tradingsymbol}`
    )
    return
  }
  await kite.cancelOrder(kite.VARIETY_REGULAR, orderToCancel.order_id)
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
  return placeOrder(kite, kite.VARIETY_REGULAR, params)
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
      o.status === STATUS_TRIGGER_PENDING
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
    await placeOrder(kite, kite.VARIETY_REGULAR, {
      tradingsymbol,
      exchange: kite.EXCHANGE_NFO,
      transaction_type: transactionType,
      quantity,
      order_type: kite.ORDER_TYPE_LIMIT,
      product: kite.PRODUCT_NRML,
      price: ltp,
      tag: "chase",
    } as PlaceOrderParams)
  } else {
    await placeOrder(kite, kite.VARIETY_REGULAR, {
      tradingsymbol,
      exchange: kite.EXCHANGE_NFO,
      transaction_type: transactionType,
      quantity,
      order_type: kite.ORDER_TYPE_SL,
      product: kite.PRODUCT_NRML,
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

/**
 * Fetch the net open position quantity for a given trading symbol.
 *
 * @param kite - Authenticated KiteConnect instance.
 * @param tradingsymbol - Kite trading symbol to look up (e.g. NIFTY25JUNFUT).
 * @returns Net quantity (positive for long, negative for short, 0 if no position).
 */
export async function getNetPositionQty(kite: any, tradingsymbol: string): Promise<number> {
  const positions = await kite.getPositions()
  const net = (positions.net as any[]).find((p: any) => p.tradingsymbol === tradingsymbol)
  return net?.quantity ?? 0
}
