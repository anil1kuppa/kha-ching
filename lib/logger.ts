import { OpenTelemetryTransportV3 } from "@opentelemetry/winston-transport"
import { createLogger, format, transports } from "winston"

const formatMeta = meta => {
  const splat = meta[Symbol.for("splat")]
  if (splat && splat.length) {
    return splat.length === 1 ? JSON.stringify(splat[0]) : JSON.stringify(splat)
  }
  return ""
}

const customFormat = format.printf(
  ({ timestamp, level, message, ...meta }) =>
    `[${timestamp}] ${level} ${message} ${formatMeta(meta)}`
)

// Folds splat args into message so the OTEL transport includes them in the log body.
const splatIntoMessage = format(info => {
  const splat = (info as any)[Symbol.for("splat")]
  if (splat?.length) {
    const extras = splat
      .map((s: any) => (typeof s === "object" ? JSON.stringify(s) : String(s)))
      .join(" ")
    info.message = `${info.message} ${extras}`
  }
  return info
})()

const logger = createLogger({
  transports: [
    new transports.Console(),
    new OpenTelemetryTransportV3({ format: format.combine(splatIntoMessage) }),
  ],
  format: format.combine(
    format.splat(),
    format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss" }),
    customFormat
  ),
})

export default logger
