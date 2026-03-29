import dayjs from 'dayjs'
import withSession from '../../lib/session'
import { syncGetKiteInstance, withRemoteRetry, getCompletedOrdersbyTag } from '../../lib/utils'
import advancedFormat from 'dayjs/plugin/advancedFormat'
dayjs.extend(advancedFormat)

export default withSession(async (req, res) => {
  const user = req.session.get('user')

  if (!user) {
    return res.status(401).send('Unauthorized')
  }

  try {
    const { order_tag: orderTag } = req.query

    if (!orderTag) {
      return res.status(400).json({ error: 'expected orderTag in query' })
    }

    const day330 = dayjs()
      .set('hour', 15)
      .set('minutes', 30)
      .set('seconds', 0)
      .format()

    if (dayjs().isBefore(dayjs(day330))) {
      return res.json({ error: 'PnL not ready yet!' })
    }

    // Calculate PnL from Kite orders
    const kite = syncGetKiteInstance(user)
    const allOrders = await withRemoteRetry(() => kite.getOrders())
    const taggedOrders = allOrders.filter(order => order.tag === orderTag && order.status === 'COMPLETE')

    if (taggedOrders.length === 0) {
      return res.json({ error: 'No completed orders found for tag' })
    }

    // Calculate PnL: sum of all (quantity * average_price) for sells - buys
    let buyTotal = 0
    let sellTotal = 0

    for (const order of taggedOrders) {
      const value = (order.quantity || 0) * (order.average_price || 0)
      if (order.transaction_type === 'BUY') {
        buyTotal += value
      } else if (order.transaction_type === 'SELL') {
        sellTotal += value
      }
    }

    const pnl = sellTotal - buyTotal
    res.json({ pnl: pnl })
  } catch (e) {
    console.error('[api/pnl] error', e)
    res.status(500).json({ error: e.message })
  }
})
