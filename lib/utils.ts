import axios from "axios"
import dayjs, { type Dayjs } from "dayjs"
import type { KiteOrder } from "../types/kite"
import {
  ERROR_STRINGS,
  EXIT_STRATEGIES,
  TRADES,
} from "./constants"
import { getLatestAccessToken, storeAccessToken } from "./drizzleDbUtils"
import { allSettled, type allSettledInterface } from "./es6-promise"
import logger from "./logger"
import { COMPLETED_ORDER_RESPONSE } from "./strategies/mockData/orderResponse"

import isSameOrBefore from "dayjs/plugin/isSameOrBefore"
import timezone from "dayjs/plugin/timezone"
import utc from "dayjs/plugin/utc"

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(isSameOrBefore)

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

/** Seconds until next 7 AM IST. Used for session TTL. */
export const secondsTill7 = (): number => {
  const nowIst = toIst(new Date())
  const next7AmIst =
    nowIst.hour() >= 7
      ? nowIst.add(1, "day").startOf("day").hour(7)
      : nowIst.startOf("day").hour(7)
  return next7AmIst.diff(nowIst, "second")
}

/** Milliseconds until 7 AM IST (next occurrence). Used for memoizer maxAge. */
export const millisecondsTill7 = (): number => secondsTill7() * 1000

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
export const delay = (ms: number): Promise<void> =>
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
 * Signal that a `finiteStateChecker`/`withRemoteRetry` operation exceeded its time budget.
 */
export class RemoteRetryTimeoutError extends Error {}

/**
 * Run a promise with a timeout, invoking `onTimeout` (e.g. to cancel a poller) if it fires.
 */
export const finiteStateChecker = async <T>(
  pr: globalThis.Promise<T>,
  checkDurationMs: number,
  onTimeout?: () => void
): globalThis.Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout>
  const timeoutPromise = new globalThis.Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      onTimeout?.()
      reject(new RemoteRetryTimeoutError(`finiteStateChecker timed out after ${checkDurationMs}ms`))
    }, checkDurationMs)
  })

  try {
    return await globalThis.Promise.race([pr, timeoutPromise])
  } finally {
    clearTimeout(timeoutHandle!)
  }
}

/**
 * Retry a remote function until successful, with timeout and retry logic.
 */
export const withRemoteRetry = async (remoteFn: any, timeoutMs = ms(60)): Promise<any> => {
  let cancelled = false

  const attempt = async (): Promise<any> => {
    if (cancelled) {
      return
    }
    try {
      const isRemoteFnPromise = remoteFn && typeof (remoteFn as any).then == "function" // eslint-disable-line
      return await (isRemoteFnPromise ? remoteFn : remoteFn())
    } catch (e) {
      if (e?.isAxiosError && e?.response?.status === 401) {
        throw new Error(ERROR_STRINGS.PAID_STRATEGY)
      }

      if (e?.error_type === "TokenException" || e?.error_type === "PermissionException") {
        logger.error(`withRemoteRetry TokenException — api_key: ${KITE_API_KEY}`, e)
        throw e
      }

      logger.error(`withRemoteRetry attempt failed for ${remoteFn}`, e)
      if (cancelled) {
        throw e
      }
      await delay(ms(2))
      return attempt()
    }
  }

  let timeoutHandle: ReturnType<typeof setTimeout>
  const timeoutPromise = new globalThis.Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      cancelled = true
      reject(new RemoteRetryTimeoutError(`withRemoteRetry timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await globalThis.Promise.race([attempt(), timeoutPromise])
  } finally {
    clearTimeout(timeoutHandle!)
  }
}

/**
 * Poll broker order history until a desired order state is observed or rejected.
 * Returns `{ promise, cancel }` — pass `cancel` to `finiteStateChecker`'s `onTimeout`
 * so polling actually stops once the caller gives up waiting.
 */
export const orderStateChecker = (
  kite,
  orderId,
  ensureOrderState
): { promise: globalThis.Promise<any>; cancel: () => void } => {
  let cancelled = false

  /**
   * if broker responds back with order history,
   * but is not in expected state (fn arg) and is also not in failure states (REJECTED or CANCELLED)
   * then keep retrying for it to enter either of those states
   */
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
      if (cancelled) {
        return false
      }
      await delay(ms(2))
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
      if (cancelled) {
        throw e
      }
      await delay(ms(2))
      return fn()
    }
  }

  const promise = new globalThis.Promise((resolve, reject) => {
    fn()
      .then(resolve)
      .catch(e => {
        logger.error("🔴 [orderStateChecker] checker error", e)
        if (e?.message === kite.STATUS_REJECTED) {
          reject(e)
        }
      })
  })

  return {
    promise,
    cancel: () => {
      cancelled = true
    },
  }
}

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

