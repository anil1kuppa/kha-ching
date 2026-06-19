import { Worker } from "bullmq"
import dayjs from "dayjs"

import autoSquareOffStrat, { cancelCoOrders } from "../exit-strategies/autoSquareOff"
import logger from "../logger"
import { AUTO_SQUARE_OFF_Q_NAME, redisConnection } from "../queue"
import { ms } from "../utils"

const worker = new Worker(
  AUTO_SQUARE_OFF_Q_NAME,
  async job => {
    const scheduledAt = dayjs(job.timestamp + (job.opts.delay ?? 0))
    if (!scheduledAt.isSame(dayjs(), "day")) {
      logger.info(
        `[squareOffQueue] Discarding stale job ${job.id} scheduled for ${scheduledAt.toISOString()}`
      )
      return
    }
    logger.info(`processing auto square off id ${job.id}`, job.data)
    if (job.data.rawKiteOrdersResponse) return autoSquareOffStrat(job.data)
    else return cancelCoOrders(job.data.user)
  },
  {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: ms(5 * 60),
  }
)

worker.on("failed", job => {
  const { name, data, failedReason, returnvalue, id } = job
  logger.error("auto square off failed", {
    name,
    data,
    failedReason,
    returnvalue,
    id,
  })
})

worker.on("error", err => {
  // log the error
  logger.error("🔴 [squareOffQueue] worker error", err)
})
