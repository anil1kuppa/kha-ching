import axios from 'axios'

import { withoutFwdSlash,orclsodaUrl } from '../../lib/utils'

const { DATABASE_HOST_URL, DATABASE_USER_KEY, DATABASE_API_KEY } = process.env
const orclEndpoint=`${orclsodaUrl}/trade_plans`
export default async function plan (req, res) {
  const { dayOfWeek, config } = req.body

const baseUrl = `${withoutFwdSlash(
    DATABASE_HOST_URL
  )}/set_${DATABASE_USER_KEY}`
  try {
    if (req.method === 'POST') {
      
      //POST for SODA accepts an object and returns an arrray of ids
      let updatedConfig={...config[0],collection: `${dayOfWeek}`} 
      const  {data:{items:[{id}]}}=await axios.post(orclEndpoint,updatedConfig);
      const {data} = await axios.get(`${orclEndpoint}/${id}`)
      const newdata= {...data,id}
      
      // const { data } = await axios[req.method.toLowerCase()](
      //   `${baseUrl}/${dayOfWeek}`,
      //   config,
      //   {
      //     headers: {
      //       'x-api-key': DATABASE_API_KEY
      //     }
      //   }
      // )
      return res.json(newdata)
    }

    if (req.method === 'PUT') {

      const { data }=await axios[req.method.toLowerCase()](
        `${orclEndpoint}/${config.id}`,
        config
  );
  const {data:getData} = await axios.get(`${orclEndpoint}/${config.id}`)
  data={...getData,id:config.id}
      // const { data } = await axios[req.method.toLowerCase()](
      //   `${baseUrl}/${config._id}`,
      //   config,
      //   {
      //     headers: {
      //       'x-api-key': DATABASE_API_KEY
      //     }
      //   }
      // )
      return res.json(data)
    }

    if (req.method === 'DELETE') {
      console.log(`${config.id}`);
      const { data }=await axios[req.method.toLowerCase()](
        `${orclEndpoint}/${config.id}`  );
      // const { data } = await axios[req.method.toLowerCase()](
      //   `${baseUrl}/${config._id}`,
      //   {
      //     headers: {
      //       'x-api-key': DATABASE_API_KEY
      //     }
      //   }
      // )
      return res.json(data)
    }

    //const { data: settings } = await axios(`${baseUrl}?limit=100`)
    const {data:{items}}= await axios(
      `${orclEndpoint}`);

const settings=items.map(items=>{
  return ({...items.value,id:items.id})
 });
 return res.json(settings)
  } catch (e) {
    console.log('[api/plan] error', e)
    if (e.isAxiosError) {
      return res.status(e.response.status).json(e.response.data || {})
    }
    return res.status(500).send(e)
  }
}
