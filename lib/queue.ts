import { Job, JobsOptions, Queue, QueueScheduler } from 'bullmq';
import dayjs from 'dayjs';
import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

import console from './logging';
import {
  getBackoffStrategy,
  getEntryAttemptsCount,
  getMisOrderLastSquareOffTime,
  getQueueOptionsForExitStrategy,
  getTimeLeftInMarketClosingMs,
  isMockOrder,
  ms
} from './utils';

const redisUrl = `${process.env.REDIS_URL as string}`

// just a hack to ensure if someone left a placeholder in env variables
export const QID:string = process.env.KITE_API_KEY!
export const TRADING_Q_NAME = `tradingQueue_${QID}`
export const EXIT_TRADING_Q_NAME = `exitTradingQueue_${QID}`
export const AUTO_SQUARE_OFF_Q_NAME = `autoSquareOffQueue_${QID}`
//export const WATCHER_Q_NAME = `watcherQueue_${QID}`
export const ANCILLARY_Q_NAME = `ancillaryQueue_${QID}`
export const TARGETPNL_Q_NAME = `targetPnlQueue_${QID}`
export const redisConnection = new IORedis(redisUrl,{maxRetriesPerRequest: null});
const queueOptions = {
  connection: redisConnection
}
const schedulerQueueOptions = {
  ...queueOptions,
  // prevent jobs from being double processed even if they're stalled
  maxStalledCount: 0
}

export const tradingQueueScheduler = new QueueScheduler(
  TRADING_Q_NAME,
  schedulerQueueOptions
)
export const tradingQueue = new Queue(TRADING_Q_NAME, queueOptions)

export const targetPnLQueueScheduler = new QueueScheduler(
  TARGETPNL_Q_NAME,
  schedulerQueueOptions
)
export const targetPnLQueue = new Queue(TARGETPNL_Q_NAME, queueOptions)
export const exitTradesQueueScheduler = new QueueScheduler(
  EXIT_TRADING_Q_NAME,
  schedulerQueueOptions
)
export const exitTradesQueue = new Queue(EXIT_TRADING_Q_NAME, queueOptions)
export const autoSquareOffQueueScheduler = new QueueScheduler(
  AUTO_SQUARE_OFF_Q_NAME,
  schedulerQueueOptions
)
export const autoSquareOffQueue = new Queue(
  AUTO_SQUARE_OFF_Q_NAME,
  queueOptions
)
// export const watcherQueueScheduler = new QueueScheduler(
//   WATCHER_Q_NAME,
//   schedulerQueueOptions
// )
// export const watcherQueue = new Queue(WATCHER_Q_NAME, queueOptions)
export const ancillaryQueueScheduler = new QueueScheduler(
  ANCILLARY_Q_NAME,
  schedulerQueueOptions
)
export const ancillaryQueue = new Queue(ANCILLARY_Q_NAME, queueOptions)

const allQueues = [
  tradingQueue, // Orders are punched here
  exitTradesQueue, // Stop loss orders or combined SL orders are punched
  autoSquareOffQueue, // Square off is punched in this queue
 // watcherQueue, // Converts SLL to market order if not filled
  ancillaryQueue, //Orderbook sync to DB is done here
  targetPnLQueue //For target loss or profit
]

export async function addToNextQueue (
  jobData,
  jobResponse
): Promise<Job | undefined> {
  try {
    switch (jobResponse._nextTradingQueue) {
      case ANCILLARY_Q_NAME: {
        const marketClosing = dayjs()
          .set('hours', 15)
          .set('minutes', 30)
          .set('seconds', 0)
        return ancillaryQueue.add(
          `${ANCILLARY_Q_NAME}_${uuidv4() as string}`,
          {
            initialJobData: jobData,
            jobResponse
          },
          {
            delay: marketClosing.diff(dayjs())
          }
        )
      }

      // case WATCHER_Q_NAME: {
      //   // console.log('Adding job to watcher queue', jobData, jobResponse)
      //   return watcherQueue.add(
      //     `${WATCHER_Q_NAME}_${uuidv4() as string}`,
      //     {
      //       initialJobData: jobData,
      //       jobResponse
      //     },
      //     {
      //       attempts: Math.ceil(getTimeLeftInMarketClosingMs() / ms(5)),
      //       backoff: {
      //         type: 'fixed',
      //         delay: ms(5)
      //       }
      //     }
      //   )
      // }

      case EXIT_TRADING_Q_NAME: {
        // console.log('Adding job to exit trade queue', jobData)
        const queueOptions = getQueueOptionsForExitStrategy(
          jobData.exitStrategy
        )
        return exitTradesQueue.add(
          `${EXIT_TRADING_Q_NAME}_${uuidv4() as string}`,
          {
            initialJobData: jobData,
            jobResponse
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
            type: getBackoffStrategy({ strategy })
          }
        }

        if (!runNow) {
          const delay = dayjs(runAt).diff(dayjs())
          // console.log(`queueOptions.delay == ${Math.ceil(delay / 60000)} mins`)
          queueOptions.delay = delay
        }

        return tradingQueue.add(
          `${TRADING_Q_NAME}_${uuidv4() as string}`,
          jobData,
          queueOptions
        )
      }
      case TARGETPNL_Q_NAME: {  
        console.log(`[queue] added to ${TARGETPNL_Q_NAME}`)
        return targetPnLQueue.add(
          `${TARGETPNL_Q_NAME}_${uuidv4() as string}`, //Job name
          {
            initialJobData: jobData,
            jobResponse
          },
          {
            attempts: Math.ceil(getTimeLeftInMarketClosingMs() / ms(3)),
            backoff: {
              type: 'fixed',
              delay: ms(4)
            }
          }
        )
          }

      default: {
        break
      }
    }
  } catch (e) {
    console.log('addToNextQueue error')
    console.log(e)
  }
}

export async function addToAutoSquareOffQueue ({
  initialJobData,
  jobResponse
}) {
  const {
    autoSquareOffProps: { time, deletePendingOrders }
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
      initialJobData
    },
    {
      delay
    }
  )
}

export async function addToCoSquareOff(user)
{
  const marketClosingforEquity = dayjs()
  .set('hours', 15)
  .set('minutes', 10)
  .set('seconds', 0)
  return autoSquareOffQueue.add(
    `${AUTO_SQUARE_OFF_Q_NAME}_${uuidv4() as string}`,
    {
     user
    },
    {
      delay: marketClosingforEquity.diff(dayjs())
    }
  )

}
export async function addToAncillaryQueue (user) {
  const marketClosing = dayjs()
  .set('hours', 15)
  .set('minutes', 30)
  .set('seconds', 0)
  const numberofJobs=await ancillaryQueue.count();
  if (numberofJobs==0)
  {
    return ancillaryQueue.add(
    `${ANCILLARY_Q_NAME}_${uuidv4() as string}`,
  user,
    {
    delay: marketClosing.diff(dayjs())
    })
  }
  else
  {
  console.log('Not added to Ancllary');
  return Promise.resolve("Not added to queue");
  }
}

export const cleanupQueues = async () =>
  await Promise.all(allQueues.map(async queue => await queue.obliterate({force:true})))
