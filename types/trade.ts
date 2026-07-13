import type { ANCILLARY_TASKS } from "../lib/constants"
import type { DBMeta, SignalXUser } from "./misc"
import type { ATM_STRADDLE_CONFIG, ATM_STRANGLE_CONFIG, SUBSCRIBE_CHASE_CONFIG } from "./plans"

export interface TradeMeta extends DBMeta {
  collection?: string
  day_of_week?: string
  dayOfWeek?: string
  isAutoSquareOffEnabled: boolean
  runNow?: boolean
  runAt?: string
  squareOffTime: string | undefined
  autoSquareOffProps?: { time: string; deletePendingOrders: boolean }
  expiresAt?: string
  _kite?: unknown // this is only used in jest for unit tests
  user?: SignalXUser // this is only available once job has been created on server
  orderTag?: string // this is only available once job has been created on server
  _nextTradingQueue?: string
  ancillaryTask?: ANCILLARY_TASKS
}

export interface ATM_STRADDLE_TRADE extends TradeMeta, ATM_STRADDLE_CONFIG {}
export interface ATM_STRANGLE_TRADE extends TradeMeta, ATM_STRANGLE_CONFIG {}
export interface SUBSCRIBE_CHASE_TRADE extends TradeMeta, SUBSCRIBE_CHASE_CONFIG {}

export type SUPPORTED_TRADE_CONFIG = ATM_STRADDLE_TRADE | ATM_STRANGLE_TRADE | SUBSCRIBE_CHASE_TRADE
