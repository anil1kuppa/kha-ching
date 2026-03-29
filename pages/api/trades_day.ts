import dayjs from 'dayjs'
import { pick } from 'lodash'
import { customAlphabet } from 'nanoid'

import { tradingQueue, addToNextQueue, TRADING_Q_NAME } from '../../lib/queue'
import { queryOne, insertOne, updateRows, deleteRows, queryAll } from '../../lib/dbUtils'

import { ERROR_STRINGS, STRATEGIES_DETAILS } from '../../lib/constants'
import console from '../../lib/logging'

import withSession from '../../lib/session'
import {
  isMarketOpen,
  isMockOrder,
  logDeep
} from '../../lib/utils'
import { SUPPORTED_TRADE_CONFIG } from '../../types/trade'
import { SignalXUser } from '../../types/misc'

const nanoid = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  8
)

async function createJob ({
  jobData,
  user
}: {
  jobData: SUPPORTED_TRADE_CONFIG
  user: SignalXUser
}) {
  const { runAt, runNow, strategy } = jobData
 

  // if (!isMockOrder() && runNow && !isMarketOpen()) {
  //   return Promise.reject(new Error('Exchange is offline right now.'))
  // }

  if (!isMockOrder() && !runNow && runAt && !isMarketOpen(dayjs(runAt))) {
    return Promise.reject(
      new Error('Exchange would be offline at the scheduled time.')
    )
  }

  return addToNextQueue(
    {
      ...jobData,
      user
    },
    {
      _nextTradingQueue: TRADING_Q_NAME
    }
  )
}

async function deleteJob (id) {
  try {
    if (id.includes('repeat')) {
      await tradingQueue.removeRepeatableByKey(id)
    } else {
      const job = await tradingQueue.getJob(id)
      job && (await job.remove())
    }
  } catch (e) {
    console.log('🔴 [deleteJob] failed', e)
    return Promise.reject(e)
  }
}

export default withSession(async (req, res) => {
  const user = req.session.get('user')

  if (!user) {
    return res.status(401).end()
  }

  if (req.method === 'POST') {
    let executionData: any
    const orderTag = nanoid()
    try {
      logDeep(req.body)
      // Create job execution entry from the trade plan
      const postData = {
        ...req.body,
        order_tag: orderTag,
        status: 'PENDING',
        created_at: new Date()
      }

      const result = await insertOne('job_executions', postData)
      if (!result) {
        throw new Error('Failed to insert job execution')
      }
      executionData = result
      console.log(`[trades_day] ${executionData.id} created in job_executions`)
    } catch (e) {
      console.log('🔴 failed to post', e)
      return res.status(500).json({ error: e?.message })
    }

    try {
      // Create the queue entry
      const qRes = await createJob({
        jobData: { ...executionData, orderTag },
        user
      })

      // Update with queue info and status
      const queueInfo = pick(qRes, [
        'id',
        'name',
        'opts',
        'timestamp',
        'stacktrace',
        'returnvalue'
      ])

      await updateRows(
        'job_executions',
        {
          status: 'QUEUE',
          queue: JSON.stringify(queueInfo)
        },
        'id = $1',
        [executionData.id]
      )

      return res.json(executionData)
    } catch (e) {
      console.log('🔴 job creation failed', e)
      await updateRows(
        'job_executions',
        {
          status: 'REJECT',
          queue: JSON.stringify({ error: e?.message })
        },
        'id = $1',
        [executionData.id]
      )

      return res.json(executionData)
    }
  }

  if (req.method === 'DELETE') {
    try {
      const jobId = req.body.id as string
      const execution = await queryOne(
        'SELECT queue FROM job_executions WHERE id = $1',
        [jobId]
      )

      if (execution?.queue) {
        const queueInfo = typeof execution.queue === 'string'
          ? JSON.parse(execution.queue)
          : execution.queue
        if (queueInfo?.id) {
          await deleteJob(queueInfo.id)
        }
      }

      await deleteRows('job_executions', 'id = $1', [jobId])
      return res.end()
    } catch (e) {
      console.log('🔴 failed to delete', e)
      return res.status(500).json({ error: e?.message })
    }
  }

  if (req.method === 'PUT') {
    try {
      const { id, ...props } = req.body
      await updateRows('job_executions', props, 'id = $1', [id])
      return res.end()
    } catch (e) {
      console.log('🔴 failed to put', e)
      return res.status(500).json({ error: e?.message })
    }
  }

  if (req.method === 'GET') {
    try {
      const today = dayjs().format('YYYY-MM-DD')
      const results = await queryAll(
        'SELECT * FROM job_executions WHERE DATE(created_at) >= $1 ORDER BY created_at DESC',
        [today]
      )
      return res.json(results)
    } catch (e) {
      console.log('🔴 failed to get', e)
      return res.status(500).json({ error: e?.message })
    }
  }

  res.status(400).end()
})
