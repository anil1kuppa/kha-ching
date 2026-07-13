import { type Job, type JobsOptions, Queue } from "bullmq"
import dayjs from "dayjs"
import IORedis from "ioredis"
import { v4 as uuidv4 } from "uuid"

import logger from "./logger"
import {
  getBackoffStrategy,
  getEntryAttemptsCount,
  getMisOrderLastSquareOffTime,
  getQueueOptionsForExitStrategy,
  getTimeLeftInMarketClosingMs,
  isMockOrder,
  ms,
} from "./utils"

export type QueuePayload<Data = any, Response = any> = {
  initialJobData: Data
  jobResponse: Response & { _nextTradingQueue?: string }
}

const redisUrl = `${process.env.REDIS_URL as string}`

// just a hack to ensure if someone left a placeholder in env variables
export const QID: string = process.env.KITE_API_KEY!
export const TRADING_Q_NAME = `tradingQueue_${QID}`
export const EXIT_TRADING_Q_NAME = `exitTradingQueue_${QID}`
export const AUTO_SQUARE_OFF_Q_NAME = `autoSquareOffQueue_${QID}`
export const ANCILLARY_Q_NAME = `ancillaryQueue_${QID}`
export const TARGETPNL_Q_NAME = `targetPnlQueue_${QID}`
export const CHASE_Q_NAME = `chaseQueue_${QID}`
export const redisConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null })
const queueOptions = {
  connection: redisConnection,
}

export const tradingQueue = new Queue(TRADING_Q_NAME, queueOptions)
export const targetPnLQueue = new Queue(TARGETPNL_Q_NAME, queueOptions)
export const exitTradesQueue = new Queue(EXIT_TRADING_Q_NAME, queueOptions)
export const autoSquareOffQueue = new Queue(AUTO_SQUARE_OFF_Q_NAME, queueOptions)
export const ancillaryQueue = new Queue(ANCILLARY_Q_NAME, queueOptions)
export const chaseQueue = new Queue(CHASE_Q_NAME, queueOptions)

const allQueues = [
  tradingQueue, // Orders are punched here
  exitTradesQueue, // Stop loss orders or combined SL orders are punched
  autoSquareOffQueue, // Square off is punched in this queue
  ancillaryQueue, //Orderbook sync to DB is done here
  targetPnLQueue, //For target loss or profit
  chaseQueue, //For chase orders
]

export async function addToNextQueue(jobData, jobResponse): Promise<Job | undefined> {
  try {
    switch (jobResponse._nextTradingQueue) {
      case ANCILLARY_Q_NAME: {
        const marketClosing = dayjs().set("hours", 15).set("minutes", 30).set("seconds", 0)
        return ancillaryQueue.add(
          `${ANCILLARY_Q_NAME}_${uuidv4() as string}`,
          {
            initialJobData: jobData,
            jobResponse,
          },
          {
            delay: marketClosing.diff(dayjs()),
          }
        )
      }

      case EXIT_TRADING_Q_NAME: {
        // console.log('Adding job to exit trade queue', jobData)
        const queueOptions = getQueueOptionsForExitStrategy(jobData.exitStrategy)
        return exitTradesQueue.add(
          `${EXIT_TRADING_Q_NAME}_${uuidv4() as string}`,
          {
            initialJobData: jobData,
            jobResponse,
          },
          queueOptions
        )
      }
      case TRADING_Q_NAME: {
        const queueOptions: JobsOptions = {}
        const { strategy, runNow, runAt } = jobData
        const maxEntryAttempts = getEntryAttemptsCount({ strategy })
        if (maxEntryAttempts) {
          queueOptions.attempts = maxEntryAttempts
          queueOptions.backoff = {
            type: getBackoffStrategy({ strategy }),
          }
        }

        if (!runNow) {
          const delay = dayjs(runAt).diff(dayjs())
          // console.log(`queueOptions.delay == ${Math.ceil(delay / 60000)} mins`)
          queueOptions.delay = delay
        }

        return tradingQueue.add(`${TRADING_Q_NAME}_${uuidv4() as string}`, jobData, queueOptions)
      }
      case TARGETPNL_Q_NAME: {
        logger.info(`[queue] added to ${TARGETPNL_Q_NAME}`)
        return targetPnLQueue.add(
          `${TARGETPNL_Q_NAME}_${uuidv4() as string}`, //Job name
          {
            initialJobData: jobData,
            jobResponse,
          },
          {
            attempts: Math.ceil(getTimeLeftInMarketClosingMs() / ms(3)),
            backoff: {
              type: "fixed",
              delay: ms(4),
            },
          }
        )
      }

      default: {
        break
      }
    }
  } catch (e) {
    logger.error("addToNextQueue error")
    logger.info(e)
  }
}

export async function addToAutoSquareOffQueue({ initialJobData, jobResponse }) {
  const {
    autoSquareOffProps: { time, deletePendingOrders },
  } = initialJobData
  const { rawKiteOrdersResponse, squareOffOrders } = jobResponse
  const finalOrderTime = getMisOrderLastSquareOffTime()
  const runAtTime = isMockOrder()
    ? time
    : dayjs(time).isAfter(dayjs(finalOrderTime))
      ? finalOrderTime
      : time

  const delay = dayjs(runAtTime).diff(dayjs())
  // console.log(`>>> auto square off scheduled for ${Math.ceil(delay / 60000)} minutes from now`)
  return autoSquareOffQueue.add(
    `${AUTO_SQUARE_OFF_Q_NAME}_${uuidv4() as string}`,
    {
      rawKiteOrdersResponse: squareOffOrders || rawKiteOrdersResponse,
      deletePendingOrders,
      initialJobData,
    },
    {
      delay,
    }
  )
}

export async function addToCoSquareOff(user) {
  const marketClosingforEquity = dayjs().set("hours", 15).set("minutes", 10).set("seconds", 0)
  return autoSquareOffQueue.add(
    `${AUTO_SQUARE_OFF_Q_NAME}_${uuidv4() as string}`,
    {
      user,
    },
    {
      delay: marketClosingforEquity.diff(dayjs()),
    }
  )
}
export async function addToAncillaryQueue(user) {
  const today = dayjs().format("YYYY-MM-DD")
  const marketClosing = dayjs().set("hours", 15).set("minutes", 30).set("seconds", 0)

  return ancillaryQueue.add(`${ANCILLARY_Q_NAME}_${today}`, user, {
    delay: marketClosing.diff(dayjs()),
    jobId: `ancillary-${today}`,
  })
}

export const cleanupQueues = async () =>
  await Promise.all(allQueues.map(async queue => await queue.obliterate({ force: true })))

export async function addToChaseQueue(user: any) {
  try {
    const today = dayjs().format("YYYY-MM-DD") // just the date part

    const startDate = new Date(`${today}T10:14:00+05:30`)
    const endDate = new Date(`${today}T16:15:00+05:30`)

    // cron: every hour at :15, 10:15–16:15 IST
    await chaseQueue.add(
      "calculateEMA",
      { user },
      {
        repeat: {
          pattern: "15 10-16 * * *",
          startDate: startDate,
          endDate: endDate,
          tz: "Asia/Kolkata",
        },
      }
    )

    const updateSLStart = new Date(`${today}T09:15:59+05:30`)
    const updateSLEnd = new Date(`${today}T15:30:00+05:30`)

    // cron: every minute, 09:16–15:30 IST
    await chaseQueue.add(
      "updateSL",
      { user },
      {
          repeat: {
          pattern: "0 * 9-15 * * *",
          startDate: updateSLStart,
          endDate: updateSLEnd,
          tz: "Asia/Kolkata",
        },
      }
    )

    return true
  } catch (e) {
    logger.error("[queue] addToChaseQueue error", e)
  }
}

// alias with requested name
export async function addtoChaseQueue(user: any) {
  return addToChaseQueue(user)
}
