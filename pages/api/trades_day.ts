import dayjs from "dayjs"
import { pick } from "lodash"
import { customAlphabet } from "nanoid"

import { tradingQueue, addToNextQueue, addToChaseQueue, TRADING_Q_NAME } from "../../lib/queue"
import { db } from "../../lib/drizzle"
import { desc, eq, sql } from "drizzle-orm"
import { jobExecutions } from "../../lib/schema"

import { JOB_EXECUTION_STATUS } from "../../lib/constants"
import logger from "../../lib/logger"

import withSession from "../../lib/session"
import { isMarketOpen, isMockOrder } from "../../lib/utils"
import { SUPPORTED_TRADE_CONFIG } from "../../types/trade"
import { SignalXUser } from "../../types/misc"

const TIMESTAMP_FIELDS = [
  "runAt",
  "squareOffTime",
  "expiresAt",
  "autoSquareOffTime",
  "lastTargetAt",
  "lastModified",
]

const normalizeTimestampFields = (payload: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(payload).map(([key, value]) => {
      if (TIMESTAMP_FIELDS.includes(key) && typeof value === "string") {
        const parsed = new Date(value)
        if (isNaN(parsed.getTime())) throw new Error(`Invalid date for ${key}: ${value}`)
        return [key, parsed]
      }
      return [key, value]
    })
  )

const nanoid = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 8)

async function createJob({
  jobData,
  user,
}: {
  jobData: SUPPORTED_TRADE_CONFIG
  user: SignalXUser
}) {
  const { runAt, runNow, strategy } = jobData

  // if (!isMockOrder() && runNow && !isMarketOpen()) {
  //   return Promise.reject(new Error('Exchange is offline right now.'))
  // }

  if (!isMockOrder() && !runNow && runAt && !isMarketOpen(dayjs(runAt))) {
    return Promise.reject(new Error("Exchange would be offline at the scheduled time."))
  }

  return addToNextQueue(
    {
      ...jobData,
      user,
    },
    {
      _nextTradingQueue: TRADING_Q_NAME,
    }
  )
}

async function deleteJob(id) {
  try {
    if (id.includes("repeat")) {
      await tradingQueue.removeRepeatableByKey(id)
    } else {
      const job = await tradingQueue.getJob(id)
      job && (await job.remove())
    }
  } catch (e) {
    logger.error("[deleteJob] failed", e)
    return Promise.reject(e)
  }
}

export default withSession(async (req, res) => {
  const user = req.session.get("user")

  if (!user) {
    return res.status(401).end()
  }

  if (req.method === "POST") {
    let executionData: any
    const orderTag = nanoid()
    try {
      logger.info(`[trades_day] POST body ${JSON.stringify(req.body)}`)
      const inserted = await db
        .insert(jobExecutions)
        .values(
          normalizeTimestampFields({
            ...req.body,
            orderTag,
            status: JOB_EXECUTION_STATUS.PENDING,
            createdAt: new Date(),
          })
        )
        .returning()

      if (inserted.length === 0) {
        throw new Error("Failed to insert job execution")
      }
      executionData = inserted[0]
      logger.info(`[trades_day] ${executionData.id} created in job_executions`)
    } catch (e) {
      logger.error("[trades_day] POST failed", e)
      return res.status(500).json({ error: e?.message })
    }

    try {
      if (executionData.strategy === "SUBSCRIBE_CHASE") {
        await addToChaseQueue(user)
        await db
          .update(jobExecutions)
          .set({ status: JOB_EXECUTION_STATUS.QUEUE, queue: { id: executionData.id, type: "chase" } })
          .where(eq(jobExecutions.id, executionData.id))
        return res.json(executionData)
      }

      // Create the queue entry
      const qRes = await createJob({
        jobData: { ...executionData, orderTag },
        user,
      })

      // Update with queue info and status
      const queueInfo = pick(qRes, ["id", "name", "opts", "timestamp", "stacktrace", "returnvalue"])

      await db
        .update(jobExecutions)
        .set({ status: JOB_EXECUTION_STATUS.QUEUE, queue: queueInfo })
        .where(eq(jobExecutions.id, executionData.id))

      return res.json(executionData)
    } catch (e) {
      logger.error("[trades_day] job creation failed", e)
      await db
        .update(jobExecutions)
        .set({ status: JOB_EXECUTION_STATUS.REJECT, queue: { error: e?.message } })
        .where(eq(jobExecutions.id, executionData.id))

      return res.json(executionData)
    }
  }

  if (req.method === "DELETE") {
    try {
      const jobId = req.body.id as string
      const rows = await db
        .select({ queue: jobExecutions.queue })
        .from(jobExecutions)
        .where(eq(jobExecutions.id, jobId))

      const queueInfo = rows[0]?.queue as { id?: string } | undefined
      if (queueInfo?.id) {
        await deleteJob(queueInfo.id)
      }

      await db.delete(jobExecutions).where(eq(jobExecutions.id, jobId))
      return res.end()
    } catch (e) {
      logger.error("[trades_day] DELETE failed", e)
      return res.status(500).json({ error: e?.message })
    }
  }

  if (req.method === "PUT") {
    try {
      const { id, ...props } = req.body
      await db.update(jobExecutions).set(props).where(eq(jobExecutions.id, id))
      return res.end()
    } catch (e) {
      logger.error("[trades_day] PUT failed", e)
      return res.status(500).json({ error: e?.message })
    }
  }

  if (req.method === "GET") {
    try {
      const results = await db
        .select()
        .from(jobExecutions)
        .where(sql`date(${jobExecutions.createdAt}) = current_date`)
        .orderBy(desc(jobExecutions.createdAt))
      return res.json(results)
    } catch (e) {
      logger.error("[trades_day] GET failed", e)
      return res.status(500).json({ error: e?.message })
    }
  }

  res.status(400).end()
})
