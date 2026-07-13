require("dotenv").config()

const express = require("express")
const { createBullBoard } = require("@bull-board/api")
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter")
const { ExpressAdapter } = require("@bull-board/express")
const { Queue } = require("bullmq")
const IORedis = require("ioredis")

const redisUrl = process.env.REDIS_URL
const QID = process.env.KITE_API_KEY

if (!redisUrl || !QID) {
  console.error("Missing REDIS_URL or KITE_API_KEY in .env")
  process.exit(1)
}

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null })

const queues = [
  `tradingQueue_${QID}`,
  `exitTradingQueue_${QID}`,
  `autoSquareOffQueue_${QID}`,
  `ancillaryQueue_${QID}`,
  `targetPnlQueue_${QID}`,
].map(name => new Queue(name, { connection }))

const serverAdapter = new ExpressAdapter()
serverAdapter.setBasePath("/queues")

createBullBoard({
  queues: queues.map(q => new BullMQAdapter(q)),
  serverAdapter,
})

const app = express()
app.use("/queues", serverAdapter.getRouter())

const PORT = process.env.BULL_BOARD_PORT || 3001
app.listen(PORT, () => {
  console.log(`Bull Board running at http://localhost:${PORT}/queues`)
})
