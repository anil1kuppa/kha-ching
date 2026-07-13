import { eq } from "drizzle-orm"
import { db } from "../../lib/drizzle"
import { tradePlans } from "../../lib/schema"
import logger from "../../lib/logger"
import withSession from "../../lib/session"

const DB_PLAN_COLUMNS = new Set([
  "name",
  "strategy",
  "instrument",
  "expiryType",
  "productType",
  "dayOfWeek",
  "exitStrategy",
  "combinedExitStrategy",
  "runAt",
  "squareOffTime",
  "expiresAt",
  "expireIfUnsuccessfulInMins",
  "lots",
  "slmPercent",
  "slOrderType",
  "slLimitPricePercent",
  "maxProfitPoints",
  "isMaxProfitEnabled",
  "trailingProfitPercent",
  "maxLossPoints",
  "isMaxLossEnabled",
  "thresholdSkewPercent",
  "maxSkewPercent",
  "takeTradeIrrespectiveSkew",
  "volatilityType",
  "trailEveryPercentageChangeValue",
  "trailingSlPercent",
  "trailingMaxProfitPoints",
  "trailingMaxLossPoints",
  "isAutoSquareOffEnabled",
  "autoSquareOffTime",
])

const TIMESTAMP_COLUMNS = new Set(["runAt", "squareOffTime", "expiresAt", "autoSquareOffTime"])

const toDate = value => {
  if (!value) return value
  if (value instanceof Date) return value
  const d = new Date(value)
  return isNaN(d.getTime()) ? value : d
}

const mapPlanToDb = (planConfig = {}, dayOfWeek) => {
  const normalizedPlan = {
    ...planConfig,
    dayOfWeek: dayOfWeek || planConfig.dayOfWeek || planConfig.day_of_week,
    autoSquareOffTime: planConfig.autoSquareOffProps?.time || planConfig.autoSquareOffTime,
  }

  return Object.entries(normalizedPlan).reduce((accum, [key, value]) => {
    if (value === undefined || key === "id" || key === "collection") {
      return accum
    }

    if (DB_PLAN_COLUMNS.has(key)) {
      accum[key] = TIMESTAMP_COLUMNS.has(key) ? toDate(value) : value
    }
    return accum
  }, {})
}

const mapPlanFromDb = row => {
  const normalizedRow = Object.fromEntries(
    Object.entries(row).filter(([key, value]) => value != null && key !== "createdAt" && key !== "updatedAt")
  )

  return {
    ...normalizedRow,
    autoSquareOffProps: row.autoSquareOffTime
      ? { time: row.autoSquareOffTime, deletePendingOrders: true }
      : undefined,
  }
}

export default withSession(async (req, res) => {
  const user = req.session.get("user")

  if (!user) {
    return res.status(401).send("Unauthorized")
  }

  const { dayOfWeek, config } = req.body || {}

  try {
    if (req.method === "POST") {
      const planConfigs = Array.isArray(config) ? config : [config]
      const results = []

      for (const planConfig of planConfigs) {
        const inserted = await db
          .insert(tradePlans)
          .values(mapPlanToDb(planConfig, dayOfWeek))
          .returning()

        if (inserted.length > 0) {
          results.push(mapPlanFromDb(inserted[0]))
        }
      }

      return res.json(results[0] || {})
    }

    if (req.method === "PUT") {
      const planId = config?.id || req.body?.id
      await db
        .update(tradePlans)
        .set(mapPlanToDb(config, dayOfWeek))
        .where(eq(tradePlans.id, planId))

      const result = await db.select().from(tradePlans).where(eq(tradePlans.id, planId))

      if (result.length > 0) {
        return res.json(mapPlanFromDb(result[0]))
      }

      return res.status(404).json({ error: "Plan not found" })
    }

    if (req.method === "DELETE") {
      await db.delete(tradePlans).where(eq(tradePlans.id, config.id))
      return res.json({ success: true })
    }

    const results = await db
      .select()
      .from(tradePlans)
      .orderBy(tradePlans.dayOfWeek, tradePlans.createdAt)

    return res.json(results.map(mapPlanFromDb))
  } catch (e) {
    logger.error("[api/plan] error", e)
    return res.status(500).json({ error: e.message })
  }
})
