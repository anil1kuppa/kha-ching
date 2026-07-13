import { STRATEGIES } from "../../lib/constants"
import ATMStraddleDetails from "../trades/atmStraddle/TradeSetupDetails"
import ATMStrangleDetails from "../trades/atmStrangle/TradeSetupDetails"
import { SUPPORTED_TRADE_CONFIG } from "../../types/trade"
import { Job } from "bullmq"

const TradeDetails = ({
  strategy,
  tradeDetails,
  jobDetails,
}: {
  strategy: STRATEGIES
  tradeDetails: SUPPORTED_TRADE_CONFIG
  jobDetails?: Job
}) => {
  return (
    <>
      {strategy === STRATEGIES.ATM_STRADDLE ? (
        <ATMStraddleDetails {...tradeDetails} {...jobDetails} />
      ) : strategy === STRATEGIES.ATM_STRANGLE ? (
        <ATMStrangleDetails {...tradeDetails} {...jobDetails} />
      ) : strategy === STRATEGIES.SUBSCRIBE_CHASE ? (
        <p style={{ margin: "8px 0" }}>Lots: {(tradeDetails as any).lots ?? "—"}</p>
      ) : null}
    </>
  )
}

export default TradeDetails
