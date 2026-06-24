import dayjs from "dayjs"
import logger from "./logger"
import { toIst, postToSlack } from "./utils"
import { getPreviousTradingDay, placeKiteOrder, getKiteInstance } from "./kiteUtils"
import {
  getChaseStatus,
  updateChaseStatus,
  getSubscribeChaseJob,
} from "./drizzleDbUtils"
import { CHASE_STATUS } from "./constants"

export type ChaseInstrument = {
  tradingsymbol: string
  instrumentToken: number
  ema: number
  highestHigh: number
  lowestLow: number
  lastClose: number
  lotSize: number
}

export const getAcceptedPrevEma = async (
  prevRow: any,
  now: dayjs.Dayjs,
  accessToken: string
): Promise<number | null> => {
  if (!prevRow) {
    return null
  }

  const nowIst = toIst(now)
  const currentMinute = nowIst.startOf("minute")
  const cutoff = nowIst
    .set("hour", 10)
    .set("minute", 15)
    .set("second", 0)
    .set("millisecond", 0)
  const prevCreatedAt = prevRow.createdAt ? toIst(prevRow.createdAt).startOf("minute") : null
  logger.info(
    `[chaseQueue] getAcceptedPrevEma currentMinute=${currentMinute.format("HH:mm")} cutoff=${cutoff.format("HH:mm")} prevCreatedAt=${prevCreatedAt ? prevCreatedAt.format("HH:mm") : "null"}`
  )

  if (!prevCreatedAt) {
    return null
  }

  if (currentMinute.isSame(cutoff)) {
    const previousTradingDay = toIst(await getPreviousTradingDay(accessToken)).startOf("day")
    const previousTradingDayTarget = previousTradingDay.set("hour", 16).set("minute", 15)
    return prevCreatedAt.isSame(previousTradingDayTarget) ? prevRow.ema : null
  }

  if (currentMinute.isAfter(cutoff)) {
    const target = currentMinute.subtract(1, "hour")
    return prevCreatedAt.isSame(target) ? prevRow.ema : null
  }

  return null
}

async function placeEntryTriggerOrder(
  instrument: ChaseInstrument,
  side: "BUY" | "SELL",
  triggerPrice: number,
  accessToken: string
): Promise<void> {
  const subscribeChaseJob = await getSubscribeChaseJob()
  const lots = subscribeChaseJob?.lots ?? 0
  if (lots <= 0) {
    logger.info("[generateSignal] not subscribed to chase — skipping entry trigger order")
    return
  }
  const quantity = lots * (instrument.lotSize ?? 1)

  const kite = getKiteInstance(accessToken)
  const ltpData = await kite.getLTP(`NFO:${instrument.tradingsymbol}`)
  const ltp: number = (ltpData as any)[`NFO:${instrument.tradingsymbol}`]?.last_price ?? 0
  const alreadyBreached = side === "BUY" ? ltp >= triggerPrice : ltp <= triggerPrice

  if (alreadyBreached) {
    logger.info(
      `[generateSignal] price already breached (ltp=${ltp} trigger=${triggerPrice}) — placing MARKET ${side} for ${instrument.tradingsymbol} qty=${quantity}`
    )
    await placeKiteOrder(accessToken, {
      tradingsymbol: instrument.tradingsymbol,
      exchange: "NFO",
      transaction_type: side,
      quantity,
      order_type: "MARKET",
      product: "NRML",
      tag: "chase",
    } as any)
  } else {
    logger.info(
      `[generateSignal] placing SL-M ${side} entry trigger order for ${instrument.tradingsymbol} at ${triggerPrice} qty=${quantity}`
    )
    await placeKiteOrder(accessToken, {
      tradingsymbol: instrument.tradingsymbol,
      exchange: "NFO",
      transaction_type: side,
      quantity,
      order_type: "SL",
      product: "NRML",
      trigger_price: triggerPrice,
      price: side === "BUY" ? triggerPrice + 5 : triggerPrice - 5,
      tag: "chase",
    } as any)
  }
}

export const generateSignal = async (
  instruments: ChaseInstrument[],
  todaysDate: string,
  accessToken: string
): Promise<void> => {
  const chaseStatusData = await getChaseStatus()
  if (!chaseStatusData) {
    logger.error("[generateSignal] no chase status data found")
    return
  }
  logger.info(
    `[generateSignal] status=${JSON.stringify(chaseStatusData)} date=${todaysDate}`
  )

  let { status: currentStatus, tradingsymbol, stoploss, isSignalBreachingTolerance, createdAt } =
    chaseStatusData

  if (!instruments.length) {
    logger.error("[generateSignal] no instruments found")
    return
  }

  let instrument = instruments.length === 1 ? instruments[0] : instruments[1]

  const [currentDate, timePart] = todaysDate.split(" ")
  const createdAtDate = createdAt ? dayjs(createdAt).format("YYYY-MM-DD") : ""
  const hour = parseInt(timePart.split(":")[0])

  if (
    (currentStatus === CHASE_STATUS.LONG || currentStatus === CHASE_STATUS.SHORT) &&
    hour !== 13
  ) {
    logger.info("[generateSignal] chase already long/short, skipping")
  } else if (
    (currentStatus === CHASE_STATUS.LONG || currentStatus === CHASE_STATUS.SHORT) &&
    hour === 13 &&
    createdAtDate !== currentDate
  ) {
    instrument = instruments.find(i => i.tradingsymbol === tradingsymbol) ?? instrument
    stoploss =
      currentStatus === CHASE_STATUS.LONG
        ? Math.max(instrument.ema, stoploss ?? 0)
        : Math.min(instrument.ema, stoploss ?? 0)
    logger.info(
      `[generateSignal] updating SL to ${stoploss} for ${instrument.tradingsymbol}`
    )
    await postToSlack(
      `:shield: Action $chase: Chase is currently ${currentStatus}, update the stoploss to ${stoploss} for symbol:${instrument.tradingsymbol}`
    )
    const { success, error } = await updateChaseStatus({ stoploss, updatedAt: new Date() })
    if (!success) {
      logger.error("[generateSignal] error updating chase_status:", error)
    }
  } else if (currentStatus === CHASE_STATUS.AWAITING_SIGNAL) {
    const longTolerance = instrument.ema ? 1.002 * instrument.ema : 0
    const shortTolerance = instrument.ema ? 0.998 * instrument.ema : 0
    logger.info(
      `[generateSignal] awaiting signal; longTolerance=${longTolerance} shortTolerance=${shortTolerance}`
    )

    if (instrument.lastClose > longTolerance) {
      stoploss = Math.round(Math.min(instrument.ema, instrument.lowestLow))
      await postToSlack(
        `:rocket: Action $chase: Chase is AWAITING_LONG. 🚀 Enter on crossing ${instrument.highestHigh} for symbol: ${instrument.tradingsymbol}, stoploss ${stoploss} :shield:`
      )
      const { success, error } = await updateChaseStatus({
        stoploss,
        updatedAt: new Date(),
        createdAt: new Date(),
        entryPoint: instrument.highestHigh,
        status: CHASE_STATUS.AWAITING_LONG,
        tradingsymbol: instrument.tradingsymbol,
        instrumentToken: instrument.instrumentToken,
        isSignalBreachingTolerance: false,
      })
      if (!success) {
        logger.error("[generateSignal] error updating chase_status:", error)
      } else {
        await placeEntryTriggerOrder(instrument, "BUY", instrument.highestHigh, accessToken)
      }
    } else if (instrument.lastClose < shortTolerance) {
      stoploss = Math.round(Math.max(instrument.ema, instrument.highestHigh))
      await postToSlack(
        `:rotating_light: Action $chase: Chase is AWAITING_SHORT. 🔻 Enter on crossing ${instrument.lowestLow} for symbol: ${instrument.tradingsymbol}, stoploss ${stoploss} :shield:`
      )
      const { success, error } = await updateChaseStatus({
        stoploss,
        updatedAt: new Date(),
        createdAt: new Date(),
        entryPoint: instrument.lowestLow,
        status: CHASE_STATUS.AWAITING_SHORT,
        tradingsymbol: instrument.tradingsymbol,
        instrumentToken: instrument.instrumentToken,
        isSignalBreachingTolerance: false,
      })
      if (!success) {
        logger.error("[generateSignal] error updating chase_status:", error)
      } else {
        await placeEntryTriggerOrder(instrument, "SELL", instrument.lowestLow, accessToken)
      }
    } else if (hour !== 16) {
      await postToSlack(
        `:grey_question: Entry Signal Not Found. :hourglass_flowing_sand: Chase is AwaitingSignal`
      )
    }
  } else if (
    currentStatus === CHASE_STATUS.AWAITING_LONG ||
    currentStatus === CHASE_STATUS.AWAITING_SHORT
  ) {
    instrument = instruments.find(i => i.tradingsymbol === tradingsymbol) ?? instrument
    logger.info(`[generateSignal] validating signal for ${instrument.tradingsymbol}`)
    const longTolerance = instrument.ema ? 1.002 * instrument.ema : 0
    const shortTolerance = instrument.ema ? 0.998 * instrument.ema : 0

    if (hour === 16) {
      logger.info("[generateSignal] EOD — resetting to AWAITING_SIGNAL")
      const { success, error } = await updateChaseStatus({
        updatedAt: new Date(),
        createdAt: new Date(),
        status: CHASE_STATUS.AWAITING_SIGNAL,
        isSignalBreachingTolerance: false,
      })
      if (!success) {
        logger.error("[generateSignal] error updating chase_status:", error)
      }
    } else if (
      currentStatus === CHASE_STATUS.AWAITING_LONG &&
      (instrument.lastClose < (stoploss ?? 0) || isSignalBreachingTolerance)
    ) {
      await postToSlack(
        `:x: Action $chase: Signal Invalid. :no_entry_sign: Chase is now AwaitingSignal :hourglass_flowing_sand:`
      )
      const { success, error } = await updateChaseStatus({
        updatedAt: new Date(),
        createdAt: new Date(),
        status: CHASE_STATUS.AWAITING_SIGNAL,
        isSignalBreachingTolerance: false,
      })
      if (success) {
        await generateSignal(instruments, todaysDate, accessToken)
      } else {
        logger.error("[generateSignal] error updating chase_status:", error)
      }
    } else if (
      currentStatus === CHASE_STATUS.AWAITING_LONG &&
      instrument.lastClose < shortTolerance
    ) {
      logger.info(
        "[generateSignal] awaiting long but below short tolerance — marking breach"
      )
      const { success, error } = await updateChaseStatus({
        updatedAt: new Date(),
        isSignalBreachingTolerance: true,
      })
      if (!success) {
        logger.error("[generateSignal] error updating chase_status:", error)
      }
    } else if (
      currentStatus === CHASE_STATUS.AWAITING_SHORT &&
      (instrument.lastClose > (stoploss ?? 0) || isSignalBreachingTolerance)
    ) {
      await postToSlack(
        `:x: Action $chase: Signal Invalid. :no_entry_sign: Chase is now AwaitingSignal :hourglass_flowing_sand:`
      )
      const { success, error } = await updateChaseStatus({
        updatedAt: new Date(),
        createdAt: new Date(),
        status: CHASE_STATUS.AWAITING_SIGNAL,
        isSignalBreachingTolerance: false,
      })
      if (success) {
        await generateSignal(instruments, todaysDate, accessToken)
      } else {
        logger.error("[generateSignal] error updating chase_status:", error)
      }
    } else if (
      currentStatus === CHASE_STATUS.AWAITING_SHORT &&
      instrument.lastClose > longTolerance
    ) {
      logger.info(
        "[generateSignal] awaiting short but above long tolerance — marking breach"
      )
      const { success, error } = await updateChaseStatus({
        isSignalBreachingTolerance: true,
        updatedAt: new Date(),
      })
      if (!success) {
        logger.error("[generateSignal] error updating chase_status:", error)
      }
    }
  }
}
