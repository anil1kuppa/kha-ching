import { Worker } from "bullmq"
import type { KiteOrder } from "../../types/kite"
import type { ATM_STRADDLE_TRADE, ATM_STRANGLE_TRADE, SUPPORTED_TRADE_CONFIG } from "../../types/trade"

type StraddleOrStrangleTrade = ATM_STRADDLE_TRADE | ATM_STRANGLE_TRADE

import { EXIT_STRATEGIES } from "../constants"
import individualLegExitOrders from "../exit-strategies/individualLegExitOrders"
import logger from "../logger"
import { EXIT_TRADING_Q_NAME, redisConnection } from "../queue"
import { getCustomBackoffStrategies, ms } from "../utils"

function processJob(jobData: {
  initialJobData: SUPPORTED_TRADE_CONFIG
  jobResponse: {
    rawKiteOrdersResponse: KiteOrder[]
    squareOffOrders?: KiteOrder[]
  }
}) {
  const { initialJobData, jobResponse } = jobData

  const { exitStrategy } = initialJobData as StraddleOrStrangleTrade
  switch (exitStrategy) {
    case EXIT_STRATEGIES.INDIVIDUAL_LEG_SLM_1X: {
      return individualLegExitOrders({
        initialJobData,
        ...jobResponse,
      })
    }
    default: {
      return null
    }
  }
}

const worker = new Worker(
  EXIT_TRADING_Q_NAME,
  async job => {
    try {
      const exitOrders = await processJob(job.data)
      return exitOrders
    } catch (e) {
      logger.info(e.message ? e.message : e)
      throw new Error(e)
    }
  },
  {
    connection: redisConnection,
    concurrency: 100,
    settings: {
      backoffStrategy: getCustomBackoffStrategies(),
    },
    lockDuration: ms(5 * 60),
  }
)

worker.on("error", err => {
  // log the error
  logger.error("🔴 [exitTradingQueue] worker error", err)
})

// worker.on('completed', (job) => {
//   // const { id, name } = job
//   // console.log('// job has completed', { id, name })
// })

// worker.on('failed', (job) => {
//   try {
//     const { id, name, data, attemptsMade, returnvalue } = job;
//     const { initialJobData, jobResponse } = data;
//     console.log('// job failed/retried', {
//       id,
//       name,
//       initialJobData,
//       jobResponse,
//       returnvalue,
//       attemptsMade
//     });
//   } catch (e) {
//     //
//   }
// });
