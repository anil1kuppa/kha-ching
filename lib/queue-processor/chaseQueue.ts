import { Worker, Job } from "bullmq"
import dayjs from "dayjs"
import type { HistoricalData } from "kiteconnect"
import logger from "../logger"
import { CHASE_Q_NAME, redisConnection } from "../queue"
import { ms, toIst, postToSlack } from "../utils"
import {
  getFnOExpiries,
  calculateEma,
  getPreviousTradingDay,
  calculate40EMA,
  getKiteInstance,
  placeKiteOrder,
  placeSL,
  getNetPositionQty,
} from "../kiteUtils"
import {
  getLatestEma,
  insertEma,
  getChaseStatus,
  updateChaseStatus,
  insertChaseLog,
  getSubscribeChaseJob,
} from "../drizzleDbUtils"
import { CHASE_STATUS } from "../constants"
import { generateSignal, getAcceptedPrevEma } from "../chaseSignal"

const OPEN_MINUTES = 9 * 60 + 16   // 9:16 AM IST
const CLOSE_MINUTES = 15 * 60 + 29  // 3:29 PM IST
const ROLLOVER_MINUTES = 15 * 60    // 3:00 PM IST

async function processCalculateEMA(job: Job) {
  const { user } = job.data as any
  logger.info(`[processCalculateEMA] job ${job.id}`)

  if (!user) {
    logger.error("[processCalculateEMA] missing user payload")
    return null
  }

  const accessToken = user?.session?.access_token
  if (!accessToken) {
    logger.error("[processCalculateEMA] no access token in job data")
    return null
  }

  const now = dayjs()

  const futuresInstruments = await getFnOExpiries("NIFTY", "FUT")
  if (!futuresInstruments.length) {
    logger.warn("[processCalculateEMA] no FUT instruments found for NIFTY")
    return []
  }

  const currentExpiry = dayjs(futuresInstruments[0].expiry).startOf("day")
  const currentExpiryToday = currentExpiry.isSame(now.startOf("day"), "day")

  const instruments =
    currentExpiryToday && futuresInstruments[1]
      ? futuresInstruments.slice(0, 2)
      : [futuresInstruments[0]]

  const results = await Promise.all(
    instruments.map(async instrument => {
      try {
        const prevRow = await getLatestEma(instrument.tradingsymbol)
        const prevEMA = await getAcceptedPrevEma(prevRow, now, accessToken)
        logger.info(`[processCalculateEMA] calculating EMA for ${instrument.tradingsymbol} with prev EMA ${prevRow?.ema ?? "null"} and accepted prev EMA ${prevEMA ?? "null"}`)
        const emaResult = await calculateEma(instrument, prevEMA, accessToken)
        if (!emaResult) {
          logger.warn(
            `[processCalculateEMA] skipped for ${instrument.tradingsymbol} due to insufficient candle data or no current-day candles`
          )
          return null
        }

        const instrumentToken = Number(instrument.instrument_token)
        if (Number.isNaN(instrumentToken)) {
          throw new Error(`Invalid instrument_token for ${instrument.tradingsymbol}`)
        }

        await insertEma({
          createdAt: now.toDate(),
          tradingsymbol: instrument.tradingsymbol,
          instrumentToken,
          ema: emaResult.ema,
          highestHigh: emaResult.highestHigh,
          lowestLow: emaResult.lowestLow,
          lastClose: emaResult.lastClose,
        })
        logger.info(`[processCalculateEMA] inserted EMA for ${instrument.tradingsymbol} EMA=${emaResult.ema.toFixed(2)}`)

        return {
          tradingsymbol: instrument.tradingsymbol,
          instrumentToken: instrument.instrument_token,
          lotSize: (instrument as any).lot_size ?? 1,
          ...emaResult,
        }
      } catch (error) {
        logger.error(`[processCalculateEMA] failed for ${instrument.tradingsymbol}`, error)
        return null
      }
    })
  )

  const filteredResults = results.filter(Boolean)
  const todaysDate = toIst(now).format("YYYY-MM-DD HH:mm:ss")
  if (filteredResults.length) {
    await generateSignal(filteredResults as any[], todaysDate, accessToken)
  }
  return filteredResults
}

async function processUpdateSL(job: Job) {
  logger.info(`[processUpdateSL] job ${job.id}`)

  const now = dayjs()
  const nowIst = toIst(now)
  const currentMinutes = nowIst.hour() * 60 + nowIst.minute()
  logger.info(`[processUpdateSL] current time ${nowIst.format("HH:mm")} (${currentMinutes} minutes); OPEN_MINUTES=${OPEN_MINUTES}, CLOSE_MINUTES=${CLOSE_MINUTES}`);
  if (currentMinutes < OPEN_MINUTES || currentMinutes > CLOSE_MINUTES) {
    logger.info("[processUpdateSL] markets closed, skipping")
    return null
  }

  let chaseStatusData: Awaited<ReturnType<typeof getChaseStatus>>
  try {
    chaseStatusData = await getChaseStatus()
    logger.info(`[processUpdateSL] chase status: ${JSON.stringify(chaseStatusData)}`)
  } catch (err) {
    logger.error("[processUpdateSL] getChaseStatus threw:", err)
    return null
  }
  if (!chaseStatusData) {
    logger.error("[processUpdateSL] failed to get chase status")
    return null
  }

  const { status: currentStatus, tradingsymbol, stoploss, entryPoint, instrumentToken, createdAt } =
    chaseStatusData

  if (!currentStatus || !tradingsymbol || !instrumentToken) {
    logger.info("[processUpdateSL] no active chase position")
    return null
  }

  const { user } = job.data as any
  const accessToken = user?.session?.access_token
  if (!accessToken) {
    logger.error("[processUpdateSL] no access token in job data")
    return null
  }

  const futuresInstruments = await getFnOExpiries("NIFTY", "FUT")
  const kite = getKiteInstance(accessToken)

  const subscribeChaseJob = await getSubscribeChaseJob()
  const isAutomated = subscribeChaseJob !== null && (subscribeChaseJob.lots ?? 0) > 0
  const lots = subscribeChaseJob?.lots ?? 0
  const activeInstrumentData = futuresInstruments.find((i: any) => i.tradingsymbol === tradingsymbol)
  const lotSize: number = (activeInstrumentData as any)?.lot_size ?? 1
  const quantity = lots * lotSize

  // At open: recalculate EMA on first 2-min candle and update SL
  if (
    (currentStatus === CHASE_STATUS.LONG || currentStatus === CHASE_STATUS.SHORT) &&
    (currentMinutes === OPEN_MINUTES || toIst(chaseStatusData.updatedAt ?? now).format("YYYY-MM-DD") !== nowIst.format("YYYY-MM-DD"))
  ) {
    const prevRow = await getLatestEma(tradingsymbol)

    const previousTradingDayDayjs = toIst(await getPreviousTradingDay(accessToken))
    const previousTradingDay = previousTradingDayDayjs.format("YYYY-MM-DD")
    const prevEmaTarget = previousTradingDayDayjs.startOf("day")
      .set("hour", 16).set("minute", 15).set("second", 0).set("millisecond", 0)
    const prevRowCreatedAt = prevRow?.createdAt ? toIst(prevRow.createdAt).startOf("minute") : null
    const isValidPrevRow = prevRowCreatedAt?.isSame(prevEmaTarget) ?? false

    let result: { ema: number; lastClose: number; lowestLow: number; highestHigh: number } | null

    if (!isValidPrevRow) {
      logger.info(`[processUpdateSL] prevRow not from previous trading day at 4:15 PM IST, calculating EMA freshly`)
      result = await calculateEma(activeInstrumentData as any, null, accessToken)
    } else {
      const candles = (await kite.getHistoricalData(
        instrumentToken,
        "60minute",
        nowIst.subtract(1, "hour").toDate(),
        nowIst.toDate()
      )) as HistoricalData[]
      if (!Array.isArray(candles) || !candles.length) {
        logger.error(`[processUpdateSL] no candles for ${tradingsymbol}`)
        return null
      }
      result = calculate40EMA(candles, prevRow!.ema)
    }

    if (!result) {
      logger.error("[processUpdateSL] EMA calculation returned null")
      return null
    }

    const { ema, lastClose, lowestLow, highestHigh } = result
    const longT1 = Math.round(1.004 * ema)
    const shortT1 = Math.round(0.996 * ema)
    logger.info(`[processUpdateSL] ema=${ema} lastClose=${lastClose} longT1=${longT1} shortT1=${shortT1}`)

    const createdAtDate = createdAt ? toIst(createdAt).format("YYYY-MM-DD") : ""
    logger.info(`[processUpdateSL] previousTradingDay=${previousTradingDay} createdAtDate=${createdAtDate}`)
    let newStoploss = stoploss ?? 0
    const netQty = isAutomated && quantity > 0 ? await getNetPositionQty(kite, tradingsymbol) : 0
    const hasPosition = currentStatus === CHASE_STATUS.LONG ? netQty > 0 : netQty < 0

    if (currentStatus === CHASE_STATUS.LONG && previousTradingDay === createdAtDate) {
      if (lastClose >= longT1) {
        newStoploss = Math.max(newStoploss, ema)
        await postToSlack(`:zap: Action $chase: Update SL for ${tradingsymbol} to ${newStoploss}`)
        await updateChaseStatus({ stoploss: newStoploss, updatedAt: new Date(), tradingsymbol, instrumentToken })
        if (isAutomated && quantity > 0) {
          if (hasPosition) await placeSL(tradingsymbol, "SELL", quantity, accessToken, newStoploss)
          else logger.info(`[processUpdateSL] no open position for ${tradingsymbol} — skipping SL order`)
        }
      } else if (ema <= lastClose && lastClose <= longT1) {
        newStoploss = Math.max(newStoploss, Math.round((lowestLow + ema) / 2))
        await postToSlack(`:zap: Action $chase: Update SL for ${tradingsymbol} to ${newStoploss}`)
        await updateChaseStatus({ stoploss: newStoploss, updatedAt: new Date(), tradingsymbol, instrumentToken })
        if (isAutomated && quantity > 0) {
          if (hasPosition) await placeSL(tradingsymbol, "SELL", quantity, accessToken, newStoploss)
          else logger.info(`[processUpdateSL] no open position for ${tradingsymbol} — skipping SL order`)
        }
      } else if (lastClose <= shortT1) {
        await postToSlack(`:rotating_light: Action $chase: Transaction Alert Exit ${tradingsymbol} AT CMP :stop_sign:`)
        const { success, error } = await updateChaseStatus({
          stoploss: newStoploss, updatedAt: new Date(), createdAt: new Date(),
          status: CHASE_STATUS.AWAITING_SIGNAL, tradingsymbol, instrumentToken,
          isSignalBreachingTolerance: false,
        })
        if (success) {
          await insertChaseLog({ tradingsymbol, transactionType: "SELL", averagePrice: lastClose })
          if (isAutomated && quantity > 0) {
            if (hasPosition) await placeKiteOrder(accessToken, { tradingsymbol, exchange: "NFO", transaction_type: "SELL", quantity, order_type: "MARKET", product: "NRML", tag: "chase" } as any)
            else logger.info(`[processUpdateSL] no open position for ${tradingsymbol} — skipping exit order`)
          }
        } else logger.error("[processUpdateSL] error updating chase_status:", error)
      } else if (shortT1 <= lastClose && lastClose <= ema) {
        newStoploss = Math.max(newStoploss, lowestLow)
        await postToSlack(`:zap: Action $chase: Update SL for ${tradingsymbol} to ${newStoploss}`)
        await updateChaseStatus({ stoploss: newStoploss, updatedAt: new Date(), tradingsymbol, instrumentToken })
        if (isAutomated && quantity > 0) {
          if (hasPosition) await placeSL(tradingsymbol, "SELL", quantity, accessToken, newStoploss)
          else logger.info(`[processUpdateSL] no open position for ${tradingsymbol} — skipping SL order`)
        }
      }
    } else if (currentStatus === CHASE_STATUS.SHORT && previousTradingDay === createdAtDate) {
      if (lastClose <= shortT1) {
        newStoploss = Math.min(newStoploss, ema)
        await postToSlack(`:zap: Action $chase: Update SL for ${tradingsymbol} to ${newStoploss}`)
        await updateChaseStatus({ stoploss: newStoploss, updatedAt: new Date(), tradingsymbol, instrumentToken })
        if (isAutomated && quantity > 0) {
          if (hasPosition) await placeSL(tradingsymbol, "BUY", quantity, accessToken, newStoploss)
          else logger.info(`[processUpdateSL] no open position for ${tradingsymbol} — skipping SL order`)
        }
      } else if (ema >= lastClose && lastClose >= shortT1) {
        newStoploss = Math.min(newStoploss, Math.round((highestHigh + ema) / 2))
        await postToSlack(`:zap: Action $chase: Update SL for ${tradingsymbol} to ${newStoploss}`)
        await updateChaseStatus({ stoploss: newStoploss, updatedAt: new Date(), tradingsymbol, instrumentToken })
        if (isAutomated && quantity > 0) {
          if (hasPosition) await placeSL(tradingsymbol, "BUY", quantity, accessToken, newStoploss)
          else logger.info(`[processUpdateSL] no open position for ${tradingsymbol} — skipping SL order`)
        }
      } else if (longT1 >= lastClose && lastClose >= ema) {
        newStoploss = Math.min(newStoploss, highestHigh)
        await postToSlack(`:zap: Action $chase: Update SL for ${tradingsymbol} to ${newStoploss}`)
        await updateChaseStatus({ stoploss: newStoploss, updatedAt: new Date(), tradingsymbol, instrumentToken })
        if (isAutomated && quantity > 0) {
          if (hasPosition) await placeSL(tradingsymbol, "BUY", quantity, accessToken, newStoploss)
          else logger.info(`[processUpdateSL] no open position for ${tradingsymbol} — skipping SL order`)
        }
      } else if (lastClose >= longT1) {
        await postToSlack(`:rotating_light: Action $chase: Transaction Alert Exit ${tradingsymbol} AT CMP :stop_sign:`)
        const { success, error } = await updateChaseStatus({
          stoploss: newStoploss, updatedAt: new Date(), createdAt: new Date(),
          status: CHASE_STATUS.AWAITING_SIGNAL, tradingsymbol, instrumentToken,
          isSignalBreachingTolerance: false,
        })
        if (success) {
          await insertChaseLog({ tradingsymbol, transactionType: "BUY", averagePrice: lastClose })
          if (isAutomated && quantity > 0) {
            if (hasPosition) await placeKiteOrder(accessToken, { tradingsymbol, exchange: "NFO", transaction_type: "BUY", quantity, order_type: "MARKET", product: "NRML", tag: "chase" } as any)
            else logger.info(`[processUpdateSL] no open position for ${tradingsymbol} — skipping exit order`)
          }
        } else logger.error("[processUpdateSL] error updating chase_status:", error)
      }
    } else {
      // Different day — update SL to EMA
      newStoploss =
        currentStatus === CHASE_STATUS.LONG
          ? Math.max(newStoploss, ema)
          : Math.min(newStoploss, ema)
      await postToSlack(`:zap: Action $chase: Update SL for ${tradingsymbol} to ${newStoploss}`)
      const { success, error } = await updateChaseStatus({
        stoploss: newStoploss, updatedAt: new Date(), tradingsymbol, instrumentToken,
        isSignalBreachingTolerance: false,
      })
      if (success) {
        if (isAutomated && quantity > 0) {
          if (hasPosition) await placeSL(tradingsymbol, currentStatus === CHASE_STATUS.LONG ? "SELL" : "BUY", quantity, accessToken, newStoploss)
          else logger.info(`[processUpdateSL] no open position for ${tradingsymbol} — skipping SL order`)
        }
      } else logger.error("[processUpdateSL] error updating chase_status:", error)
    }

    return { stoploss: newStoploss }
  }

  // Rollover: switch to next month's contract
  if (
    (currentStatus === CHASE_STATUS.LONG || currentStatus === CHASE_STATUS.SHORT) &&
    currentMinutes === ROLLOVER_MINUTES &&
    futuresInstruments.length === 2 &&
    futuresInstruments[0].tradingsymbol === tradingsymbol
  ) {
    const nextInstrument = futuresInstruments[1]
    const prevRow = await getLatestEma(nextInstrument.tradingsymbol)
    const emaResult = await calculateEma(nextInstrument, prevRow?.ema ?? null, accessToken)
    if (!emaResult) {
      logger.error(`[processUpdateSL] rollover EMA calc failed for ${nextInstrument.tradingsymbol}`)
      return null
    }
    const newStoploss = emaResult.ema
    await postToSlack(
      `:repeat: Action $chase: Transaction Alert, Rollover to :arrow_right: ${nextInstrument.tradingsymbol}, Chase is now *${currentStatus}* with stoploss: *${newStoploss}* :shield:`
    )
    const { success, error } = await updateChaseStatus({
      stoploss: newStoploss,
      updatedAt: new Date(),
      createdAt: new Date(),
      tradingsymbol: nextInstrument.tradingsymbol,
      instrumentToken: Number(nextInstrument.instrument_token),
      isSignalBreachingTolerance: false,
      entryPoint: emaResult.lastClose,
    })
    if (!success) {
      logger.error("[processUpdateSL] error updating chase_status on rollover:", error)
      return null
    }
    const ltpData = await kite.getLTP(`NFO:${tradingsymbol}`)
    const ltp = (ltpData as any)[`NFO:${tradingsymbol}`]?.last_price ?? 0
    await insertChaseLog({
      tradingsymbol,
      transactionType: currentStatus === CHASE_STATUS.SHORT ? "BUY" : "SELL",
      averagePrice: ltp,
    })
    await insertChaseLog({
      tradingsymbol: nextInstrument.tradingsymbol,
      transactionType: currentStatus === CHASE_STATUS.SHORT ? "SELL" : "BUY",
      averagePrice: emaResult.lastClose,
    })
    if (isAutomated && quantity > 0) {
      const rolloverNetQty = await getNetPositionQty(kite, tradingsymbol)
      if (rolloverNetQty === 0) {
        logger.info(`[processUpdateSL] no open position for ${tradingsymbol} — skipping rollover orders`)
      } else {
        const newLotSize: number = (nextInstrument as any)?.lot_size ?? lotSize
        const newQuantity = lots * newLotSize
        const exitSide = currentStatus === CHASE_STATUS.LONG ? "SELL" : "BUY"
        const entrySide = currentStatus === CHASE_STATUS.LONG ? "BUY" : "SELL"
        await placeKiteOrder(accessToken, { tradingsymbol, exchange: "NFO", transaction_type: exitSide, quantity, order_type: "MARKET", product: "NRML", tag: "chase" } as any)
        await placeKiteOrder(accessToken, { tradingsymbol: nextInstrument.tradingsymbol, exchange: "NFO", transaction_type: entrySide, quantity: newQuantity, order_type: "MARKET", product: "NRML", tag: "chase" } as any)
        await placeSL(nextInstrument.tradingsymbol, exitSide, newQuantity, accessToken, newStoploss)
      }
    }
    return { signal: "ROLLOVER", stoploss: newStoploss }
  }

  // Every minute: check 2-min candles for SL breach or entry trigger
  if (
    currentStatus === CHASE_STATUS.SHORT ||
    currentStatus === CHASE_STATUS.LONG ||
    currentStatus === CHASE_STATUS.AWAITING_SHORT ||
    currentStatus === CHASE_STATUS.AWAITING_LONG
  ) {
    const candles = (await kite.getHistoricalData(
      instrumentToken,
      "minute",
      nowIst.subtract(5, "minute").toDate(),
      nowIst.toDate()
    )) as HistoricalData[]
    if (!Array.isArray(candles) || !candles.length) {
      logger.warn(`[processUpdateSL] no 2-min candles for ${tradingsymbol}`)
      return null
    }

    const candle = candles[candles.length - 1]
    logger.info(`[processUpdateSL] last candle date=${candle.date} open=${candle.open} high=${candle.high} low=${candle.low} close=${candle.close}`)

    if (currentStatus === CHASE_STATUS.SHORT && candle.high >= (stoploss ?? 0)) {
        logger.info(`[processUpdateSL] SL breached SHORT for ${tradingsymbol}`)
        await postToSlack(`:rotating_light: Transaction alert exit_short. Chase is now Awaiting Signal :hourglass_flowing_sand:`)
        const { success, error } = await updateChaseStatus({
          status: CHASE_STATUS.AWAITING_SIGNAL, isSignalBreachingTolerance: false,
        })
        if (success) await insertChaseLog({ tradingsymbol, transactionType: "BUY", averagePrice: stoploss ?? 0 })
        else logger.error("[processUpdateSL] error updating chase_status:", error)
        return { signal: "TRANSACTION_ALERT", stoploss }
      } else if (currentStatus === CHASE_STATUS.LONG && candle.low <= (stoploss ?? 0)) {
        logger.info(`[processUpdateSL] SL breached LONG for ${tradingsymbol}`)
        await postToSlack(`:rotating_light: Transaction alert exit_long. Chase is now Awaiting Signal :hourglass_flowing_sand:`)
        const { success, error } = await updateChaseStatus({
          status: CHASE_STATUS.AWAITING_SIGNAL, isSignalBreachingTolerance: false,
        })
        if (success) await insertChaseLog({ tradingsymbol, transactionType: "SELL", averagePrice: stoploss ?? 0 })
        else logger.error("[processUpdateSL] error updating chase_status:", error)
        return { signal: "TRANSACTION_ALERT", stoploss }
      } else if (currentStatus === CHASE_STATUS.AWAITING_LONG && candle.high >= (entryPoint ?? 0)) {
        logger.info(`[processUpdateSL] Entry triggered AWAITING_LONG for ${tradingsymbol}`)
        await postToSlack(`:rocket: Transaction Alert enter_long. Chase is now *Long* :arrow_up:`)
        const { success, error } = await updateChaseStatus({
          status: CHASE_STATUS.LONG, createdAt: new Date(), isSignalBreachingTolerance: false,
        })
        if (success) {
          await insertChaseLog({ tradingsymbol, transactionType: "BUY", averagePrice: entryPoint ?? 0 })
          // Entry was placed as SL-M in generateSignal; only place the stop-loss order here
          if (isAutomated && quantity > 0) {
            const entryNetQty = await getNetPositionQty(kite, tradingsymbol)
            if (entryNetQty > 0) {
              await placeKiteOrder(accessToken, { tradingsymbol, exchange: "NFO", transaction_type: "SELL", quantity, order_type: "SL", product: "NRML", tag: "chase", trigger_price: stoploss ?? 0, price: (stoploss ?? 0) - 5 } as any)
            } else {
              logger.info(`[processUpdateSL] no long position for ${tradingsymbol} — entry SL-M may not have filled yet, skipping SL order`)
            }
          }
        } else logger.error("[processUpdateSL] error updating chase_status:", error)
        return { signal: "TRANSACTION_ALERT", stoploss }
      } else if (currentStatus === CHASE_STATUS.AWAITING_SHORT && candle.low <= (entryPoint ?? 0)) {
        logger.info(`[processUpdateSL] Entry triggered AWAITING_SHORT for ${tradingsymbol}`)
        await postToSlack(`:rocket: Transaction Alert enter_short. Chase is now *Short* :arrow_down:`)
        const { success, error } = await updateChaseStatus({
          status: CHASE_STATUS.SHORT, createdAt: new Date(), isSignalBreachingTolerance: false,
        })
        if (success) {
          await insertChaseLog({ tradingsymbol, transactionType: "SELL", averagePrice: entryPoint ?? 0 })
          // Entry was placed as SL-M in generateSignal; only place the stop-loss order here
          if (isAutomated && quantity > 0) {
            const entryNetQty = await getNetPositionQty(kite, tradingsymbol)
            if (entryNetQty < 0) {
              await placeKiteOrder(accessToken, { tradingsymbol, exchange: "NFO", transaction_type: "BUY", quantity, order_type: "SL", product: "NRML", tag: "chase", trigger_price: stoploss ?? 0, price: (stoploss ?? 0) + 5 } as any)
            } else {
              logger.info(`[processUpdateSL] no short position for ${tradingsymbol} — entry SL-M may not have filled yet, skipping SL order`)
            }
          }
        } else logger.error("[processUpdateSL] error updating chase_status:", error)
        return { signal: "TRANSACTION_ALERT", stoploss }
      }
  }

  logger.info("[processUpdateSL] no action taken")
  return null
}

const worker = new Worker(
  CHASE_Q_NAME,
  async job => {
    const name = job.name || ""
    switch (name) {
      case "calculateEMA":
        return processCalculateEMA(job)
      case "updateSL":
        return processUpdateSL(job)
      default: {
        logger.info(`[chaseQueue] unknown job name ${name}`)
        return null
      }
    }
  },
  {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: ms(5 * 60),
  }
)

worker.on("error", err => {
  logger.error("🔴 [chaseQueue] worker error", err)
})

export default worker
