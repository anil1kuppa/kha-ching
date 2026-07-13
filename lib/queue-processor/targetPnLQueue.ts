import { Worker } from "bullmq"

import logger from "../logger"
import { redisConnection, TARGETPNL_Q_NAME } from "../queue"
import targetPnL from "../targetPnL"
import { ms } from "../utils"

async function processJob(jobData) {
  const {
    initialJobData,
    jobResponse: { rawKiteOrdersResponse },
  } = jobData
  //const { orders } = jobResponse
  return targetPnL({
    initialJobData,
    rawKiteOrdersResponse,
  })
}

const worker = new Worker(
  TARGETPNL_Q_NAME,
  async job => {
    try {
      //console.log(`processing trargetPnlQueu id ${job.id}`)
      const result = await processJob(job.data)
      return result
    } catch (e) {
      throw new Error(e)
    }
  },
  {
    connection: redisConnection,
    concurrency: 30,
    lockDuration: ms(5 * 60),
  }
)

worker.on("error", err => {
  // log the error
  logger.error("🔴 [targetPnLQueue] worker error", err)
})
