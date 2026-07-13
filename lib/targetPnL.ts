import { Promise } from "bluebird"
import dayjs from "dayjs"
import type { KiteOrder } from "../types/kite"
import type { ATM_STRADDLE_TRADE, ATM_STRANGLE_TRADE, SUPPORTED_TRADE_CONFIG } from "../types/trade"

type StraddleOrStrangleTrade = ATM_STRADDLE_TRADE | ATM_STRANGLE_TRADE
import { type COMPLETED_BY_TAG, JOB_EXECUTION_STATUS, USER_OVERRIDE } from "./constants"
import { getValuesfromDB, patchDbTrade } from "./drizzleDbUtils"
import autoSquareOffStrat, { squareOffTag } from "./exit-strategies/autoSquareOff"
import { syncGetKiteInstance, getInstrumentPrice, getCompletedOrdersbyTag } from "./kiteUtils"
import logger from "./logger"
import {
  getTimeLeftInMarketClosingMs,
  isTimeAfterAutoSquareOff,
  // logDeep,
  round,
  withRemoteRetry,
} from "./utils"

const targetPnL = async ({
  _kite,
  initialJobData,
  rawKiteOrdersResponse,
}: {
  _kite?: any
  initialJobData: SUPPORTED_TRADE_CONFIG
  rawKiteOrdersResponse: KiteOrder[]
}): Promise<any> => {
  const {
    isMaxLossEnabled,
    orderTag,
    isMaxProfitEnabled,
    isAutoSquareOffEnabled,
    trailingProfitPercent,
    autoSquareOffProps: { time } = {},
  } = initialJobData as StraddleOrStrangleTrade

  if (
    getTimeLeftInMarketClosingMs() < 0 ||
    (isAutoSquareOffEnabled && isTimeAfterAutoSquareOff(time!))
  ) {
    return Promise.resolve(
      "🟢 [targetPnL] Terminating the targetPnl queue as market closing or after square off time.."
    )
  }
  const kite = _kite || syncGetKiteInstance(initialJobData.user)
  const completedOrders: COMPLETED_BY_TAG[] = await getCompletedOrdersbyTag(orderTag!, kite)

  const totalPoints = await completedOrders.reduce(
    async (prev, current) => {
      const currentPosition = await prev
      if (current.quantity == 0) currentPosition.points += current.points
      else {
        const underlyingLTP = await withRemoteRetry(async () =>
          getInstrumentPrice(kite, current.tradingsymbol, "NFO")
        )
        currentPosition.points +=
          current.points + (current.quantity > 0 ? underlyingLTP : -1 * underlyingLTP)
        currentPosition.areAllOrdersCompleted = false
      }
      return currentPosition
    },
    Promise.resolve({ points: 0, areAllOrdersCompleted: true })
  )
  totalPoints.points = round(totalPoints.points)
  let dbData: any = null
  try {
    dbData = await getValuesfromDB(initialJobData.id!)
    dbData.lastTargetAt = dayjs().toDate()
    dbData.currentPoints = totalPoints.points
    logger.info(`[targetPnL] Current points for ${orderTag}: ${dbData.currentPoints}`)
  } catch (error) {
    logger.error("[targetPnL]error in patchDbTrade", error)
  }
  if (totalPoints.areAllOrdersCompleted) {
    logger.info(`[targetPnL] ${orderTag} all orders are completed — setting SQUARED_OFF`)
    await patchDbTrade(initialJobData.id!, {
      status: JOB_EXECUTION_STATUS.SQUARED_OFF,
      lastTargetAt: dbData?.lastTargetAt,
      currentPoints: String(dbData?.currentPoints ?? totalPoints.points),
    })
    return Promise.resolve("[targetPnL] all orders are completed")
  } else if (isMaxProfitEnabled && totalPoints.points > dbData.trailingMaxProfitPoints!) {

    const trailingProfitMultiplier = 1 + (trailingProfitPercent || 10) / 100
    const newTrailingMaxProfitPoints = round(
      trailingProfitMultiplier * dbData.trailingMaxProfitPoints!,0.1
    )
    await patchDbTrade(initialJobData.id!, {
      lastTargetAt: dbData.lastTargetAt,
      currentPoints: String(dbData.currentPoints),
      trailingMaxLossPoints: String(dbData.trailingMaxProfitPoints),
      trailingMaxProfitPoints: String(newTrailingMaxProfitPoints),
    })
    dbData.trailingMaxLossPoints = dbData.trailingMaxProfitPoints
    dbData.trailingMaxProfitPoints = newTrailingMaxProfitPoints

    // try{
    //     await squareOffTag(orderTag!, kite)
    // }
    // catch (error) {
    //   console.log('[targetPnL]error in squaring Off', error)

    // }
    return Promise.reject(
      new Error(
        `[targetPnL] Updated with new profit ${dbData.trailingMaxProfitPoints} and SL ${dbData.trailingMaxLossPoints}`
      )
    )
    //Square off the tag
  } else if (isMaxLossEnabled && totalPoints.points < dbData.trailingMaxLossPoints!) {
    logger.info(`[targetPnL]squaring Off as loss is breached ${dbData.trailingMaxLossPoints}`)
    await patchDbTrade(initialJobData.id!, {
      lastTargetAt: dbData.lastTargetAt,
      currentPoints: String(dbData.currentPoints),
    })
    try {
      await squareOffTag(orderTag!, kite)
    } catch (error) {
      logger.error("[targetPnL]error in squaring Off", error)
    }
    return Promise.resolve("[targetPnL] orders are squared off as loss has been breached")
    //Square off the tag
  } else {
    await patchDbTrade(initialJobData.id!, {
      lastTargetAt: dbData.lastTargetAt,
      currentPoints: String(dbData.currentPoints),
    })
    const rejectMsg = `🟢[targetPnL] retry for tag: ${orderTag} Points: ${totalPoints.points} `
    return Promise.reject(new Error(rejectMsg))
  }
}
export default targetPnL
