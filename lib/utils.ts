import axios from 'axios'
import csv from 'csvtojson'
import dayjs, { Dayjs } from 'dayjs'
import { KiteConnect } from 'kiteconnect'
import Bluebird, { any, Promise } from 'bluebird'
import { allSettled, allSettledInterface } from './es6-promise'
import { redisConnection,QID } from './queue'

import {
  ERROR_STRINGS,
  EXIT_STRATEGIES,
  EXPIRY_TYPE,
  INSTRUMENTS,
  INSTRUMENT_DETAILS,
  KITE_INSTRUMENT_INFO,
  STRATEGIES,
  USER_OVERRIDE,
  COMPLETED_BY_TAG,
  ACCESSTOKEN,
  TRADES
} from './constants'
// const redisClient = require('redis').createClient(process.env.REDIS_URL);
// export const memoizer = require('redis-memoizer')(redisClient);
import { COMPLETED_ORDER_RESPONSE } from './strategies/mockData/orderResponse'
import { SignalXUser } from '../types/misc'
import { KiteOrder } from '../types/kite'
import {SUPPORTED_TRADE_CONFIG} from '../types/trade'

Promise.config({ cancellation: true, warnings: true })
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore'

dayjs.extend(isSameOrBefore)
import https from 'https'
import fs from 'fs'
import memoizer from 'memoizee'

export type TradingSymbolInterface = KITE_INSTRUMENT_INFO
export interface StrikeInterface {
  PE_STRING: string
  CE_STRING: string,
  LOT_SIZE:number
}

interface GET_LTP_ARGS {
  exchange: string
  tradingSymbol: string
}

export interface GET_LTP_RESPONSE extends GET_LTP_ARGS {
  instrumentToken: string
  lastPrice: number
}

const MOCK_ORDERS = process.env.MOCK_ORDERS
  ? JSON.parse(process.env.MOCK_ORDERS)
  : false
export const SIGNALX_URL =
  process.env.SIGNALX_URL ?? 'https://indicator.signalx.trade'
const KITE_API_KEY = process.env.KITE_API_KEY
const ORCL_HOST_URL=process.env.ORCL_HOST_URL
const SUPABASE_URL=process.env.SUPABASE_URL

export const logDeep = object => console.log(JSON.stringify(object, null, 2))

export const ms = seconds => seconds * 1000

const asyncGetIndexInstruments = (
  exchange = 'NFO'
): Promise<KITE_INSTRUMENT_INFO[]> =>
  new Promise((resolve, reject) => {
    const filename = `instrument_${new Date().getTime()}.csv`
    const file = fs.createWriteStream(filename)
    console.log('downloading instruments file...')
    https.get(`https://api.kite.trade/instruments/${exchange}`, function (
      response
    ) {
      const stream = response.pipe(file)
      stream.on('finish', async () => {
        try {
          const jsonArray = await csv().fromFile(filename)
          // sometimes 0d returns 200 status code but 502 gateway error in file
          if (Object.keys(jsonArray[0]).length === 12) {
            fs.unlink(filename, e => {
              console.log(e)
            })
            const indexesData =
              exchange === 'NFO'
                ? jsonArray.filter(
                    item =>
                      item.name === 'NIFTY' ||
                      item.name === 'BANKNIFTY' ||
                      item.name === 'FINNIFTY'
                  )
                : jsonArray

            return resolve(indexesData)
          }
          // retry if that's the case
          fs.unlink(filename, e => {
            console.log(e)
          })
          console.log('🔴 Failed downloading instruments file! Retrying...')
          // resolve this promise with a recursive promise fn call
          resolve(asyncGetIndexInstruments())
        } catch (e) {
          console.log('💀 Errored downloading instruments file!', e)
          reject(e)
        }
      })
    })
  })

export const getIndexInstruments = memoizer(asyncGetIndexInstruments, {
  maxAge: dayjs().get('hours') >= 8 ? ms(9 * 60 * 60) : ms(5 * 60),
  promise: true
})


const getOptionExpiries = async (
  nfoSymbol='NIFTY', //NIFTY,BANKNIFTY,FINNIFTY
  instrumentType='CE' //CE,PE,FUT
): Promise<string[]> => {
  console.log(`[utils.getOptionExpiries] nfoSymbol:${nfoSymbol};instrumentType=${instrumentType} `)
  const instrumentsData = await getIndexInstruments()

  const rows: KITE_INSTRUMENT_INFO[] = instrumentsData
    .filter(
      item =>
        (nfoSymbol ? item.name === nfoSymbol : true) &&
        (instrumentType ? item.instrument_type === instrumentType : true)
    )
    .sort((row1, row2) =>
      dayjs(row1.expiry).isSameOrBefore(dayjs(row2.expiry)) ? -1 : 1
    );
    const expiryDateSet = new Set();
    for (const row of rows )
    {
      expiryDateSet.add((row.expiry));
      if (expiryDateSet.size==20)
         break;
    
    }
    return Array.from(expiryDateSet) as string[];

}
export const getNiftyOptionExpiries = memoizer(getOptionExpiries, {
  maxAge: dayjs().get('hours') >= 8 ? ms(9 * 60 * 60) : ms(5 * 60),
  promise: true
})

export const delay = ms =>
  new Promise(resolve =>
    setTimeout(() => {
      resolve()
    }, ms)
  )

export const getMisOrderLastSquareOffTime = () =>
  dayjs()
    .set('hour', 15)
    .set('minutes', 24)
    .set('seconds', 0)
    .format()

const getSortedMatchingIntrumentsData = async ({
  nfoSymbol, //NIFTY,BANKNIFTY,FINNIFTY
  strike,
  instrumentType, //CE,PE,FUT
  tradingsymbol
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  tradingsymbol?: string
}): Promise<KITE_INSTRUMENT_INFO[]> => {
  const instrumentsData = await getIndexInstruments()
  const rows: KITE_INSTRUMENT_INFO[] = instrumentsData
    .filter(
      item =>
        (nfoSymbol ? item.name === nfoSymbol : true) &&
        (strike ? item.strike == strike : true) && // eslint-disable-line
        (tradingsymbol ? item.tradingsymbol === tradingsymbol : true) &&
        (instrumentType ? item.instrument_type === instrumentType : true)
    )
    .sort((row1, row2) =>
      dayjs(row1.expiry).isSameOrBefore(dayjs(row2.expiry)) ? -1 : 1
    )
  return rows
}
/*
Returns array of OTM Options
*/
const getOTMOptions = async ({
  nfoSymbol, //NIFTY,BANKNIFTY,FINNIFTY
  strike,
  instrumentType, //CE,PE,FUT
  expiry
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  expiry?: string
}): Promise<KITE_INSTRUMENT_INFO[]> => {
  const instrumentsData = await getIndexInstruments()
  const rows: KITE_INSTRUMENT_INFO[] = instrumentsData
    .filter(
      item =>
        (nfoSymbol ? item.name === nfoSymbol : true) &&
        (strike?(instrumentType==="CE"?item.strike>strike:item.strike<strike):true) &&
      //  (strike ? item.strike == strike : true) && // eslint-disable-line
        (instrumentType ? item.instrument_type === instrumentType : true) &&
        (expiry ? item.expiry === expiry : true) 
    )
    .sort((row1, row2) =>
      row1.strike<row2.strike ? -1 : 1
    )
  return rows
}

export async function getOHLC({kite,symbol,instrument}):Promise<any>
 {
  try
  {
  
  //console.log(`Checking ${await kite.getOHLC([NIFTY,BANKNIFTY])}`);
  const data=await kite.getOHLC(symbol);
  //console.log(`checking ${await kite.getOHLC(["NSE:NIFTY 50","NSE:NIFTY BANK"])}`);
  console.log (data);
  if (data[symbol].last_price<data[symbol].ohlc.open)
  data[symbol].trend="CE"
else
data[symbol].trend="PE"

  return ({
      "trend":data[symbol].trend,
      "last_price":data[symbol].last_price
  })
  //  data=await kite.getOHLC("NSE:NIFTY BANK");
  // //console.log(`checking ${await kite.getOHLC(["NSE:NIFTY 50","NSE:NIFTY BANK"])}`);
  // console.log(`Another ${data}`);
  // logDeep(data);
  
 }
 catch (  e)
 {
  console.log(`Excpetion is coming: ${e}`);
  
 }


 /* export async function getInstrumentPrice (
    kite,
    underlying: string,
    exchange: string
  ): Promise<number> {
    const instrumentString = `${exchange}:${underlying}`
    const underlyingRes = await kite.getLTP(instrumentString)
    return Number(underlyingRes[instrumentString].last_price)
  }
  */
}


export const getExpiryTradingSymbol = async ({
  nfoSymbol,
  strike,
  instrumentType,
  tradingsymbol,
  expiry = EXPIRY_TYPE.CURRENT
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  tradingsymbol?: string
  expiry?: EXPIRY_TYPE
}): Promise<TradingSymbolInterface | StrikeInterface | null> => {
  console.log('Fetching trading symbol for expiry type: ', expiry)
  switch (expiry) {
    case EXPIRY_TYPE.MONTHLY:
      return getMonthlyExpiryTradingSymbol({
        nfoSymbol,
        strike,
        instrumentType,
        tradingsymbol
      })

    case EXPIRY_TYPE.NEXT:
      return getNextExpiryTradingSymbol({
        nfoSymbol,
        strike,
        instrumentType,
        tradingsymbol
      })

    default:
      return getCurrentExpiryTradingSymbol({
        nfoSymbol,
        strike,
        instrumentType,
        tradingsymbol
      })
  }
}

export const getCurrentExpiryTradingSymbol = async ({
  nfoSymbol,
  strike,
  instrumentType,
  tradingsymbol
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  tradingsymbol?: string
}): Promise<TradingSymbolInterface | StrikeInterface | null> => {
  const rows = await getSortedMatchingIntrumentsData({
    nfoSymbol,
    strike,
    instrumentType,
    tradingsymbol
  })

  if (instrumentType) {
    return rows.length ? rows[0] : null
  }
  // get first two entries for current expiry
  const relevantRows = rows.slice(0, 2)

  const peStrike = relevantRows?.find(item => item.instrument_type === 'PE')
    ?.tradingsymbol
  const ceStrike = relevantRows?.find(item => item.instrument_type === 'CE')
    ?.tradingsymbol
    const lotSize=relevantRows?.find(item => item.instrument_type === 'PE')
    ?.lot_size

  if (!peStrike || !ceStrike) return null

  return {
    PE_STRING: peStrike,
    CE_STRING: ceStrike,
    LOT_SIZE :parseInt(lotSize!)
  }
}

export const getNextExpiryTradingSymbol = async ({
  nfoSymbol,
  strike,
  instrumentType,
  tradingsymbol
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  tradingsymbol?: string
}): Promise<TradingSymbolInterface | StrikeInterface | null> => {
  const rows = await getSortedMatchingIntrumentsData({
    nfoSymbol,
    strike,
    instrumentType,
    tradingsymbol
  })

  if (instrumentType) {
    return rows.length ? rows[1] : null
  }
  // first two entries are CE and PE for current week. So taking the next two items here
  const relevantRows = rows.slice(2, 4)

  const peStrike = relevantRows?.find(item => item.instrument_type === 'PE')
    ?.tradingsymbol
  const ceStrike = relevantRows?.find(item => item.instrument_type === 'CE')
    ?.tradingsymbol
   const lotSize=relevantRows?.find(item => item.instrument_type === 'PE')
    ?.lot_size

  if (!peStrike || !ceStrike) return null

  return {
    PE_STRING: peStrike,
    CE_STRING: ceStrike,
    LOT_SIZE :parseInt(lotSize!)
  }
}

export const getMonthlyExpiryTradingSymbol = async ({
  nfoSymbol,
  strike,
  instrumentType,
  tradingsymbol
}: {
  nfoSymbol?: string
  strike?: number
  instrumentType?: string
  tradingsymbol?: string
}): Promise<TradingSymbolInterface | StrikeInterface | null> => {
  const instrumentsData = await getSortedMatchingIntrumentsData({
    nfoSymbol,
    strike,
    instrumentType,
    tradingsymbol
  })

  // get current calendar month expiries
  let rows = instrumentsData.filter(
    item => dayjs().get('month') === dayjs(item.expiry).get('month')
  )

  //get next calendar month expiries
  if (!rows.length) {
    const month = dayjs().get('month') === 11 ? 0 : dayjs().get('month') // to handle December current year & Jan next year cases
    rows = instrumentsData.filter(
      item => dayjs(item.expiry).get('month') === month
    )
  }
  rows = rows.sort((row1, row2) =>
    dayjs(row1.expiry).isSameOrBefore(dayjs(row2.expiry)) ? -1 : 1
  )

  const rowsLength = rows.length

  if (instrumentType) {
    return rows.length ? rows[rowsLength - 1] : null
  }
  // get last two entries for monthly expiry
  const relevantRows = rows.slice(rowsLength - 2, rowsLength)

  const peStrike = relevantRows?.find(item => item.instrument_type === 'PE')
    ?.tradingsymbol
  const ceStrike = relevantRows?.find(item => item.instrument_type === 'CE')
    ?.tradingsymbol
  const lotSize=relevantRows?.find(item => item.instrument_type === 'PE')
  ?.lot_size

  if (!peStrike || !ceStrike) return null

  return {
    PE_STRING: peStrike,
    CE_STRING: ceStrike,
    LOT_SIZE :parseInt(lotSize!)
  }
}

export function getPercentageChange (
  price1: number,
  price2: number,
  mode = 'AGGRESIVE'
): number {
  const denominator =
    mode === 'AGGRESIVE' ? (price1 + price2) / 2 : Math.min(price1, price2)
  return Math.floor((Math.abs(price1 - price2) / denominator) * 100)
}

export async function getInstrumentPrice (
  kite,
  underlying: string,
  exchange: string
): Promise<number> {
  const instrumentString = `${exchange}:${underlying}`
  const underlyingRes = await kite.getLTP(instrumentString)
  return Number(underlyingRes[instrumentString].last_price)
}

export async function getSkew (kite, instrument1, instrument2, exchange) {
  const [price1, price2] = await Promise.all([
    getInstrumentPrice(kite, instrument1, exchange),
    getInstrumentPrice(kite, instrument2, exchange)
  ])

  const skew = getPercentageChange(price1, price2)
  return {
    [instrument1]: price1,
    [instrument2]: price2,
    skew
  }
}

export function syncGetKiteInstance (user):KiteConnect {
  const accessToken = user?.session?.access_token
  if (!accessToken) {
    throw new Error(
      'missing access_token in `user` object, or `user` is undefined'
    )
  }
  return new KiteConnect({
    api_key: KITE_API_KEY,
    access_token: accessToken
  })
}

export async function getCompletedOrderFromOrderHistoryById (kite, orderId) {
  const orders = await kite.getOrderHistory(orderId)
  return orders.find(odr => odr.status === 'COMPLETE')
}

export async function getAllOrNoneCompletedOrdersByKiteResponse (
  kite,
  rawKiteOrdersResponse
) {
  if (MOCK_ORDERS) {
    return [...new Array(rawKiteOrdersResponse.length)].fill(
      COMPLETED_ORDER_RESPONSE
    )
  }

  try {
    const completedOrders = (
      await Promise.all(
        rawKiteOrdersResponse.map((
          { order_id } // eslint-disable-line
        ) => getCompletedOrderFromOrderHistoryById(kite, order_id))
      )
    ).filter(o => o)

    if (completedOrders.length !== rawKiteOrdersResponse.length) {
      return null
    }

    return completedOrders
  } catch (e) {
    console.error('getAllOrNoneCompletedOrdersByKiteResponse error', {
      e,
      rawKiteOrdersResponse
    })
    return null
  }
}

export const logObject = (heading, object) =>
  typeof heading === 'string'
    ? console.log(heading, JSON.stringify(object, null, 2))
    : console.log(JSON.stringify(heading, null, 2))

export const getTimeLeftInMarketClosingMs = () =>
  process.env.NEXT_PUBLIC_APP_URL?.includes('localhost:')
    ? ms(1 * 60 * 60) // if developing, hardcode one hour to market closing
    : dayjs(getMisOrderLastSquareOffTime()).diff(dayjs())

//Returns a boolean to check if current time is after square off time
export const isTimeAfterAutoSquareOff=(squareOffTime: string)=>
{
const finalOrderTime = getMisOrderLastSquareOffTime()
const runAtTime = isMockOrder()
  ? squareOffTime
  : dayjs(squareOffTime).isAfter(dayjs(finalOrderTime))
  ? finalOrderTime
  : squareOffTime

 return dayjs().isAfter(runAtTime);

}

export const getEntryAttemptsCount = ({ strategy }) => {
  switch (strategy) {
    case STRATEGIES.DIRECTIONAL_OPTION_SELLING:
      return Math.ceil(getTimeLeftInMarketClosingMs() / ms(5 * 60))
    case STRATEGIES.OPTION_BUYING_STRATEGY:
      return Math.ceil(getTimeLeftInMarketClosingMs() / ms(1 * 60))
    default:
      return null
  }
}

export const getBackoffStrategy = ({ strategy }) => {
  switch (strategy) {
    case STRATEGIES.DIRECTIONAL_OPTION_SELLING:
      return 'backOffToNearest5thMinute'
    case STRATEGIES.OPTION_BUYING_STRATEGY:
      return 'backOffToNearestMinute'
    default:
      return 'fixed'
  }
}

export const getCustomBackoffStrategies = () => {
  return {
    backOffToNearest5thMinute () {
      return dayjs(getNextNthMinute(5 * 60 * 1000)).diff(dayjs())
    },
    backOffToNearestMinute () {
      return dayjs(getNextNthMinute(1 * 60 * 1000)).diff(dayjs())
    }
  }
}

export const getQueueOptionsForExitStrategy = exitStrategy => {
  if (!exitStrategy) {
    throw new Error(
      'getQueueOptionsForExitStrategy called without exitStrategy'
    )
  }

  switch (exitStrategy) {
    case EXIT_STRATEGIES.MULTI_LEG_PREMIUM_THRESHOLD: {
      const recheckInterval = ms(3)
      return {
        attempts: Math.ceil(getTimeLeftInMarketClosingMs() / recheckInterval),
        backoff: {
          type: 'fixed',
          delay: recheckInterval
        }
      }
    }
    case EXIT_STRATEGIES.MIN_XPERCENT_OR_SUPERTREND: {
      const recheckInterval = ms(5 * 60)
      return {
        attempts: Math.ceil(getTimeLeftInMarketClosingMs() / recheckInterval),
        backoff: {
          type: 'backOffToNearest5thMinute'
        }
      }
    }
    case EXIT_STRATEGIES.OBS_TRAIL_SL: {
      const recheckInterval = ms(1 * 60)
      return {
        attempts: Math.ceil(getTimeLeftInMarketClosingMs() / recheckInterval),
        backoff: {
          type: 'backOffToNearestMinute'
        }
      }
    }
    default:
      return {
        attempts: 20,
        backoff: {
          type: 'fixed',
          delay: ms(3)
        }
      }
  }
}

const marketHolidays = [
  ['September 20,2018', 'Thursday'],
  ['October 02,2018', 'Tuesday'],
  ['October 18,2018', 'Thursday'],
  ['November 07,2018', 'Wednesday'],
  ['November 08,2018', 'Thursday'],
  ['November 23,2018', 'Friday'],
  ['December 25,2018', 'Tuesday'],
  ['March 04,2019', 'Monday'],
  ['March 21,2019', 'Thursday'],
  ['April 17,2019', 'Wednesday'],
  ['April 19,2019', 'Friday'],
  ['April 29,2019', 'Monday'],
  ['May 01,2019', 'Wednesday'],
  ['June 05,2019', 'Wednesday'],
  ['August 12,2019', 'Monday'],
  ['August 15,2019', 'Thursday'],
  ['September 02,2019', 'Monday'],
  ['September 10,2019', 'Tuesday'],
  ['October 02,2019', 'Wednesday'],
  ['October 08,2019', 'Tuesday'],
  ['October 21,2019', 'Monday'],
  ['October 28,2019', 'Monday'],
  ['November 12,2019', 'Tuesday'],
  ['December 25,2019', 'Wednesday'],
  ['February 21, 2020', 'Friday'],
  ['March 10,2020', 'Tuesday'],
  ['April 02,2020', 'Thursday'],
  ['April 06,2020', 'Monday'],
  ['April 10,2020', 'Friday'],
  ['April 14,2020', 'Tuesday'],
  ['May 01,2020', 'Friday'],
  ['May 25,2020', 'Monday'],
  ['October 02,2020', 'Friday'],
  ['November 16,2020', 'Monday'],
  ['November 30,2020', 'Monday'],
  ['December 25,2020', 'Friday'],
  ['January 26,2021', 'Tuesday'],
  ['March 11,2021', 'Thursday'],
  ['March 29,2021', 'Monday'],
  ['April 02,2021', 'Friday'],
  ['April 14,2021', 'Wednesday'],
  ['April 21,2021', 'Wednesday'],
  ['May 13,2021', 'Thursday'],
  ['July 21,2021', 'Wednesday'],
  ['August 19,2021', 'Thursday'],
  ['September 10,2021', 'Friday'],
  ['October 15,2021', 'Friday'],
  ['November 04,2021', 'Thursday'],
  ['November 05,2021', 'Friday'],
  ['November 19,2021', 'Friday'],
  ['January 26,2022', 'Wednesday'],
  ['March 01,2022', 'Tuesday'],
  ['March 18,2022', 'Friday'],
  ['April 14,2022', 'Thursday'],
  ['April 15,2022', 'Friday'],
  ['May 03,2022', 'Tuesday'],
  ['August 09,2022', 'Tuesday'],
  ['August 15,2022', 'Monday'],
  ['August 31,2022', 'Wednesday'],
  ['October 05,2022', 'Wednesday'],
  ['October 24,2022', 'Monday'],
  ['October 26,2022', 'Wednesday'],
  ['November 08,2022', 'Tuesday']
]

export const isDateHoliday = (date: Dayjs) => {
  const isMarketHoliday = marketHolidays.find(
    holidays => holidays[0] === date.format('MMMM DD,YYYY')
  )
  if (isMarketHoliday) {
    return true
  }
  const day = date.format('dddd')
  const isWeeklyHoliday = day === 'Saturday' || day === 'Sunday'
  return isWeeklyHoliday
}

export const getLastOpenDateSince = (from: Dayjs) => {
  const fromDay = from.format('dddd')
  const yesterday = from.subtract(fromDay === 'Monday' ? 3 : 1, 'days')
  if (isDateHoliday(yesterday)) {
    return getLastOpenDateSince(yesterday)
  }

  return yesterday
}

export const checkHasSameAccessToken = async (accessToken: string) => {
  try {
    // const {
    //   data: [token]
    // } = await axios(ACCESS_TOKEN_URL)
    // const { access_token: dbAccessToken } = token
    const {data:{items:[item]}}= await axios(
      `${ORCL_HOST_URL}/rest-v1/access_tokens`
);
const { access_token: dbAccessToken } = item
    return dbAccessToken === accessToken
  } catch (e) {
    console.log('🔴 [storeAccessTokenRemotely] error', e)
    return false
  }
}

export const storeAccessTokenRemotely = async accessToken => {
   try {
  //  await axios.post(
  //     `${ORCL_HOST_URL}/rest-v1/access_tokens`,
  //     {
  //       access_token: accessToken
  //     }
  //   )
  await axios.post(
    `${SUPABASE_URL}/functions/v1/insertAccesstoken`,
    {
      access_token: accessToken
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  console.log('✅ [storeAccessTokenRemotely] success');
}
   catch (e) {
    console.log('🔴 [storeAccessTokenRemotely] error', e)
  }
}

export const getNearestCandleTime = (
  intervalMs,
  referenceDate = new Date()
) => {
  const nearestCandle = new Date(
    Math.floor(referenceDate.getTime() / intervalMs) * intervalMs
  )
  // https://kite.trade/forum/discussion/7798/historical-data-candles-inaccurate-for-small-periods
  return dayjs(nearestCandle).subtract(1, 'second')
}

export const getNextNthMinute = intervalMs => {
  // ref: https://stackoverflow.com/a/10789415/721084
  const date = new Date()
  const rounded = new Date(Math.ceil(date.getTime() / intervalMs) * intervalMs)
  return rounded
}

export const ensureMarginForBasketOrder = async (user, orders) => {
  const kite = syncGetKiteInstance(user)
  const {
    equity: { net }
  } = await kite.getMargins()

  console.log('[ensureMarginForBasketOrder]', { net })

  const { data } = await axios.post(
    'https://api.kite.trade/margins/basket?consider_positions=true&mode=compact',
    orders,
    {
      headers: {
        'X-Kite-Version': 3,
        Authorization: `token ${KITE_API_KEY as string}:${user.session
          .access_token as string}`,
        'Content-Type': 'application/json'
      }
    }
  )

  const totalMarginRequired = data?.data?.initial?.total

  console.log('[ensureMarginForBasketOrder]', { totalMarginRequired })

  const canPunch = totalMarginRequired < net
  if (!canPunch) {
    console.log('🔴 [ensureMarginForBasketOrder] margin check failed!')
  }

  return canPunch
}

export const isMarketOpen = (time = dayjs()) => {
  if (isDateHoliday(time)) {
    return false
  }

  const startTime = time
    .set('hour', 9)
    .set('minute', 15)
    .set('second', 0)
  const endTime = time
    .set('hour', 15)
    .set('minute', 30)
    .set('second', 0)

  return time.isAfter(startTime) && time.isBefore(endTime)
}

export function randomIntFromInterval (min: number, max: number) {
  // min and max included
  return Math.floor(Math.random() * (max - min + 1) + min)
}

interface LTP_TYPE {
  tradingsymbol: string
  strike: number
  last_price: number
}

export function closest (
  needle: number,
  haystack: Array<LTP_TYPE | any>,
  haystackKey: string,
  greaterThanEqualToPrice: boolean
) {
  const filtered = haystack.filter(item => {
    if (greaterThanEqualToPrice) {
      return item[haystackKey] >= needle
    }
    return (
      item[haystackKey] >= needle ||
      getPercentageChange(item[haystackKey], needle) <= 10
    )
  })
  /**
   * the above ensures that we pick up a price lower than needle price,
   * only if it's at most 10% lesser than the needle price
   */
  return filtered.reduce((prev, curr) =>
    Math.abs(curr[haystackKey] - needle) < Math.abs(prev[haystackKey] - needle)
      ? curr
      : prev
  )
}

interface TRADING_SYMBOL_BY_OPTION_PRICE_TYPE {
  nfoSymbol?: string
  price: number
  instrumentType?: string
  pivotStrike: number
  user: SignalXUser
  greaterThanEqualToPrice?: boolean
  expiry?: EXPIRY_TYPE
}

export const getMultipleInstrumentPrices = async (
  instruments: GET_LTP_ARGS[],
  user: SignalXUser
): Promise<Record<string, GET_LTP_RESPONSE>> => {
  const {
    data: { data: pricesDetailsof }
  } = await withRemoteRetry(async () =>
    axios(
      `https://api.kite.trade/quote/ltp?${instruments
        .map(({ exchange, tradingSymbol }) => `i=${exchange}:${tradingSymbol}`)
        .join('&')}`,
      {
        headers: {
          'X-Kite-Version': 3,
          Authorization: `token ${KITE_API_KEY as string}:${user.session
            .access_token as string}`
        }
      }
    )
  )
  const formattedResponse = Object.keys(pricesDetailsof).reduce(
    (accum, exchangeTradingSymbol) => {
      const [exchange, tradingSymbol] = exchangeTradingSymbol.split(':')
      const {
        instrument_token: instrumentToken,
        last_price: lastPrice
      } = pricesDetailsof[exchangeTradingSymbol]
      return {
        ...accum,
        [tradingSymbol]: {
          exchange,
          tradingSymbol,
          instrumentToken,
          lastPrice
        }
      }
    },
    {}
  )

  return formattedResponse
}

export const getOTMStrangleByOptionPrice = async ({
  nfoSymbol,
  price,
  pivotStrike,
  user,
  greaterThanEqualToPrice = false,
  expiry = EXPIRY_TYPE.CURRENT
}: TRADING_SYMBOL_BY_OPTION_PRICE_TYPE):Promise<Partial<KITE_INSTRUMENT_INFO>[]> => {
  console.log(`[utils.getOTMStrangleByOptionPrice] nfoSymbol ${nfoSymbol}, price:${price}, pivotStrike:${pivotStrike}`)
  const kite = syncGetKiteInstance(user)
  const expiryArray=await getNiftyOptionExpiries();
  let expiryDate:string;
  if (expiry===EXPIRY_TYPE.CURRENT)
     expiryDate=expiryArray[0];
  else  if (expiry===EXPIRY_TYPE.NEXT)
     expiryDate=expiryArray[1];
  else
  {
    const month=dayjs(expiryArray[0]).month();
    expiryDate=expiryArray[0];
    for (let i=1;i<10;i++)
    {
      if (!(month===dayjs(expiryArray[i]).month()))
        {
          expiryDate=expiryArray[i-1];
          break;
        }

    }
  }

  const otmCEOptions=await getOTMOptions({nfoSymbol,
    strike:pivotStrike,
   instrumentType: "CE",
    expiry:expiryDate
  })
  const otmPEOptions=await getOTMOptions({nfoSymbol,
    strike:pivotStrike,
   instrumentType: "PE",
    expiry:expiryDate
  })

  const otmCEInstruments = 
  otmCEOptions.map((row)=>
    (
    {
      exchange: kite.EXCHANGE_NFO,
      tradingSymbol: row.tradingsymbol
    })
    )

  const otmPEInstruments = 
  otmPEOptions.map((row)=>
    (
    {
      exchange: kite.EXCHANGE_NFO,
      tradingSymbol: row.tradingsymbol
    })
    )


//   await Promise.map(strikes, async strike => {
//     const tradingSymbolInterface= (await getExpiryTradingSymbol({
//       nfoSymbol,
//       strike,
//       instrumentType,
//       expiry
//     })) as TradingSymbolInterface
//     const tradingsymbol=tradingSymbolInterface?.tradingsymbol
//  console.log(`[getTradingSymbolsByOptionPrice] Trading symbol is ${tradingsymbol}`)
//     return {
//       exchange: kite.EXCHANGE_NFO,
//       tradingSymbol: tradingsymbol
//     }
//   })

  const otmCEPrices = await getMultipleInstrumentPrices(
    otmCEInstruments,
    user
  );

  const otmPEPrices = await getMultipleInstrumentPrices(
    otmPEInstruments,
    user
  )

  const getStrike = inst => {
    const withoutNfoSymbol = inst.replace(nfoSymbol, '')
    const withoutExpiryDetails = withoutNfoSymbol.substr(5, 5)
    return Number(withoutExpiryDetails)
  }

  const CEformattedPrices: LTP_TYPE[] = otmCEInstruments.map(({ tradingSymbol }) => {
    const { instrumentToken, lastPrice } = otmCEPrices[
      tradingSymbol
    ]
    return {
      tradingsymbol: tradingSymbol,
      strike: getStrike(tradingSymbol),
      instrument_token: instrumentToken,
      last_price: lastPrice
    }
  })

  const PEformattedPrices: LTP_TYPE[] = otmPEInstruments.map(({ tradingSymbol }) => {
    const { instrumentToken, lastPrice } = otmPEPrices[
      tradingSymbol
    ]
    return {
      tradingsymbol: tradingSymbol,
      strike: getStrike(tradingSymbol),
      instrument_token: instrumentToken,
      last_price: lastPrice
    }
  })
  
  const CEInstrument:Partial<KITE_INSTRUMENT_INFO>=closest(price, CEformattedPrices, 'last_price', greaterThanEqualToPrice)
  const PEInstrument:Partial<KITE_INSTRUMENT_INFO>=closest(price, PEformattedPrices, 'last_price', greaterThanEqualToPrice)
return [CEInstrument,PEInstrument];

}


export const getTradingSymbolsByOptionPrice = async ({
  nfoSymbol,
  price,
  instrumentType,
  pivotStrike,
  user,
  greaterThanEqualToPrice = false,
  expiry = EXPIRY_TYPE.CURRENT
}: TRADING_SYMBOL_BY_OPTION_PRICE_TYPE):Promise<Partial<KITE_INSTRUMENT_INFO>> => {
  const kite = syncGetKiteInstance(user)
  const totalStrikes = 61 // pivot and 30 on each side
  const { strikeStepSize } = INSTRUMENT_DETAILS[nfoSymbol!]
  const strikes = [...new Array(totalStrikes)]
    .map((_, idx) =>
      idx === 0
        ? idx
        : idx < totalStrikes / 2
        ? idx * -1
        : idx - Math.floor(totalStrikes / 2)
    )
    .map(idx => pivotStrike + idx * strikeStepSize)
    .sort((a, b) => a - b)

  const instruments = await Promise.map(strikes, async strike => {
    const tradingSymbolInterface= (await getExpiryTradingSymbol({
      nfoSymbol,
      strike,
      instrumentType,
      expiry
    })) as TradingSymbolInterface
    const tradingsymbol=tradingSymbolInterface?.tradingsymbol
 console.log(`[getTradingSymbolsByOptionPrice] Trading symbol is ${tradingsymbol}`)
    return {
      exchange: kite.EXCHANGE_NFO,
      tradingSymbol: tradingsymbol
    }
  })

  const priceDataByTradingSymbol = await getMultipleInstrumentPrices(
    instruments,
    user
  )

  const getStrike = inst => {
    const withoutNfoSymbol = inst.replace(nfoSymbol, '')
    const withoutExpiryDetails = withoutNfoSymbol.substr(5, 5)
    return Number(withoutExpiryDetails)
  }

  const formattedPrices: LTP_TYPE[] = instruments.map(({ tradingSymbol }) => {
    const { instrumentToken, lastPrice } = priceDataByTradingSymbol[
      tradingSymbol
    ]
    return {
      tradingsymbol: tradingSymbol,
      strike: getStrike(tradingSymbol),
      instrument_token: instrumentToken,
      last_price: lastPrice
    }
  })

  return closest(price, formattedPrices, 'last_price', greaterThanEqualToPrice)
}

export function withoutFwdSlash (url: string): string {
  if (url.endsWith('/')) {
    return url.slice(0, url.length - 1)
  }
  return url
}

export async function premiumAuthCheck (): Promise<any> {
  if (!process.env.SIGNALX_API_KEY) {
    return false
  }

  return axios.post(
    `${SIGNALX_URL}/api/auth`,
    {},
    {
      headers: {
        'X-API-KEY': process.env.SIGNALX_API_KEY
      }
    }
  )
}

export const orclsodaUrl = `${ORCL_HOST_URL}/soda/latest`

export const isMockOrder = () =>
  process.env.MOCK_ORDERS ? JSON.parse(process.env.MOCK_ORDERS) : false

export const isUntestedFeaturesEnabled = () =>
  process.env.ENABLE_UNTESTED_FEATURES
    ? JSON.parse(process.env.ENABLE_UNTESTED_FEATURES)
    : false

export const finiteStateChecker = async (
  infinitePr: Bluebird<any>,
  checkDurationMs: number
): Promise<any | Error> => {
  return infinitePr.timeout(checkDurationMs).catch(e => {
    // cleanup infinitePr
    infinitePr.cancel()
    // and then rethrow for parent task
    throw e
  })
}

export const withRemoteRetry = async (
  remoteFn: any,
  timeoutMs = ms(60)
): Promise<any> => {
  const remoteFnExecution = () =>
    new Promise((resolve, reject, onCancel) => {
      let cancelled = false
      const fn = async () => {
        if (cancelled) {
          return false
        }
        try {
          const isRemoteFnPromise =
            remoteFn && typeof (remoteFn as any).then == 'function' // eslint-disable-line
          const res = await (isRemoteFnPromise ? remoteFn : remoteFn())
          return res
        } catch (e) {
          if (e?.isAxiosError) {
            if (e?.response?.status === 401) {
              return reject(new Error(ERROR_STRINGS.PAID_STRATEGY))
            }
          }

          console.log(`withRemoteRetry attempt failed for ${remoteFn}`, e)
          await Promise.delay(ms(2))
          return fn()
        }
      }

      fn()
        .then(res => {
          resolve(res)
        })
        .catch(e => reject(e))

      onCancel!(() => {
        cancelled = true
      })
    })

  const remoteFnExecutionPr = remoteFnExecution()
  const response = await finiteStateChecker(remoteFnExecutionPr, timeoutMs)
  return response
}

export const orderStateChecker = (kite, orderId, ensureOrderState) => {
  /**
   * if broker responds back with order history,
   * but is not in expected state (fn arg) and is also not in failure states (REJECTED or CANCELLED)
   * then keep retrying for it to enter either of those states
   */
  return new Promise((resolve, reject, onCancel) => {
    let cancelled = false
    const fn = async () => {
      if (cancelled) {
        return false
      }
      try {
        const orderHistory = await withRemoteRetry(() =>
          kite.getOrderHistory(orderId)
        )
        const byRecencyOrderHistory = orderHistory.reverse()
        // if it reaches here, then order exists in broker system

        const expectedStateOrder = byRecencyOrderHistory.find(
          odr => odr.status === ensureOrderState
        )

        if (expectedStateOrder) {
          return expectedStateOrder
        }

        console.log('🔴 [orderStateChecker] invalid state...', {
          orderId,
          ensureOrderState
        })
        logDeep(orderHistory)

        const wasOrderRejectedOrCancelled = byRecencyOrderHistory.find(
          odr =>
            odr.status === kite.STATUS_REJECTED ||
            odr.status === kite.STATUS_CANCELLED
        )

        if (wasOrderRejectedOrCancelled) {
          console.log(
            '🔴 [orderStateChecker] rejected or cancelled',
            byRecencyOrderHistory
          )
          throw new Error(kite.STATUS_REJECTED)
        }

        // in every other case, retry until its status changes to either of above states
        await Promise.delay(ms(2))
        return fn()
      } catch (e) {
        console.log('🔴 [orderStateChecker] caught', e)
        if (
          e?.message === kite.STATUS_REJECTED ||
          (e?.status === 'error' &&
            e?.error_type === 'GeneralException' &&
            e?.message === "Couldn't find that `order_id`.")
        ) {
          throw new Error(kite.STATUS_REJECTED)
        }
        // for other exceptions like network layer, retry
        await Promise.delay(ms(2))
        return fn()
      }
    }

    fn()
      .then(resolve)
      .catch(e => {
        console.log('🔴 [orderStateChecker] checker error', e)
        if (e?.message === kite.STATUS_REJECTED) {
          reject(e)
        }
      })

    onCancel!(() => {
      cancelled = true
    })
  })
}

/**
 *
 * @returns
 * throws `Promise.Timedout`
 * which means it tried for X number of times
 * and still couldn't place it determinstically (doesn't exist will broker as well - confirmed!)
 *
 *
 * or resolves with
 * { successful: true, response: orderHistoryStateObject } or
 * { successful: false, response?: orderAckResponse }
 * which means order was placed, but its status couldn't be determined within `orderStatusCheckTimeout`
 * receiving `false` is a tricky situation to be in - and it shouldn't happen in an ideal world
 */
export const remoteOrderSuccessEnsurer = async (args: {
  _kite?: Record<string, unknown>
  ensureOrderState: string
  orderProps: Partial<KiteOrder>
  instrument: INSTRUMENTS
  onFailureRetryAfterMs?: number
  retryAttempts?: number
  orderStatusCheckTimeout?: number
  remoteRetryTimeout?: number
  user: SignalXUser
  attemptCount?: number
}): Promise<{
  successful: boolean
  response?: KiteOrder[]
}> => {
  const {
    _kite,
    ensureOrderState,
    orderProps,
    onFailureRetryAfterMs = ms(15),
    retryAttempts = 3,
    orderStatusCheckTimeout = ms(2 * 60),
    remoteRetryTimeout = ms(60),
    user,
    instrument,
    attemptCount = 0
  } = args

  if (attemptCount >= retryAttempts) {
    console.log(
      '🔴 [remoteOrderSuccessEnsurer] all attempts exhausted. Terminating!'
    )
    throw Promise.TimeoutError
  }

  if (attemptCount > 0) {
    await Promise.delay(onFailureRetryAfterMs)
    console.log({ attemptCount: attemptCount + 1, retryAttempts })
  }

  const {data:{items}}= await axios(
    `${orclsodaUrl}/dailyplan?q={"orderTag": "${orderProps.tag!}"}`)

const tradeSettings=items.map(items=>{
return ({...items.value,id:items.id})
});


  const { user_override: userOverride } = tradeSettings
  if (userOverride === USER_OVERRIDE.ABORT) {
    console.log(
      '🔴 [remoteOrderSuccessEnsurer] user override ABORT. Terminating!'
    )
    throw Error(USER_OVERRIDE.ABORT)
  }

  const kite = _kite ?? syncGetKiteInstance(user)

  const { freezeQty } = INSTRUMENT_DETAILS[instrument]
  if (orderProps.quantity! > freezeQty) {
    // if more than freeze quantity, split quantity into freezeQty orders
    const ordersCount = Math.ceil(orderProps.quantity! / freezeQty)
    const freezeQtyOrders = [...new Array(ordersCount).fill(null)].map(
      (_, idx) => {
        if (idx === ordersCount - 1) {
          // last order with qty <= freezeQty
          return {
            ...orderProps,
            quantity: orderProps.quantity! - idx * freezeQty
          }
        }
        return {
          ...orderProps,
          quantity: freezeQty
        }
      }
    )

    const orderResults: any = await allSettled(
      freezeQtyOrders.map(order =>
        remoteOrderSuccessEnsurer({
          ...args,
          orderProps: order
        })
      )
    )

    const isSuccessful = orderResults.every(
      orderResult =>
        orderResult.status === 'fulfilled' && orderResult.value?.successful
    )

    return {
      successful: isSuccessful,
      response: orderResults
        .map(orderResult =>
          orderResult.status === 'fulfilled' && orderResult.value?.successful
            ? orderResult.value.response
            : null
        )
        .filter(o => o)
        .reduce((accum, ordersArr) => [...accum, ...ordersArr], [])
    }
  }

  try {
    const mockOrders = isMockOrder()
    if (mockOrders) {
      console.log('mock order', orderProps)
    }
    console.log(`[remoteOrderSuccessEnsurer] Order details are ${JSON.stringify(orderProps)}`)
    const orderAckResponse = mockOrders
      ? { order_id: '' }
      : await kite.placeOrder(kite.VARIETY_REGULAR, orderProps)
    const { order_id: ackOrderId } = orderAckResponse
    const isOrderInUltimateStatePr = orderStateChecker(
      kite,
      ackOrderId,
      ensureOrderState
    )
    try {
      const ultimateStateOrder = await finiteStateChecker(
        isOrderInUltimateStatePr,
        orderStatusCheckTimeout
      )
      return {
        successful: true,
        response: [ultimateStateOrder]
      }
    } catch (e) {
      // should only reach here if it had a rejected status or finiteStateChecker timedout
      console.log('🔴 [remoteOrderSuccessEnsurer] caught', e)
      if (e instanceof Promise.TimeoutError) {
        return {
          successful: false,
          response: [orderAckResponse]
        }
      }
      if (e?.message === kite.STATUS_REJECTED) {
        console.log(
          '🟢 [remoteOrderSuccessEnsurer] retrying rejected order',
          orderProps
        )
        return remoteOrderSuccessEnsurer({
          ...args,
          attemptCount: attemptCount + 1
        })
      }
      throw e
    }
  } catch (e) {
    // will reach here if kite.placeOrder fails with some error
    console.log('🔴 [remoteOrderSuccessEnsurer] placeOrder failed?', e)
    if (
      e?.status === 'error' &&
      (e?.error_type === 'NetworkException' ||
        e?.error_type === 'OrderException' ||
        e?.error_type === 'InputException')
    ) {
      // we cannot simply retry - don't know where the request failed inflight
      // check at the broker's end - if the order exists with that tag or not

      try {
        const orders = await withRemoteRetry(
          () => kite.getOrders(),
          remoteRetryTimeout
        )
        const matchedOrder = orders.find(
          order =>
            order.tag === orderProps.tag &&
            order.tradingsymbol === orderProps.tradingsymbol &&
            order.quantity === orderProps.quantity &&
            order.product === orderProps.product &&
            order.transaction_type === orderProps.transaction_type &&
            order.exchange === orderProps.exchange
        )

        if (!matchedOrder) {
          // orders api responded successfully and we didn't find a matching order
          // so reattempt the order
          return remoteOrderSuccessEnsurer({
            ...args,
            attemptCount: attemptCount + 1
          })
        }

        // order found
        // ensure that it's in the expected state
        const isMatchedOrderInUltimateStatePr = orderStateChecker(
          kite,
          matchedOrder.order_id,
          ensureOrderState
        )
        try {
          const ultimateStateOrder = await finiteStateChecker(
            isMatchedOrderInUltimateStatePr,
            orderStatusCheckTimeout
          )
          return {
            successful: true,
            response: [ultimateStateOrder]
          }
        } catch (e) {
          if (e?.message === kite.STATUS_REJECTED) {
            return remoteOrderSuccessEnsurer({
              ...args,
              attemptCount: attemptCount + 1
            })
          }
          throw e
        }
      } catch (e) {
        // case - tried getting orders for 1 min, but no response from broker
        console.log(
          '🔴 [remoteOrderSuccessEnsurer] caught with no response from broker',
          e
        )
        return { successful: false }
      }
    }

    console.log('🔴 [remoteOrderSuccessEnsurer] unhandled parent caught', e)
    return { successful: false }
  }
}


// gets the current data from DB
export const getValuesfromDB = async (
    id:string
): Promise<Record<string, unknown>> => {
    const endpoint = `${orclsodaUrl}/dailyplan/${id}`
  
    const { data } = await axios(endpoint)
    return data
  }
// puts the value to DB
export const putValuestoDb = async (
    id:string,
    data:any
) => {
    const endpoint = `${orclsodaUrl}/dailyplan/${id}`
  
    await axios.put(
        endpoint,
        data
      )
    
  }
// patches and returns stale data
export const patchDbTrade = async ({
  id,
  patchProps
}: {
  id: string
  patchProps: Record<string, unknown>
}): Promise<Record<string, unknown>> => {
  const endpoint = `${orclsodaUrl}/dailyplan/${id}`

  const { data } = await axios(endpoint)
  await axios.put(
    endpoint,
    {
      ...data,
      ...patchProps
    }
  )

  return data
}
/*
Points: sell - buy
Quantity: Sell is positive, buy is negative similar to kite positions
*/
export const getCompletedOrdersbyTag= async(orderTag:string,kite:any):
Promise<COMPLETED_BY_TAG[]>=>
{

  const orders = await withRemoteRetry(
    () => kite.getOrders()
  )
  
 const pendingorders= orders.filter(order=>(order.status==='COMPLETE' && order.tag===orderTag))
 .reduce((prev:{[key: string]: {
  points:number,
  quantity:number
}}, curr) =>
  {
    if (!prev[curr.tradingsymbol])
     {
         prev[curr.tradingsymbol]={
             "points":curr.transaction_type==='SELL'?curr.average_price:-1*curr.average_price,
             "quantity":curr.transaction_type==='SELL'?-1*curr.quantity:curr.quantity
         }
     }
     else
     {
        prev[curr.tradingsymbol].points+=curr.transaction_type==='SELL'?curr.average_price:-1*curr.average_price;
        prev[curr.tradingsymbol].quantity+=curr.transaction_type==='SELL'?-1*curr.quantity:curr.quantity; 
     }
     return prev;

     } ,{}
  )
  const completeOrdersBytag:COMPLETED_BY_TAG[]=Object.keys(pendingorders).map
  (key=>
  { return {
      "tradingsymbol":key,
      "quantity":pendingorders[key].quantity,
      "points":pendingorders[key].points
    }
  }
    )
  /* console.log(`[getCompletedOrdersbyTag] completedOrders by tag are`, completeOrdersBytag) */
    return completeOrdersBytag;

    }

export const attemptBrokerOrders = async (
  ordersPr: Array<Promise<any>>
): Promise<{
  allOk: boolean
  statefulOrders: KiteOrder[]
}> => {
  try {
    const brokerOrderResolutions = await allSettled(ordersPr)
    logDeep(brokerOrderResolutions)
    const rejectedLegs = (brokerOrderResolutions as any).filter(
      (res: allSettledInterface) => res.status === 'rejected'
    )
    const successfulOrders: Array<
      KiteOrder | null
    > = (brokerOrderResolutions as any)
      .map((res: allSettledInterface) =>
        res.status === 'fulfilled' && res.value.successful
          ? res.value.response
          : null
      )
      .filter(o => o)
      .reduce(
        (flattenedOrders, ordersArr) => [...flattenedOrders, ...ordersArr],
        []
      )

    if (rejectedLegs.length > 0) {
      return {
        allOk: false,
        statefulOrders: successfulOrders as KiteOrder[]
      }
    }

    return {
      allOk: true,
      statefulOrders: successfulOrders as KiteOrder[]
    }
  } catch (e) {
    console.log('🔴 [attemptBrokerOrders] error', e)
    return {
      allOk: false,
      statefulOrders: []
    }
  }
}

export const getHedgeForStrike = async ({
  strike,
  distance,
  type,
  nfoSymbol,
  expiryType = EXPIRY_TYPE.CURRENT
}: {
  strike: number
  distance: number
  type: string
  nfoSymbol: string
  expiryType: EXPIRY_TYPE
}): Promise<string|undefined> => {
  const hedgeStrike = strike + distance * (type === 'PE' ? -1 : 1)

  const { tradingsymbol } = (await getExpiryTradingSymbol({
    nfoSymbol,
    strike: hedgeStrike,
    instrumentType: type,
    expiry: expiryType
  })) as TradingSymbolInterface

  return tradingsymbol
}

export interface apiResponseObject {
  PutDelta: number
  CallDelta: number
  StrikePrice: number
}

export const getStrikeByDelta = (
  delta: number,
  apiResponse: {
    atmStrike: number
    data: apiResponseObject[]
  },
  type?: 'PE' | 'CE'
):
  | apiResponseObject
  | {
      putStrike: apiResponseObject
      callStrike: apiResponseObject
    } => {
  const { data } = apiResponse
  const putStrike = closest(delta, data, 'PutDelta', false)
  const callStrike = closest(delta, data, 'CallDelta', false)
  if (type === 'PE') {
    return putStrike
  }

  if (type === 'CE') {
    return callStrike
  }

  return {
    putStrike,
    callStrike
  }
}

export function round (value: number, step = 0.5): number {
  const inv = 1.0 / step
  return Math.round(value * inv) / inv
}

export async function cleanupTradesAndAccessToken()
{
  await redisConnection.hdel(QID,ACCESSTOKEN) ;
  await redisConnection.hdel(QID,TRADES) ;
}

export async function storeAccessTokeninRedis(access_token:string):Promise<void>
{
  await redisConnection.hset(QID,ACCESSTOKEN,access_token) 
}

export const checksameTokeninRedis = async (access_token: string):Promise<boolean> => {
  const currentToken:string|null=await redisConnection.hget(QID,ACCESSTOKEN);
  if (currentToken===access_token)
  {
    return true;
  }
  else 
    return false;
  }