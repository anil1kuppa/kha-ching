import dayjs from "dayjs"
import { COMBINED_SL_EXIT_STRATEGY, SL_ORDER_TYPE } from "../types/plans"
import { chaseStatusEnum } from "./schema"

const NEXT_PUBLIC_DEFAULT_LOTS = process.env.NEXT_PUBLIC_DEFAULT_LOTS
const NEXT_PUBLIC_DEFAULT_SKEW_PERCENT = process.env.NEXT_PUBLIC_DEFAULT_SKEW_PERCENT
const NEXT_PUBLIC_DEFAULT_SLM_PERCENT = process.env.NEXT_PUBLIC_DEFAULT_SLM_PERCENT

export enum INSTRUMENTS {
  NIFTY = "NIFTY",
  BANKNIFTY = "BANKNIFTY",
  FINNIFTY = "FINNIFTY",
}

export const CHASE_STATUS = Object.fromEntries(
  chaseStatusEnum.enumValues.map(v => [v, v])
) as { [K in (typeof chaseStatusEnum.enumValues)[number]]: K }

export enum TRANSACTION_TYPE {
  BUY = "BUY",
  SELL = "SELL",
}

export interface INSTRUMENT_PROPERTIES {
  lotSize: number
  displayName: string
  underlyingSymbol: string
  nfoSymbol: string
  exchange: string
  strikeStepSize: number
  freezeQty: number
}

export interface COMPLETED_BY_TAG {
  tradingsymbol: string // "NIFTY21OCT17350CE"
  quantity: number //-ve if sell , +ve if buy
  points: number // sell -buy
}

export const INSTRUMENT_DETAILS: Record<INSTRUMENTS, INSTRUMENT_PROPERTIES> = {
  [INSTRUMENTS.NIFTY]: {
    lotSize: 25,
    displayName: "NIFTY",
    underlyingSymbol: "NIFTY 50",
    nfoSymbol: "NIFTY",
    exchange: "NSE",
    strikeStepSize: 50,
    freezeQty: 1800,
  },
  [INSTRUMENTS.BANKNIFTY]: {
    lotSize: 15,
    displayName: "BANKNIFTY",
    underlyingSymbol: "NIFTY BANK",
    nfoSymbol: "BANKNIFTY",
    exchange: "NSE",
    strikeStepSize: 100,
    freezeQty: 900,
  },
  [INSTRUMENTS.FINNIFTY]: {
    lotSize: 25,
    displayName: "FINNIFTY",
    underlyingSymbol: "NIFTY FIN SERVICE",
    nfoSymbol: "FINNIFTY",
    exchange: "NSE",
    strikeStepSize: 100,
    freezeQty: 1800,
  },
}

export enum STRATEGIES {
  ATM_STRADDLE = "ATM_STRADDLE",
  ATM_STRANGLE = "ATM_STRANGLE",
  SUBSCRIBE_CHASE = "SUBSCRIBE_CHASE",
}

export enum EXIT_STRATEGIES {
  INDIVIDUAL_LEG_SLM_1X = "INDIVIDUAL_LEG_SLM_1X",
  MULTI_LEG_PREMIUM_THRESHOLD = "MULTI_LEG_PREMIUM_THRESHOLD",
  MIN_XPERCENT_OR_SUPERTREND = "MIN_XPERCENT_OR_SUPERTREND",
  OBS_TRAIL_SL = "OBS_TRAIL_SL",
  NO_SL = "NO_SL",
}

export enum ENTRY_ORDER {
  MARKET_ORDER = "MARKET_ORDER",
  STOP_LOSS_MARKET_ORDER = "STOP_LOSS_MARKET_ORDER",
}

export enum PRODUCT_TYPE {
  MIS = "MIS",
  NRML = "NRML",
}

export enum VOLATILITY_TYPE {
  LONG = "LONG",
  SHORT = "SHORT",
}

export enum EXPIRY_TYPE {
  CURRENT = "CURRENT",
  NEXT = "NEXT",
  MONTHLY = "MONTHLY",
}

export const EXPIRY_TYPE_HUMAN = {
  [EXPIRY_TYPE.CURRENT]: "Current weekly",
  [EXPIRY_TYPE.NEXT]: "Next weekly",
  [EXPIRY_TYPE.MONTHLY]: "Current Monthly",
}

export enum STRANGLE_ENTRY_STRATEGIES {
  DISTANCE_FROM_ATM = "DISTANCE_FROM_ATM",
  PERCENT_FROM_ATM = "PERCENT_FROM_ATM",
  ENTRY_PRICE = "ENTRY_PRICE",
}
export enum ANCILLARY_TASKS {
  ORDERBOOK_SYNC_BY_TAG = "ORDERBOOK_SYNC_BY_TAG",
  CLEANUP_COMPLETED_JOBS = "CLEANUP_COMPLETED_JOBS",
  ORDERBOOKSYNC = "ORDERBOOKSYNC",
}

export enum JOB_EXECUTION_STATUS {
  PENDING = "PENDING", // Initial state when job execution record is created
  QUEUE = "QUEUE", // Job successfully added to BullMQ queue
  EXECUTING = "EXECUTING", // Job is currently being processed
  COMPLETED = "COMPLETED", // Entry orders placed successfully
  FAILED = "FAILED", // Job execution failed
  REJECT = "REJECT", // Failed to add job to queue
  CANCELLED = "CANCELLED", // Job was manually cancelled
  SQUARED_OFF = "SQUARED_OFF", // Both legs fully squared off
}

export const COMBINED_SL_EXIT_STRATEGY_LABEL = {
  [COMBINED_SL_EXIT_STRATEGY.EXIT_ALL]: "Exit all legs",
  [COMBINED_SL_EXIT_STRATEGY.EXIT_LOSING]: "Exit losing legs only and bring others to cost",
}

const getInstrumentsDefaultState = (): Record<INSTRUMENTS, boolean> =>
  Object.values(INSTRUMENTS).reduce<Record<string, boolean>>(
    (accum, item) => ({
      ...accum,
      [item]: false,
    }),
    {}
  )

export const STRATEGIES_DETAILS = {
  [STRATEGIES.ATM_STRADDLE]: {
    premium: false,
    heading: "Long/Short Straddle — ATM",
    defaultRunAt: dayjs().set("hour", 12).set("minutes", 20).set("seconds", 0).format(),
    margin1x: {
      [INSTRUMENTS.NIFTY]: 145000,
      [INSTRUMENTS.BANKNIFTY]: 150000,
      [INSTRUMENTS.FINNIFTY]: 100000,
    },
    defaultFormState: {
      instruments: getInstrumentsDefaultState(),
      lots: NEXT_PUBLIC_DEFAULT_LOTS,
      maxSkewPercent: NEXT_PUBLIC_DEFAULT_SKEW_PERCENT,
      thresholdSkewPercent: 20,
      takeTradeIrrespectiveSkew: false,
      slmPercent: NEXT_PUBLIC_DEFAULT_SLM_PERCENT,
      trailEveryPercentageChangeValue: 2,
      trailingSlPercent: NEXT_PUBLIC_DEFAULT_SLM_PERCENT,
      productType: PRODUCT_TYPE.MIS,
      volatilityType: VOLATILITY_TYPE.SHORT,
      expiryType: EXPIRY_TYPE.CURRENT,
      runNow: false,
      isMaxLossEnabled: true,
      trailingMaxLossPoints: -18,
      isMaxProfitEnabled: true,
      trailingMaxProfitPoints: 12,
      trailingProfitPercent: 10,
      maxLossPoints: 20,
      maxProfitPoints: 20,
      expireIfUnsuccessfulInMins: 10,
      exitStrategy: EXIT_STRATEGIES.INDIVIDUAL_LEG_SLM_1X,
      slOrderType: SL_ORDER_TYPE.SLL,
      slLimitPricePercent: 1,
      combinedExitStrategy: COMBINED_SL_EXIT_STRATEGY.EXIT_ALL,
      rollback: {
        onBrokenHedgeOrders: false,
        onBrokenPrimaryOrders: false,
        onBrokenExitOrders: false,
      },
    },
  },
  [STRATEGIES.ATM_STRANGLE]: {
    premium: false,
    heading: "Long/Short Strangle",
    defaultRunAt: dayjs().set("hour", 12).set("minutes", 20).set("seconds", 0).format(),
    margin1x: {
      [INSTRUMENTS.NIFTY]: 420000,
      [INSTRUMENTS.BANKNIFTY]: 425000,
    },
    defaultFormState: {
      instruments: getInstrumentsDefaultState(),
      lots: NEXT_PUBLIC_DEFAULT_LOTS,
      slmPercent: NEXT_PUBLIC_DEFAULT_SLM_PERCENT,
      trailEveryPercentageChangeValue: 2,
      trailingSlPercent: NEXT_PUBLIC_DEFAULT_SLM_PERCENT,
      inverted: false,
      entryStrategy: STRANGLE_ENTRY_STRATEGIES.DISTANCE_FROM_ATM,
      distanceFromAtm: 1,
      optionPrice: 20,
      productType: PRODUCT_TYPE.MIS,
      volatilityType: VOLATILITY_TYPE.SHORT,
      expiryType: EXPIRY_TYPE.CURRENT,
      runNow: false,
      exitStrategy: EXIT_STRATEGIES.NO_SL,
      orderType: ENTRY_ORDER.MARKET_ORDER,
      slOrderType: SL_ORDER_TYPE.SLL,
      slLimitPricePercent: 1,
      combinedExitStrategy: COMBINED_SL_EXIT_STRATEGY.EXIT_ALL,
      rollback: {
        onBrokenHedgeOrders: false,
        onBrokenPrimaryOrders: false,
        onBrokenExitOrders: false,
      },
    },
    ENTRY_STRATEGIES: STRANGLE_ENTRY_STRATEGIES,
    ENTRY_STRATEGY_DETAILS: {
      [STRANGLE_ENTRY_STRATEGIES.DISTANCE_FROM_ATM]: {
        label: "by distance from ATM strike",
      },
      [STRANGLE_ENTRY_STRATEGIES.PERCENT_FROM_ATM]: {
        label: "by percent from ATM%",
      },
      [STRANGLE_ENTRY_STRATEGIES.ENTRY_PRICE]: {
        label: "by option price",
      },
    },
    ENTRY_ORDER: {
      [ENTRY_ORDER.MARKET_ORDER]: {
        label: "Market Order",
      },
      [ENTRY_ORDER.STOP_LOSS_MARKET_ORDER]: {
        label: "Stop Loss Market/Limit Order",
      },
    },
  },
  [STRATEGIES.SUBSCRIBE_CHASE]: {
    heading: "Chase",
    defaultRunAt: dayjs().set("hour", 9).set("minutes", 16).set("seconds", 0).format(),
    defaultFormState: {
      lots: 1,
    },
  },
}

export const ROLLBACK_KEY_MAP = {
  onBrokenHedgeOrders: "If taking the hedge position fails",
  onBrokenPrimaryOrders: "If taking the primary position fails",
  onBrokenExitOrders: "If placing any SL order fail",
}

export const EXIT_STRATEGIES_DETAILS = {
  [EXIT_STRATEGIES.INDIVIDUAL_LEG_SLM_1X]: {
    label: "Fixed SL% on all legs",
  },
  [EXIT_STRATEGIES.MULTI_LEG_PREMIUM_THRESHOLD]: {
    label: "Combined/trailing SL%",
  },
  [EXIT_STRATEGIES.MIN_XPERCENT_OR_SUPERTREND]: {
    label: "Initial SL%, then trail Option Supertrend",
  },
  [EXIT_STRATEGIES.OBS_TRAIL_SL]: {
    label: "Initial 30%, then trail SL on every higher close (1min TF)",
  },
  [EXIT_STRATEGIES.NO_SL]: {
    label: "No SL",
  },
}

export const WATCHERS = {
  SLM_WATCHER: "SLM_WATCHER",
}

export const WATCHERS_DETAILS = {
  [WATCHERS.SLM_WATCHER]: {
    label: 'Ensure order even if SL-M gets "Cancelled"',
  },
}

export const MAX_MIS_ORDER_DURATION_SECONDS = 6 * 60 * 60 // [9.15am, 3.15pm]

export const USER_OVERRIDE = {
  ABORT: "ABORT",
  RESUME: "RESUME",
}

export const ERROR_STRINGS = {
  PAID_FEATURE: "Invalid SignalX Club or Premium subscription",
  PAID_STRATEGY: "Invalid SignalX Club or Premium subscription",
}

export const SUBSCRIPTION_TYPE = {
  SUBSCRIBER: "SUBSCRIBER",
  NOT_SUBSCRIBER: "NOT_SUBSCRIBER",
}

export const SUBSCRIBER_TYPE = {
  PREMIUM: "PREMIUM",
  CLUB: "CLUB",
}

export const ACCESSTOKEN = "accessToken"
export const TRADES = "trades"

export const STATUS_TRIGGER_PENDING = "TRIGGER PENDING" as const
