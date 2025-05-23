import dayjs from 'dayjs'
import { KiteOrder } from '../types/kite'
import {  SUPPORTED_TRADE_CONFIG } from '../types/trade'
import { USER_OVERRIDE,COMPLETED_BY_TAG } from './constants'
import console from './logging'

import { Promise } from 'bluebird'
import autoSquareOffStrat,{squareOffTag}  from './exit-strategies/autoSquareOff';
import {
  // logDeep,
  patchDbTrade,
  round,
  getInstrumentPrice,
  syncGetKiteInstance,
  withRemoteRetry,
  getTimeLeftInMarketClosingMs,
  isTimeAfterAutoSquareOff,
  getCompletedOrdersbyTag,
  getValuesfromDB,
  putValuestoDb
} from './utils'

const targetPnL = async ({
  _kite,
  initialJobData,
    rawKiteOrdersResponse
  }:{
    _kite?:any,
    initialJobData: SUPPORTED_TRADE_CONFIG
    rawKiteOrdersResponse: KiteOrder []
  }) :Promise<any> =>
  {
    const {isMaxLossEnabled,orderTag,isMaxProfitEnabled,
    isAutoSquareOffEnabled,autoSquareOffProps:{time}={}} = initialJobData;


    if (getTimeLeftInMarketClosingMs() < 0 ||
    (isAutoSquareOffEnabled &&
      isTimeAfterAutoSquareOff(time!))) {
    return Promise.resolve(
      '🟢 [targetPnL] Terminating the targetPnl queue as market closing or after square off time..'
    )
  }
  const kite = _kite || syncGetKiteInstance(initialJobData.user)
  const completedOrders:COMPLETED_BY_TAG[]= await getCompletedOrdersbyTag(orderTag!, kite)

  const totalPoints=await completedOrders.reduce(async (prev,current)=>{
    const currentPosition=await (prev);
    if (current.quantity==0)
      currentPosition.points+=current.points;
    else
    {
      const underlyingLTP = await withRemoteRetry(async () =>
                getInstrumentPrice(kite,current.tradingsymbol, 'NFO'));
      currentPosition.points+=current.points+ (current.quantity>0?underlyingLTP:-1*underlyingLTP); 
      currentPosition.areAllOrdersCompleted=false;
      
    }
    return currentPosition;
  },Promise.resolve({points:0,
    areAllOrdersCompleted:true
    }))
    totalPoints.points=round(totalPoints.points);
    let dbData:any = null;
  try {
        dbData=await getValuesfromDB(initialJobData.id!)

    // if (!(dbData?.trailingMaxProfitPoints))
    //  {
    //     dbData.trailingMaxProfitPoints=maxProfitPoints
    //     dbData.trailingMaxLossPoints=-1*maxLossPoints!
    //  }
    dbData.lastTargetAt=dayjs().format();
    dbData.currentPoints=totalPoints.points;
    console.log(`[targetPnL] Current points for ${orderTag}: ${dbData.currentPoints}`);
    // await patchDbTrade({
    //   id: initialJobData.id!,
    //   patchProps: {
    //     lastTargetAt: dayjs().format(),
    //     currentPoints:totalPoints.points
    //   }
    // })
  } catch (error) {
    console.log('[targetPnL]error in patchDbTrade', error)
  }
  if (totalPoints.areAllOrdersCompleted)
        {
         console.log(`[targetPnL] ${orderTag} all orders are completed`);
         return Promise.resolve('[targetPnL] all orders are completed')
        }
  else if (isMaxProfitEnabled && totalPoints.points>(dbData.trailingMaxProfitPoints!))
 /*
1. Update the db with the trailingMaxLossPoints,trailingMaxProfitPoints
2. 

*/
    
  {
    dbData.trailingMaxLossPoints=dbData.trailingMaxProfitPoints!
    dbData.trailingMaxProfitPoints=round(1.2*dbData.trailingMaxProfitPoints!)
    await putValuestoDb(initialJobData.id!,dbData);
    
    // try{
    //     await squareOffTag(orderTag!, kite)
    // }
    // catch (error) {
    //   console.log('[targetPnL]error in squaring Off', error)

    // }
    return Promise.reject(new Error(`[targetPnL] Updated with new profit ${dbData.trailingMaxProfitPoints} and SL ${dbData.trailingMaxLossPoints}`));
    //Square off the tag
  }
  else if
  (isMaxLossEnabled && totalPoints.points<(dbData.trailingMaxLossPoints!))
  {
    console.log(`[targetPnL]squaring Off as loss is breached ${dbData.trailingMaxLossPoints}`);
    await putValuestoDb(initialJobData.id!,dbData);
    try{
        await squareOffTag(orderTag!, kite)
    }
    catch (error) {
      console.log('[targetPnL]error in squaring Off', error)

    }
    return Promise.resolve('[targetPnL] orders are squared off as loss has been breached');
    //Square off the tag
  }
  else
  {
    await putValuestoDb(initialJobData.id!,dbData);
  const rejectMsg = `🟢[targetPnL] retry for tag: ${orderTag} Points: ${totalPoints.points} `;
    return Promise.reject(new Error(rejectMsg));
  }
  }
export default targetPnL;