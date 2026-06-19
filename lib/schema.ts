import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm/sql"

export const jobExecutionStatusEnum = pgEnum("job_execution_status", [
  "PENDING",
  "QUEUE",
  "EXECUTING",
  "COMPLETED",
  "FAILED",
  "REJECT",
  "CANCELLED",
  "SQUARED_OFF",
])

export const dayOfWeekEnum = pgEnum("day_of_week_enum", [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
])

export const chaseStatusEnum = pgEnum("chase_status_type", [
  "SHORT",
  "LONG",
  "AWAITING_SHORT",
  "AWAITING_LONG",
  "AWAITING_SIGNAL",
])

export const jobExecutionStrategyEnum = pgEnum("job_execution_strategy", [
  "ATM_STRADDLE",
  "ATM_STRANGLE",
  "SUBSCRIBE_CHASE",
])

export const jobExecutions = pgTable("job_executions", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  name: text("name"),
  status: jobExecutionStatusEnum("status"),
  instrument: text("instrument"),
  strategy: jobExecutionStrategyEnum("strategy"),
  exitStrategy: text("exit_strategy"),
  combinedExitStrategy: text("combined_exit_strategy"),
  expiryType: text("expiry_type"),
  productType: text("product_type"),
  volatilityType: text("volatility_type"),
  slOrderType: text("sl_order_type"),
  orderTag: text("order_tag"),
  lots: smallint("lots"),
  slmPercent: numeric("slm_percent"),
  slLimitPricePercent: numeric("sl_limit_price_percent"),
  maxProfitPoints: numeric("max_profit_points"),
  maxLossPoints: numeric("max_loss_points"),
  currentPoints: numeric("current_points"),
  trailingSlPercent: numeric("trailing_sl_percent"),
  trailingMaxProfitPoints: numeric("trailing_max_profit_points"),
  trailingMaxLossPoints: numeric("trailing_max_loss_points"),
  trailEveryPctChangeValue: numeric("trail_every_pct_change_value"),
  thresholdSkewPercent: numeric("threshold_skew_percent"),
  maxSkewPercent: numeric("max_skew_percent"),
  expireIfUnsuccessfulInMins: smallint("expire_if_unsuccessful_in_mins"),
  isMaxProfitEnabled: boolean("is_max_profit_enabled").default(false),
  isMaxLossEnabled: boolean("is_max_loss_enabled").default(false),
  isAutoSquareOffEnabled: boolean("is_auto_square_off_enabled").default(false),
  takeTradeIrrespectiveSkew: boolean("take_trade_irrespective_skew").default(false),
  onSquareOffSetAborted: boolean("on_square_off_set_aborted").default(false),
  runNow: boolean("run_now").default(false),
  squareOffTime: timestamp("square_off_time", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  runAt: timestamp("run_at", { withTimezone: true }),
  lastTargetAt: timestamp("last_target_at", { withTimezone: true }),
  lastModified: timestamp("last_modified", { withTimezone: true }),
  autoSquareOffProps: jsonb("auto_square_off_props"),
  queue: jsonb("queue"),
  autoSquareOffTime: timestamp("auto_square_off_time", { withTimezone: true }),
  autoSquareOffDeletePendingOrders: boolean("auto_square_off_delete_pending_orders").default(false),
  dayOfWeek: dayOfWeekEnum("day_of_week"),
  trailEveryPercentageChangeValue: smallint("trail_every_percentage_change_value"),
  planRef: text("plan_ref").references(() => tradePlans.id),
  userOverride: text("user_override"),
  liveTrailingSl: numeric("live_trailing_sl"),
  lastTrailingSlSetAt: timestamp("last_trailing_sl_set_at", { withTimezone: true }),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
})

export const tradePlans = pgTable("trade_plans", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  strategy: jobExecutionStrategyEnum("strategy").notNull(),
  instrument: text("instrument").notNull(),
  expiryType: text("expiry_type").notNull(),
  productType: text("product_type").notNull(),
  dayOfWeek: dayOfWeekEnum("day_of_week"),
  exitStrategy: text("exit_strategy"),
  combinedExitStrategy: text("combined_exit_strategy"),
  runAt: timestamp("run_at", { withTimezone: true }),
  squareOffTime: timestamp("square_off_time", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  expireIfUnsuccessfulInMins: integer("expire_if_unsuccessful_in_mins"),
  lots: integer("lots").notNull(),
  slmPercent: smallint("slm_percent"),
  slOrderType: text("sl_order_type"),
  slLimitPricePercent: smallint("sl_limit_price_percent"),
  maxProfitPoints: smallint("max_profit_points"),
  isMaxProfitEnabled: boolean("is_max_profit_enabled").default(false),
  maxLossPoints: smallint("max_loss_points"),
  isMaxLossEnabled: boolean("is_max_loss_enabled").default(false),
  thresholdSkewPercent: smallint("threshold_skew_percent"),
  maxSkewPercent: smallint("max_skew_percent"),
  takeTradeIrrespectiveSkew: boolean("take_trade_irrespective_skew").default(false),
  volatilityType: text("volatility_type"),
  trailEveryPercentageChangeValue: smallint("trail_every_percentage_change_value"),
  trailingSlPercent: smallint("trailing_sl_percent"),
  trailingMaxProfitPoints: smallint("trailing_max_profit_points"),
  trailingMaxLossPoints: smallint("trailing_max_loss_points"),
  isAutoSquareOffEnabled: boolean("is_auto_square_off_enabled").default(false),
  autoSquareOffTime: timestamp("auto_square_off_time", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_trade_plans_created_at").on(table.createdAt),
  index("idx_trade_plans_instrument").on(table.instrument),
  index("idx_trade_plans_strategy").on(table.strategy),
])

export const ema = pgTable("ema", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  tradingsymbol: text("tradingsymbol").notNull(),
  ema: integer("ema"),
  instrumentToken: integer("instrument_token"),
  highestHigh: integer("highest_high"),
  lowestLow: integer("lowest_low"),
  lastClose: integer("last_close"),
})

export const chaseStatus = pgTable("chase_status", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("last_modified_at", { withTimezone: true }).defaultNow(),
  status: chaseStatusEnum("current_status"),
  tradingsymbol: text("tradingsymbol"),
  instrumentToken: integer("instrument_token"),
  stoploss: integer("stoploss"),
  entryPoint: integer("entry_point"),
  isSignalBreachingTolerance: boolean("is_signal_breaching_tolerance")
})


export const chaseLog = pgTable("chase_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  tradingsymbol: text("tradingsymbol").notNull(),
  transactionType: text("transaction_type").notNull(),
  averagePrice: numeric("average_price"),
})

export const accesstoken = pgTable("accesstoken", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  accessToken: text("access_token").notNull(),
})

export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  orderTimestamp: timestamp("order_timestamp"),
  exchange: text("exchange"),
  tradingsymbol: text("tradingsymbol"),
  instrumentToken: integer("instrument_token"),
  transactionType: text("transaction_type"),
  quantity: integer("quantity"),
  averagePrice: numeric("average_price"),
  tag: text("tag"),
  orderId: text("order_id"),
  variety: text("variety"),
  orderType: text("order_type"),
  product: text("product"),
})
