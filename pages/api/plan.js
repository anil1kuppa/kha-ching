import { withoutFwdSlash } from '../../lib/utils'
import { queryAll, insertOne, updateRows, deleteRows } from '../../lib/dbUtils'

export default async function plan (req, res) {
  const { dayOfWeek, config } = req.body
  try {
    if (req.method === 'POST') {
      // Insert new trade plan(s)
      const results = []
      for (const planConfig of config) {
        const result = await insertOne('trade_plans', {
          collection: dayOfWeek,
          config: JSON.stringify(planConfig)
        })
        if (result) {
          results.push({ ...planConfig, id: result.id })
        }
      }
      return res.json(results[0] || {})
    }

    if (req.method === 'PUT') {
      // Update existing trade plan
      await updateRows(
        'trade_plans',
        { config: JSON.stringify(config) },
        'id = $1',
        [config.id]
      )
      const result = await queryAll(
        'SELECT id, config, collection FROM trade_plans WHERE id = $1',
        [config.id]
      )
      if (result.length > 0) {
        const { id, config: configJson, collection } = result[0]
        return res.json({ ...JSON.parse(configJson), id, collection })
      }
      return res.status(404).json({ error: 'Plan not found' })
    }

    if (req.method === 'DELETE') {
      await deleteRows('trade_plans', 'id = $1', [config.id])
      return res.json({ success: true })
    }

    // GET all plans
    const results = await queryAll(
      'SELECT id, config, collection FROM trade_plans ORDER BY collection'
    )
    const settings = results.map(({ id, config: configJson }) => ({
      ...JSON.parse(configJson),
      id
    }))
    return res.json(settings)
  } catch (e) {
    console.log('[api/plan] error', e)
    return res.status(500).json({ error: e.message })
  }
}
