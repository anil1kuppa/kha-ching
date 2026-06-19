import axios from "axios"
import type Bluebird from "bluebird"
import { any, Promise } from "bluebird"
import dayjs, { type Dayjs } from "dayjs"
import { eq } from "drizzle-orm"
import type { Instrument, Order } from "kiteconnect"
import { KiteConnect } from "kiteconnect"
import type { KiteOrder } from "../types/kite"
import type { SignalXUser } from "../types/misc"
import { SUPPORTED_TRADE_CONFIG } from "../types/trade"
import {
  ACCESSTOKEN,
  COMPLETED_BY_TAG,
  ERROR_STRINGS,
  EXIT_STRATEGIES,
  EXPIRY_TYPE,
  INSTRUMENT_DETAILS,
  type INSTRUMENTS,
  TRADES,
  USER_OVERRIDE,
} from "./constants"
import { db } from "./drizzle"
// This function has been moved to Drizzle-backed utilities to use the job_executions table
import {
  getLatestAccessToken,
  patchDbTrade as patchDbTradeFromDb,
  storeAccessToken,
} from "./drizzleDbUtils"
import { allSettled, type allSettledInterface } from "./es6-promise"
import {
  getIndexInstruments,
  getFnOExpiries,
  getNiftyOptionExpiries,
  getCompletedOrdersbyTag as getCompletedOrdersbyTagFromKite,
  getMultipleInstrumentPrices,
  placeOrder as kitePlaceOrder,
  orderBasketMargins,
  type PlaceOrderParams,
  syncGetKiteInstance,
} from "./kiteUtils"
import logger from "./logger"
import { jobExecutions } from "./schema"
import { COMPLETED_ORDER_RESPONSE } from "./strategies/mockData/orderResponse"

Promise.config({ cancellation: true, warnings: true })

import isSameOrBefore from "dayjs/plugin/isSameOrBefore"
import timezone from "dayjs/plugin/timezone"
import utc from "dayjs/plugin/utc"

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(isSameOrBefore)



export type TradingSymbolInterface = Instrument
export interface StrikeInterface {
  PE_STRING: string
  CE_STRING: string
  LOT_SIZE: number
}

interface GET_LTP_ARGS {
  exchange: string
  tradingSymbol: string
}

export interface GET_LTP_RESPONSE extends GET_LTP_ARGS {
  instrumentToken: string
  lastPrice: number
}

const MOCK_ORDERS = process.env.MOCK_ORDERS ? JSON.parse(process.env.MOCK_ORDERS) : false
const KITE_API_KEY = process.env.KITE_API_KEY
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? ""

/**
 * Log an object as pretty JSON at info level.
 * @param object - anything to log
 */
export const logDeep = object => logger.info(JSON.stringify(object, null, 2))

/**
 * Convert seconds to milliseconds.
 * @param seconds - seconds to convert
 * @returns milliseconds
 */
export const ms = seconds => seconds * 1000

/**
 * Convert a date value to IST by adding the +5:30 offset in milliseconds.
 * @param value - dayjs object, Date, or timestamp string
 */
export const toIst = (value: dayjs.Dayjs | Date | string): dayjs.Dayjs => {
  return dayjs(value).tz("Asia/Kolkata")
}

/**
 * Post a simple text message to configured Slack Incoming Webhook URL.
 * Uses `axios` for HTTP requests and `logger` for structured logs.
 */
export async function postToSlack(message: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    logger.warn("[postToSlack] SLACK_WEBHOOK_URL not configured")
    return
  }

  try {
    await axios.post(
      SLACK_WEBHOOK_URL,
      { text: message },
      { headers: { "Content-Type": "application/json" } }
    )
    logger.info("[postToSlack] Message posted to Slack successfully")
  } catch (error) {
    logger.error("[postToSlack] Error posting message to Slack", error)
  }
}

/**
 * Promise-based delay for async flows.
 * @param ms - milliseconds to wait
 */
export const delay = ms =>
  new Promise(resolve =>
    setTimeout(() => {
      resolve()
    }, ms)
  )

/**
 * Returns the scheduled last square-off time used for MIS orders.
 * Formatted string suitable for dayjs parsing.
 */
export const getMisOrderLastSquareOffTime = () =>
  dayjs().set("hour", 15).set("minutes", 24).set("seconds", 0).format()

const getSortedMatchingIntrumentsData = async ({
  nfoSymbol, //NIFTY,BANKNIFTY,FINNIFTY
  strike,
  instrumentType, //CE,PE,FUT
  tradingsymbol,
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  tradingsymbol?: string
}): Promise<Instrument[]> => {
  const instrumentsData = await getIndexInstruments()
  const rows: Instrument[] = instrumentsData
    .filter(
      item =>
        (nfoSymbol ? item.name === nfoSymbol : true) &&
        (strike ? item.strike == strike : true) && // eslint-disable-line
        (tradingsymbol ? item.tradingsymbol === tradingsymbol : true) &&
        (instrumentType ? item.instrument_type === instrumentType : true)
    )
    .sort((row1, row2) => (dayjs(row1.expiry).isSameOrBefore(dayjs(row2.expiry)) ? -1 : 1))
  return rows
}
/*
Returns array of OTM Options
*/
const getOTMOptions = async ({
  nfoSymbol, //NIFTY,BANKNIFTY,FINNIFTY
  strike,
  instrumentType, //CE,PE,FUT
  expiry,
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  expiry?: string
}): Promise<Instrument[]> => {
  const instrumentsData = await getIndexInstruments()
  const rows: Instrument[] = instrumentsData
    .filter(
      item =>
        (nfoSymbol ? item.name === nfoSymbol : true) &&
        (strike ? (instrumentType === "CE" ? item.strike > strike : item.strike < strike) : true) &&
        //  (strike ? item.strike == strike : true) && // eslint-disable-line
        (instrumentType ? item.instrument_type === instrumentType : true) &&
        (expiry ? item.expiry === expiry : true)
    )
    .sort((row1, row2) => (row1.strike < row2.strike ? -1 : 1))
  return rows
}

/**
 * Fetch OHLC data for a given symbol using Kite and return trend/last price.
 * @param kite - Kite connect instance
 * @param symbol - exchange:tradingsymbol string
 */
export async function getOHLC({ kite, symbol, instrument }): Promise<any> {
  try {
    //console.log(`Checking ${await kite.getOHLC([NIFTY,BANKNIFTY])}`);
    const data = await kite.getOHLC(symbol)
    //console.log(`checking ${await kite.getOHLC(["NSE:NIFTY 50","NSE:NIFTY BANK"])}`);
    logger.info("getOHLC data", data)
    if (data[symbol].last_price < data[symbol].ohlc.open) data[symbol].trend = "CE"
    else data[symbol].trend = "PE"

    return {
      trend: data[symbol].trend,
      last_price: data[symbol].last_price,
    }
    //  data=await kite.getOHLC("NSE:NIFTY BANK");
    // //console.log(`checking ${await kite.getOHLC(["NSE:NIFTY 50","NSE:NIFTY BANK"])}`);
    // console.log(`Another ${data}`);
    // logDeep(data);
  } catch (e) {
    logger.info(`Excpetion is coming: ${e}`)
  }

  /* export async function getInstrumentPrice (
    kite,
    underlying: string,
    exchange: string
  ): Promise<number> {
    const instrumentString = `${exchange}:${underlying}`
    const underlyingRes = await kite.getLTP(instrumentString)
    return Number(underlyingRes[instrumentString].last_price)
  }
  */
}

/**
 * Resolve a trading symbol or strike object for a given expiry type.
 * @param params - lookup parameters including nfoSymbol, strike, instrumentType
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
      return getMonthlyExpiryTradingSymbol({
        nfoSymbol,
        strike,
        instrumentType,
        tradingsymbol,
      })

    case EXPIRY_TYPE.NEXT:
      return getNextExpiryTradingSymbol({
        nfoSymbol,
        strike,
        instrumentType,
        tradingsymbol,
      })

    default:
      return getCurrentExpiryTradingSymbol({
        nfoSymbol,
        strike,
        instrumentType,
        tradingsymbol,
      })
  }
}

/**
 * Get the current expiry trading symbol (CE/PE or FUT) for a strike or instrument.
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
  // get first two entries for current expiry
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
 * Get the next expiry trading symbol for a strike or instrument.
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
  // first two entries are CE and PE for current week. So taking the next two items here
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
 * Get the monthly expiry trading symbol, handling month boundary cases.
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

  // get current calendar month expiries
  let rows = instrumentsData.filter(
    item => dayjs().get("month") === dayjs(item.expiry).get("month")
  )

  //get next calendar month expiries
  if (!rows.length) {
    const month = dayjs().get("month") === 11 ? 0 : dayjs().get("month") // to handle December current year & Jan next year cases
    rows = instrumentsData.filter(item => dayjs(item.expiry).get("month") === month)
  }
  rows = rows.sort((row1, row2) => (dayjs(row1.expiry).isSameOrBefore(dayjs(row2.expiry)) ? -1 : 1))

  const rowsLength = rows.length

  if (instrumentType) {
    return rows.length ? rows[rowsLength - 1] : null
  }
  // get last two entries for monthly expiry
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
 * Calculate percentage change between two prices.
 * @param price1
 * @param price2
 * @param mode - calculation mode
 */
export function getPercentageChange(price1: number, price2: number, mode = "AGGRESIVE"): number {
  const denominator = mode === "AGGRESIVE" ? (price1 + price2) / 2 : Math.min(price1, price2)
  return Math.floor((Math.abs(price1 - price2) / denominator) * 100)
}

/**
 * Fetch last traded price for an instrument using Kite LTP API.
 * @param kite - Kite instance
 * @param underlying - trading symbol
 * @param exchange - exchange string
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
 * Calculate price skew between two instruments using their LTPs.
 */
export async function getSkew(kite, instrument1, instrument2, exchange) {
  const [price1, price2] = await Promise.all([
    getInstrumentPrice(kite, instrument1, exchange),
    getInstrumentPrice(kite, instrument2, exchange),
  ])

  const skew = getPercentageChange(price1, price2)
  return {
    [instrument1]: price1,
    [instrument2]: price2,
    skew,
  }
}

/**
 * Fetch completed order details from Kite order history by order id.
 * @returns the completed order or undefined
 */
export async function getCompletedOrderFromOrderHistoryById(kite, orderId) {
  const orders = await kite.getOrderHistory(orderId)
  return orders.find(odr => odr.status === "COMPLETE")
}

/**
 * Given a Kite orders response, return all completed orders or null if any incomplete.
 */
export async function getAllOrNoneCompletedOrdersByKiteResponse(kite, rawKiteOrdersResponse) {
  if (MOCK_ORDERS) {
    return [...new Array(rawKiteOrdersResponse.length)].fill(COMPLETED_ORDER_RESPONSE)
  }

  try {
    const completedOrders = (
      await Promise.all(
        rawKiteOrdersResponse.map(
          (
            { order_id } // eslint-disable-line
          ) => getCompletedOrderFromOrderHistoryById(kite, order_id)
        )
      )
    ).filter(o => o)

    if (completedOrders.length !== rawKiteOrdersResponse.length) {
      return null
    }

    return completedOrders
  } catch (e) {
    logger.error("getAllOrNoneCompletedOrdersByKiteResponse error", {
      e,
      rawKiteOrdersResponse,
    })
    return null
  }
}

/**
 * Log an object with an optional heading as pretty JSON.
 * @param heading - optional heading string
 * @param object - payload to log
 */
export const logObject = (heading, object) =>
  typeof heading === "string"
    ? logger.info(heading, JSON.stringify(object, null, 2))
    : logger.info(JSON.stringify(heading, null, 2))

/**
 * Return milliseconds left until market closing (or a hardcoded value for localhost).
 */
export const getTimeLeftInMarketClosingMs = () =>
  process.env.NEXT_PUBLIC_APP_URL?.includes("localhost:")
    ? ms(1 * 60 * 60) // if developing, hardcode one hour to market closing
    : dayjs(getMisOrderLastSquareOffTime()).diff(dayjs())

//Returns a boolean to check if current time is after square off time
/**
 * Check whether the current time is after the provided auto square-off time.
 * @param squareOffTime - ISO or parseable time string
 */
export const isTimeAfterAutoSquareOff = (squareOffTime: string) => {
  const finalOrderTime = getMisOrderLastSquareOffTime()
  const runAtTime = isMockOrder()
    ? squareOffTime
    : dayjs(squareOffTime).isAfter(dayjs(finalOrderTime))
      ? finalOrderTime
      : squareOffTime

  return dayjs().isAfter(runAtTime)
}

/**
 * Returns number of entry attempts to try based on strategy and time left in market.
 */
export const getEntryAttemptsCount = (_args: unknown) => {
  return null
}

/**
 * Map strategy to a backoff strategy name used by queues.
 */
export const getBackoffStrategy = (_args: unknown) => {
  return "fixed"
}

/**
 * Produce a custom backoff strategy function to be used with job retries.
 */
export const getCustomBackoffStrategies = () => {
  return (attemptsMade, type = "fixed", err, job) => {
    switch (type) {
      case "backOffToNearest5thMinute":
        return dayjs(getNextNthMinute(5 * 60 * 1000)).diff(dayjs())
      case "backOffToNearestMinute":
        return dayjs(getNextNthMinute(1 * 60 * 1000)).diff(dayjs())
      default: {
        const delay = job?.opts?.backoff?.delay
        return typeof delay === "number" ? delay : 0
      }
    }
  }
}

/**
 * Return queue retry/backoff options for a given exit strategy.
 * @param exitStrategy - enum from EXIT_STRATEGIES
 */
export const getQueueOptionsForExitStrategy = exitStrategy => {
  if (!exitStrategy) {
    throw new Error("getQueueOptionsForExitStrategy called without exitStrategy")
  }

  switch (exitStrategy) {
    case EXIT_STRATEGIES.MULTI_LEG_PREMIUM_THRESHOLD: {
      const recheckInterval = ms(3)
      return {
        attempts: Math.ceil(getTimeLeftInMarketClosingMs() / recheckInterval),
        backoff: {
          type: "fixed",
          delay: recheckInterval,
        },
      }
    }
    case EXIT_STRATEGIES.MIN_XPERCENT_OR_SUPERTREND: {
      const recheckInterval = ms(5 * 60)
      return {
        attempts: Math.ceil(getTimeLeftInMarketClosingMs() / recheckInterval),
        backoff: {
          type: "backOffToNearest5thMinute",
        },
      }
    }
    case EXIT_STRATEGIES.OBS_TRAIL_SL: {
      const recheckInterval = ms(1 * 60)
      return {
        attempts: Math.ceil(getTimeLeftInMarketClosingMs() / recheckInterval),
        backoff: {
          type: "backOffToNearestMinute",
        },
      }
    }
    default:
      return {
        attempts: 20,
        backoff: {
          type: "fixed",
          delay: ms(3),
        },
      }
  }
}

const marketHolidays = [
  ["September 20,2018", "Thursday"],
  ["October 02,2018", "Tuesday"],
  ["October 18,2018", "Thursday"],
  ["November 07,2018", "Wednesday"],
  ["November 08,2018", "Thursday"],
  ["November 23,2018", "Friday"],
  ["December 25,2018", "Tuesday"],
  ["March 04,2019", "Monday"],
  ["March 21,2019", "Thursday"],
  ["April 17,2019", "Wednesday"],
  ["April 19,2019", "Friday"],
  ["April 29,2019", "Monday"],
  ["May 01,2019", "Wednesday"],
  ["June 05,2019", "Wednesday"],
  ["August 12,2019", "Monday"],
  ["August 15,2019", "Thursday"],
  ["September 02,2019", "Monday"],
  ["September 10,2019", "Tuesday"],
  ["October 02,2019", "Wednesday"],
  ["October 08,2019", "Tuesday"],
  ["October 21,2019", "Monday"],
  ["October 28,2019", "Monday"],
  ["November 12,2019", "Tuesday"],
  ["December 25,2019", "Wednesday"],
  ["February 21, 2020", "Friday"],
  ["March 10,2020", "Tuesday"],
  ["April 02,2020", "Thursday"],
  ["April 06,2020", "Monday"],
  ["April 10,2020", "Friday"],
  ["April 14,2020", "Tuesday"],
  ["May 01,2020", "Friday"],
  ["May 25,2020", "Monday"],
  ["October 02,2020", "Friday"],
  ["November 16,2020", "Monday"],
  ["November 30,2020", "Monday"],
  ["December 25,2020", "Friday"],
  ["January 26,2021", "Tuesday"],
  ["March 11,2021", "Thursday"],
  ["March 29,2021", "Monday"],
  ["April 02,2021", "Friday"],
  ["April 14,2021", "Wednesday"],
  ["April 21,2021", "Wednesday"],
  ["May 13,2021", "Thursday"],
  ["July 21,2021", "Wednesday"],
  ["August 19,2021", "Thursday"],
  ["September 10,2021", "Friday"],
  ["October 15,2021", "Friday"],
  ["November 04,2021", "Thursday"],
  ["November 05,2021", "Friday"],
  ["November 19,2021", "Friday"],
  ["January 26,2022", "Wednesday"],
  ["March 01,2022", "Tuesday"],
  ["March 18,2022", "Friday"],
  ["April 14,2022", "Thursday"],
  ["April 15,2022", "Friday"],
  ["May 03,2022", "Tuesday"],
  ["August 09,2022", "Tuesday"],
  ["August 15,2022", "Monday"],
  ["August 31,2022", "Wednesday"],
  ["October 05,2022", "Wednesday"],
  ["October 24,2022", "Monday"],
  ["October 26,2022", "Wednesday"],
  ["November 08,2022", "Tuesday"],
]

/**
 * Check whether a date is a market holiday or weekend.
 */
export const isDateHoliday = (date: Dayjs) => {
  const isMarketHoliday = marketHolidays.find(
    holidays => holidays[0] === date.format("MMMM DD,YYYY")
  )
  if (isMarketHoliday) {
    return true
  }
  const day = date.format("dddd")
  const isWeeklyHoliday = day === "Saturday" || day === "Sunday"
  return isWeeklyHoliday
}

/**
 * Recursively find the last open market date since `from`.
 */
export const getLastOpenDateSince = (from: Dayjs) => {
  const fromDay = from.format("dddd")
  const yesterday = from.subtract(fromDay === "Monday" ? 3 : 1, "days")
  if (isDateHoliday(yesterday)) {
    return getLastOpenDateSince(yesterday)
  }

  return yesterday
}

/**
 * Check whether the provided access token matches the latest stored token in DB.
 */
export const checkHasSameAccessToken = async (accessToken: string) => {
  try {
    const dbAccessToken = await getLatestAccessToken()
    return dbAccessToken === accessToken
  } catch (e) {
    logger.error("🔴 [checkHasSameAccessToken] error", e)
    return false
  }
}

/**
 * Store an access token remotely (DB) and log result.
 */
export const storeAccessTokenRemotely = async (accessToken: string) => {
  try {
    await storeAccessToken(accessToken)
    logger.info("✅ [storeAccessTokenRemotely] success")
  } catch (e) {
    logger.error("🔴 [storeAccessTokenRemotely] error", e)
  }
}

/**
 * Return nearest candle time (rounded down) for a given interval.
 */
export const getNearestCandleTime = (intervalMs, referenceDate = new Date()) => {
  const nearestCandle = new Date(Math.floor(referenceDate.getTime() / intervalMs) * intervalMs)
  // https://kite.trade/forum/discussion/7798/historical-data-candles-inaccurate-for-small-periods
  return dayjs(nearestCandle).subtract(1, "second")
}

/**
 * Return the next timestamp rounded up to the nearest `intervalMs` boundary.
 */
export const getNextNthMinute = intervalMs => {
  // ref: https://stackoverflow.com/a/10789415/721084
  const date = new Date()
  const rounded = new Date(Math.ceil(date.getTime() / intervalMs) * intervalMs)
  return rounded
}

/**
 * Ensure user has sufficient margin for a basket order by checking Kite margins.
 * @returns boolean whether order can be placed
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

/**
 * Check whether market is currently open (based on hard-coded session times).
 */
export const isMarketOpen = (time = dayjs()) => {
  if (isDateHoliday(time)) {
    return false
  }

  const startTime = time.set("hour", 9).set("minute", 15).set("second", 0)
  const endTime = time.set("hour", 15).set("minute", 30).set("second", 0)

  return time.isAfter(startTime) && time.isBefore(endTime)
}

/**
 * Return a random integer between min and max inclusive.
 */
export function randomIntFromInterval(min: number, max: number) {
  // min and max included
  return Math.floor(Math.random() * (max - min + 1) + min)
}

interface LTP_TYPE {
  tradingsymbol: string
  strike: number
  last_price: number
}

/**
 * Find the item in `haystack` with a key closest to `needle`.
 */
export function closest(
  needle: number,
  haystack: Array<LTP_TYPE | any>,
  haystackKey: string,
  greaterThanEqualToPrice: boolean
) {
  const filtered = haystack.filter(item => {
    if (greaterThanEqualToPrice) {
      return item[haystackKey] >= needle
    }
    return item[haystackKey] >= needle || getPercentageChange(item[haystackKey], needle) <= 10
  })
  /**
   * the above ensures that we pick up a price lower than needle price,
   * only if it's at most 10% lesser than the needle price
   */
  return filtered.reduce((prev, curr) =>
    Math.abs(curr[haystackKey] - needle) < Math.abs(prev[haystackKey] - needle) ? curr : prev
  )
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

// `getMultipleInstrumentPrices` moved to `lib/kiteUtils.ts` and now uses the Kite SDK.

/**
 * Given a target option price and pivot, return the OTM strangle instruments.
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
    `[utils.getOTMStrangleByOptionPrice] nfoSymbol ${nfoSymbol}, price:${price}, pivotStrike:${pivotStrike}`
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

  const otmCEOptions = await getOTMOptions({
    nfoSymbol,
    strike: pivotStrike,
    instrumentType: "CE",
    expiry: expiryDate,
  })
  const otmPEOptions = await getOTMOptions({
    nfoSymbol,
    strike: pivotStrike,
    instrumentType: "PE",
    expiry: expiryDate,
  })

  const otmCEInstruments = otmCEOptions.map(row => ({
    exchange: kite.EXCHANGE_NFO,
    tradingSymbol: row.tradingsymbol,
  }))

  const otmPEInstruments = otmPEOptions.map(row => ({
    exchange: kite.EXCHANGE_NFO,
    tradingSymbol: row.tradingsymbol,
  }))

  //   await Promise.map(strikes, async strike => {
  //     const tradingSymbolInterface= (await getExpiryTradingSymbol({
  //       nfoSymbol,
  //       strike,
  //       instrumentType,
  //       expiry
  //     })) as TradingSymbolInterface
  //     const tradingsymbol=tradingSymbolInterface?.tradingsymbol
  //  logger.info(`[getTradingSymbolsByOptionPrice] Trading symbol is ${tradingsymbol}`)
  //     return {
  //       exchange: kite.EXCHANGE_NFO,
  //       tradingSymbol: tradingsymbol
  //     }
  //   })

  const otmCEPrices = await getMultipleInstrumentPrices(otmCEInstruments, user)

  const otmPEPrices = await getMultipleInstrumentPrices(otmPEInstruments, user)

  const getStrike = inst => {
    const withoutNfoSymbol = inst.replace(nfoSymbol, "")
    const withoutExpiryDetails = withoutNfoSymbol.substr(5, 5)
    return Number(withoutExpiryDetails)
  }

  const CEformattedPrices: LTP_TYPE[] = otmCEInstruments.map(({ tradingSymbol }) => {
    const { instrumentToken, lastPrice } = otmCEPrices[tradingSymbol]
    return {
      tradingsymbol: tradingSymbol,
      strike: getStrike(tradingSymbol),
      instrument_token: instrumentToken,
      last_price: lastPrice,
    }
  })

  const PEformattedPrices: LTP_TYPE[] = otmPEInstruments.map(({ tradingSymbol }) => {
    const { instrumentToken, lastPrice } = otmPEPrices[tradingSymbol]
    return {
      tradingsymbol: tradingSymbol,
      strike: getStrike(tradingSymbol),
      instrument_token: instrumentToken,
      last_price: lastPrice,
    }
  })

  const CEInstrument: Partial<Instrument> = closest(
    price,
    CEformattedPrices,
    "last_price",
    greaterThanEqualToPrice
  )
  const PEInstrument: Partial<Instrument> = closest(
    price,
    PEformattedPrices,
    "last_price",
    greaterThanEqualToPrice
  )
  return [CEInstrument, PEInstrument]
}

/**
 * Find trading symbols matching a target option price near a pivot strike.
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
  const totalStrikes = 61 // pivot and 30 on each side
  const { strikeStepSize } = INSTRUMENT_DETAILS[nfoSymbol!]
  const strikes = [...new Array(totalStrikes)]
    .map((_, idx) =>
      idx === 0 ? idx : idx < totalStrikes / 2 ? idx * -1 : idx - Math.floor(totalStrikes / 2)
    )
    .map(idx => pivotStrike + idx * strikeStepSize)
    .sort((a, b) => a - b)

  const instruments = await Promise.map(strikes, async strike => {
    const tradingSymbolInterface = (await getExpiryTradingSymbol({
      nfoSymbol,
      strike,
      instrumentType,
      expiry,
    })) as TradingSymbolInterface
    const tradingsymbol = tradingSymbolInterface?.tradingsymbol
    logger.info(`[getTradingSymbolsByOptionPrice] Trading symbol is ${tradingsymbol}`)
    return {
      exchange: kite.EXCHANGE_NFO,
      tradingSymbol: tradingsymbol,
    }
  })

  const priceDataByTradingSymbol = await getMultipleInstrumentPrices(instruments, user)

  const getStrike = inst => {
    const withoutNfoSymbol = inst.replace(nfoSymbol, "")
    const withoutExpiryDetails = withoutNfoSymbol.substr(5, 5)
    return Number(withoutExpiryDetails)
  }

  const formattedPrices: LTP_TYPE[] = instruments.map(({ tradingSymbol }) => {
    const { instrumentToken, lastPrice } = priceDataByTradingSymbol[tradingSymbol]
    return {
      tradingsymbol: tradingSymbol,
      strike: getStrike(tradingSymbol),
      instrument_token: instrumentToken,
      last_price: lastPrice,
    }
  })

  return closest(price, formattedPrices, "last_price", greaterThanEqualToPrice)
}

/**
 * Remove trailing forward slash from a URL.
 */
export function withoutFwdSlash(url: string): string {
  if (url.endsWith("/")) {
    return url.slice(0, url.length - 1)
  }
  return url
}

/**
 * Return whether MOCK_ORDERS is enabled via environment.
 */
export const isMockOrder = () => MOCK_ORDERS

/**
 * Return whether untested features are enabled via environment.
 */
export const isUntestedFeaturesEnabled = () =>
  process.env.ENABLE_UNTESTED_FEATURES ? JSON.parse(process.env.ENABLE_UNTESTED_FEATURES) : false

/**
 * Run a promise with a timeout and cancel it on timeout.
 */
export const finiteStateChecker = async (
  infinitePr: Bluebird<any>,
  checkDurationMs: number
): Promise<any | Error> => {
  return infinitePr.timeout(checkDurationMs).catch(e => {
    // cleanup infinitePr
    infinitePr.cancel()
    // and then rethrow for parent task
    throw e
  })
}

/**
 * Retry a remote function until successful, with timeout and retry logic.
 */
export const withRemoteRetry = async (remoteFn: any, timeoutMs = ms(60)): Promise<any> => {
  const remoteFnExecution = () =>
    new Promise((resolve, reject, onCancel) => {
      let cancelled = false
      const fn = async () => {
        if (cancelled) {
          return false
        }
        try {
          const isRemoteFnPromise = remoteFn && typeof (remoteFn as any).then == "function" // eslint-disable-line
          const res = await (isRemoteFnPromise ? remoteFn : remoteFn())
          return res
        } catch (e) {
          if (e?.isAxiosError) {
            if (e?.response?.status === 401) {
              return reject(new Error(ERROR_STRINGS.PAID_STRATEGY))
            }
          }

          if (e?.error_type === "TokenException" || e?.error_type === "PermissionException") {
            logger.error(`withRemoteRetry TokenException — api_key: ${KITE_API_KEY}`, e)
            return reject(e)
          }

          logger.error(`withRemoteRetry attempt failed for ${remoteFn}`, e)
          await Promise.delay(ms(2))
          return fn()
        }
      }

      fn()
        .then(res => {
          resolve(res)
        })
        .catch(e => reject(e))

      onCancel!(() => {
        cancelled = true
      })
    })

  const remoteFnExecutionPr = remoteFnExecution()
  const response = await finiteStateChecker(remoteFnExecutionPr, timeoutMs)
  return response
}

/**
 * Poll broker order history until a desired order state is observed or rejected.
 */
export const orderStateChecker = (kite, orderId, ensureOrderState) => {
  /**
   * if broker responds back with order history,
   * but is not in expected state (fn arg) and is also not in failure states (REJECTED or CANCELLED)
   * then keep retrying for it to enter either of those states
   */
  return new Promise((resolve, reject, onCancel) => {
    let cancelled = false
    const fn = async () => {
      if (cancelled) {
        return false
      }
      try {
        const orderHistory = await withRemoteRetry(() => kite.getOrderHistory(orderId))
        const byRecencyOrderHistory = orderHistory.reverse()
        // if it reaches here, then order exists in broker system

        const expectedStateOrder = byRecencyOrderHistory.find(
          odr => odr.status === ensureOrderState
        )

        if (expectedStateOrder) {
          return expectedStateOrder
        }

        logger.error("🔴 [orderStateChecker] invalid state...", {
          orderId,
          ensureOrderState,
        })
        logDeep(orderHistory)

        const wasOrderRejectedOrCancelled = byRecencyOrderHistory.find(
          odr => odr.status === kite.STATUS_REJECTED || odr.status === kite.STATUS_CANCELLED
        )

        if (wasOrderRejectedOrCancelled) {
          logger.error("🔴 [orderStateChecker] rejected or cancelled", byRecencyOrderHistory)
          throw new Error(kite.STATUS_REJECTED)
        }

        // in every other case, retry until its status changes to either of above states
        await Promise.delay(ms(2))
        return fn()
      } catch (e) {
        logger.error("🔴 [orderStateChecker] caught", e)
        if (
          e?.message === kite.STATUS_REJECTED ||
          (e?.status === "error" &&
            e?.error_type === "GeneralException" &&
            e?.message === "Couldn't find that `order_id`.")
        ) {
          throw new Error(kite.STATUS_REJECTED)
        }
        // for other exceptions like network layer, retry
        await Promise.delay(ms(2))
        return fn()
      }
    }

    fn()
      .then(resolve)
      .catch(e => {
        logger.error("🔴 [orderStateChecker] checker error", e)
        if (e?.message === kite.STATUS_REJECTED) {
          reject(e)
        }
      })

    onCancel!(() => {
      cancelled = true
    })
  })
}

/**
 *
 * @returns
 * throws `Promise.Timedout`
 * which means it tried for X number of times
 * and still couldn't place it determinstically (doesn't exist will broker as well - confirmed!)
 *
 *
 * or resolves with
 * { successful: true, response: orderHistoryStateObject } or
 * { successful: false, response?: orderAckResponse }
 * which means order was placed, but its status couldn't be determined within `orderStatusCheckTimeout`
 * receiving `false` is a tricky situation to be in - and it shouldn't happen in an ideal world
 */
/**
 * Place an order and ensure it reaches an ultimate state (or retry/handle failures).
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
    throw Promise.TimeoutError
  }

  if (attemptCount > 0) {
    await Promise.delay(onFailureRetryAfterMs)
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
    // if more than freeze quantity, split quantity into freezeQty orders
    const ordersCount = Math.ceil(orderProps.quantity! / freezeQty)
    const freezeQtyOrders = [...new Array(ordersCount).fill(null)].map((_, idx) => {
      if (idx === ordersCount - 1) {
        // last order with qty <= freezeQty
        return {
          ...orderProps,
          quantity: orderProps.quantity! - idx * freezeQty,
        }
      }
      return {
        ...orderProps,
        quantity: freezeQty,
      }
    })

    const orderResults: any = await allSettled(
      freezeQtyOrders.map(order =>
        remoteOrderSuccessEnsurer({
          ...args,
          orderProps: order,
        })
      )
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
      : await kitePlaceOrder(kite, kite.VARIETY_REGULAR, orderProps as PlaceOrderParams)
    const { order_id: ackOrderId } = orderAckResponse
    const isOrderInUltimateStatePr = orderStateChecker(kite, ackOrderId, ensureOrderState)
    try {
      const ultimateStateOrder = await finiteStateChecker(
        isOrderInUltimateStatePr,
        orderStatusCheckTimeout
      )
      return {
        successful: true,
        response: [ultimateStateOrder],
      }
    } catch (e) {
      // should only reach here if it had a rejected status or finiteStateChecker timedout
      logger.error("🔴 [remoteOrderSuccessEnsurer] caught", e)
      if (e instanceof Promise.TimeoutError) {
        return {
          successful: false,
          response: [orderAckResponse],
        }
      }
      if (e?.message === kite.STATUS_REJECTED) {
        logger.info("🟢 [remoteOrderSuccessEnsurer] retrying rejected order", orderProps)
        return remoteOrderSuccessEnsurer({
          ...args,
          attemptCount: attemptCount + 1,
        })
      }
      throw e
    }
  } catch (e) {
    // will reach here if kite.placeOrder fails with some error
    logger.error("🔴 [remoteOrderSuccessEnsurer] placeOrder failed?", e)

    // Non-retryable errors should be thrown immediately
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
      // we cannot simply retry - don't know where the request failed inflight
      // check at the broker's end - if the order exists with that tag or not

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
          // orders api responded successfully and we didn't find a matching order
          // so reattempt the order
          return remoteOrderSuccessEnsurer({
            ...args,
            attemptCount: attemptCount + 1,
          })
        }

        // order found
        // ensure that it's in the expected state
        const isMatchedOrderInUltimateStatePr = orderStateChecker(
          kite,
          matchedOrder.order_id,
          ensureOrderState
        )
        try {
          const ultimateStateOrder = await finiteStateChecker(
            isMatchedOrderInUltimateStatePr,
            orderStatusCheckTimeout
          )
          return {
            successful: true,
            response: [ultimateStateOrder],
          }
        } catch (e) {
          if (e?.message === kite.STATUS_REJECTED) {
            return remoteOrderSuccessEnsurer({
              ...args,
              attemptCount: attemptCount + 1,
            })
          }
          throw e
        }
      } catch (e) {
        // case - tried getting orders for 1 min, but no response from broker
        logger.error("🔴 [remoteOrderSuccessEnsurer] caught with no response from broker", e)
        return { successful: false }
      }
    }

    logger.error("🔴 [remoteOrderSuccessEnsurer] unhandled parent caught", e)
    return { successful: false }
  }
}

// gets the current data from DB
/**
 * Fetch job execution values from DB by id.
 */
export const getValuesfromDB = async (id: string): Promise<Record<string, unknown> | null> => {
  const rows = await db.select().from(jobExecutions).where(eq(jobExecutions.id, id))
  return rows[0] ?? null
}

/**
 * Patch a DB trade row using drizzle-backed helper.
 */
export const patchDbTrade = async ({
  id,
  patchProps,
}: {
  id: string
  patchProps: Parameters<typeof patchDbTradeFromDb>[1]
}): Promise<Record<string, unknown>> => {
  return patchDbTradeFromDb(id, patchProps)
}

/*
Points: sell - buy
Quantity: Sell is positive, buy is negative similar to kite positions
DEPRECATED: Use kiteUtils.getCompletedOrdersbyTag instead - moved to kiteUtils.ts
*/
/**
 * Alias for kiteUtils.getCompletedOrdersbyTag.
 */
export const getCompletedOrdersbyTag = getCompletedOrdersbyTagFromKite

/**
 * Attempt multiple broker orders in parallel and return aggregated success state.
 */
export const attemptBrokerOrders = async (
  ordersPr: Array<Promise<any>>
): Promise<{
  allOk: boolean
  statefulOrders: KiteOrder[]
}> => {
  try {
    const brokerOrderResolutions = await allSettled(ordersPr)
    logDeep(brokerOrderResolutions)
    const rejectedLegs = (brokerOrderResolutions as any).filter(
      (res: allSettledInterface) => res.status === "rejected"
    )
    const successfulOrders: Array<KiteOrder | null> = (brokerOrderResolutions as any)
      .map((res: allSettledInterface) =>
        res.status === "fulfilled" && res.value.successful ? res.value.response : null
      )
      .filter(o => o)
      .reduce((flattenedOrders, ordersArr) => [...flattenedOrders, ...ordersArr], [])

    if (rejectedLegs.length > 0) {
      return {
        allOk: false,
        statefulOrders: successfulOrders as KiteOrder[],
      }
    }

    return {
      allOk: true,
      statefulOrders: successfulOrders as KiteOrder[],
    }
  } catch (e) {
    logger.error("🔴 [attemptBrokerOrders] error", e)
    return {
      allOk: false,
      statefulOrders: [],
    }
  }
}

/**
 * Get the tradingsymbol used to hedge a given strike with distance and type.
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

export interface apiResponseObject {
  PutDelta: number
  CallDelta: number
  StrikePrice: number
}

/**
 * Map option deltas to strike objects from API response, optionally filtering by type.
 */
export const getStrikeByDelta = (
  delta: number,
  apiResponse: {
    atmStrike: number
    data: apiResponseObject[]
  },
  type?: "PE" | "CE"
):
  | apiResponseObject
  | {
      putStrike: apiResponseObject
      callStrike: apiResponseObject
    } => {
  const { data } = apiResponse
  const putStrike = closest(delta, data, "PutDelta", false)
  const callStrike = closest(delta, data, "CallDelta", false)
  if (type === "PE") {
    return putStrike
  }

  if (type === "CE") {
    return callStrike
  }

  return {
    putStrike,
    callStrike,
  }
}

/**
 * Round `value` to the nearest `step` increment.
 */
export function round(value: number, step = 0.5): number {
  const inv = 1.0 / step
  return Math.round(value * inv) / inv
}

export { getIndexInstruments }
