//import { AxiosResponse } from 'axios'
import { KiteConnect, type SessionData } from "kiteconnect"
import {
  addToAncillaryQueue,
  cleanupQueues,
  addToCoSquareOff,
  addToChaseQueue,
} from "../../lib/queue"

import withSession from "../../lib/session"
import { logDeep, storeAccessTokenRemotely } from "../../lib/utils"
import { getIndexInstruments } from "../../lib/kiteUtils"
import { storeAccessToken, checksameToken } from "../../lib/drizzleDbUtils"
import { SignalXUser } from "../../types/misc"
import logger from "../../lib/logger"

const apiKey = process.env.KITE_API_KEY!
const kiteSecret = process.env.KITE_API_SECRET!
const kc = new KiteConnect({
  api_key: apiKey,
})

export default withSession(async (req, res) => {
  const rawToken = req.query.request_token
  const requestToken = Array.isArray(rawToken) ? rawToken[0] : rawToken

  if (!requestToken) {
    return res.status(401).send("Unauthorized")
  }
  logger.info("[redirect_url_kite_logger] Logging in..")

  try {
    const sessionData: SessionData = await kc.generateSession(requestToken, kiteSecret)
    const user: SignalXUser = { isLoggedIn: true, session: sessionData }
    req.session.set("user", user)
    await req.session.save()

    getIndexInstruments().catch(e => {
      logger.error("getIndexInstruments error", e)
    })

    const existingAccessToken = await checksameToken(user.session.access_token!)
    if (!existingAccessToken) {
      // first login, or revoked login
      // cleanup queue in both cases
      logger.info("[redirect_url_kite_logger] cleaning up queues...")
      // cleanupQueues().catch(e => {
      //   console.log(e)
      // })
      await cleanupQueues()
      addToAncillaryQueue(user)
      addToCoSquareOff(user)
      await addToChaseQueue(user)
      // register chase queue repeatable jobs
      //storeAccessTokenRemotely(user.session.access_token!)
      await storeAccessToken(user.session.access_token!)
    }

    // then redirect
    res.redirect("/dashboard")
  } catch (error: any) {
    const fetchResponse = error?.response
    res.status(fetchResponse?.status || 500).json(error?.data)
  }
})
