import type { NextApiRequest, NextApiResponse } from "next"
import logger from "../../lib/logger"

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  logger.info("[health] Health check — service=kha-ching status=ok")
  res.status(200).json({
    status: "ok",
    service: "kha-ching",
    timestamp: new Date().toISOString(),
  })
}
