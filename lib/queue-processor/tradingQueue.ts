import { Job, Worker } from 'bullmq'
// import { omit } from 'lodash'

import { STRATEGIES } from '../constants'
import console from '../logging'
import { addToAutoSquareOffQueue,
  addToNextQueue, redisConnection, TARGETPNL_Q_NAME, TRADING_Q_NAME
} from '../queue'
import atmStraddle from '../strategies/atmStraddle'
import directionalOptionSelling from '../strategies/directionalOptionSelling'
import optionBuyingStrategy from '../strategies/optionBuyingStrategy'
import overnightTrend from '../strategies/overnightTrend'
import strangle from '../strategies/strangle'
import { getCustomBackoffStrategies, logDeep, ms } from '../utils'

async function processJob (job: Job) {
  const {
    data,
    data: { strategy }
  } = job
  console.log(`[tradingQueue] Beginning job processing for ${strategy}`)
  switch (strategy) {
    case STRATEGIES.ATM_STRADDLE: {
      return atmStraddle(data)
    }
    case STRATEGIES.ATM_STRANGLE: {
      return strangle(data)
    }
    case STRATEGIES.DIRECTIONAL_OPTION_SELLING: {
      return directionalOptionSelling(data)
    }
    case STRATEGIES.OPTION_BUYING_STRATEGY: {
      return optionBuyingStrategy(data)
    }
    case STRATEGIES.OVERNIGHT_TREND_STATEGY: {
      return overnightTrend(data)
    }
    default: {
      return null
    }
  }
}

const worker = new Worker(
  TRADING_Q_NAME,
  async job => {
    // console.log(`processing tradingQueue id ${job.id}`, omit(job.data, ['user']))
    const result = await processJob(job)
    // console.log(`processed tradingQueue id ${job.id}`, result)
    const { isAutoSquareOffEnabled, strategy } = job.data
    // can't enable auto square off for DOS
    // because we don't know upfront how many orders would get punched
    if (
      strategy !== STRATEGIES.DIRECTIONAL_OPTION_SELLING &&
      isAutoSquareOffEnabled
    ) {
      try {
        // console.log('enabling auto square off...')
        const asoResponse = await addToAutoSquareOffQueue({
          //eslint-disable-line
          initialJobData: job.data,
          jobResponse: result
        })
        // const { data, name } = asoResponse
        // console.log('🟢 success enable auto square off', { data, name })
      } catch (e) {
        console.log('🔴 failed to enable auto square off', e)
      }
    }
    return result
  },
  {
    connection: redisConnection,
    concurrency: 20,
    settings: {
      backoffStrategies: getCustomBackoffStrategies()
    },
    lockDuration: ms(5 * 60)
  }
)

worker.on('completed', job => {
  const { data, returnvalue } = job
  try {
    logDeep(returnvalue);
    // console.log(`[tradingQueue] worker is completed ${job.returnvalue}`)
    if (job.returnvalue?._nextTradingQueue) {
      addToNextQueue(data, returnvalue) //adds SL orders
    }
    if (returnvalue?.isTargetEnabled)
    {
      const targetreturn={...returnvalue,_nextTradingQueue:TARGETPNL_Q_NAME}
      addToNextQueue(data, targetreturn) //keeps checking if target is reached.
    }
  } catch (e) {
    console.log('job return value', job.returnvalue)
    console.log('failed inside trading queue worked completed event!', e)
  }
})

worker.on('failed', err => {
  // log the error
  console.log('🔴 [tradingQueue] worker error', err)
})
