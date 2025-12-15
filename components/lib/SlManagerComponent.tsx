import {
  FormControl,
  FormControlLabel, FormLabel, Grid, Radio, RadioGroup, TextField, Typography
} from '@mui/material'
import {
  COMBINED_SL_EXIT_STRATEGY_LABEL,
  EXIT_STRATEGIES,
  EXIT_STRATEGIES_DETAILS
} from '../../lib/constants'
import { COMBINED_SL_EXIT_STRATEGY, SL_ORDER_TYPE } from '../../types/plans'

const SlManagerComponent = ({ state, onChange, exitStrategies }) => {
  const slOrderTypes = [SL_ORDER_TYPE.SLL]
  return (
    <>
      <Grid item xs={12}>
        <FormControl component='fieldset'>
          <FormLabel component='legend'>Exit Strategy</FormLabel>
          <RadioGroup
            aria-label='exitStrategy'
            name='exitStrategy'
            value={state.exitStrategy}
            onChange={e =>
              onChange({ exitStrategy: e.target.value as EXIT_STRATEGIES,
                isMaxLossEnabled:false,
                isMaxProfitEnabled:false,
               })
            }
          >
            {exitStrategies.map(exitStrategy => (
              <FormControlLabel
                key={exitStrategy}
                value={exitStrategy}
                control={<Radio size='small' />}
                label={
                  <Typography variant='body2'>
                    {EXIT_STRATEGIES_DETAILS[exitStrategy].label}
                  </Typography>
                }
              />
            ))}
          </RadioGroup>
        </FormControl>
      </Grid>
      {state.exitStrategy === EXIT_STRATEGIES.MULTI_LEG_PREMIUM_THRESHOLD ? (
        <>
          <Grid item xs={12}>
            <FormLabel component='legend'>
              When Combined trailing SL triggers
            </FormLabel>
            <RadioGroup
              aria-label='combinedExitStrategy'
              name='combinedExitStrategy'
              value={state.combinedExitStrategy}
              onChange={e =>
                onChange({
                  combinedExitStrategy: e.target
                    .value as COMBINED_SL_EXIT_STRATEGY
                })
              }
            >
              {[
                COMBINED_SL_EXIT_STRATEGY.EXIT_ALL,
                COMBINED_SL_EXIT_STRATEGY.EXIT_LOSING
              ].map(combinedExitStrategy => (
                <FormControlLabel
                  key={combinedExitStrategy}
                  value={combinedExitStrategy}
                  control={<Radio size='small' />}
                  label={
                    <Typography variant='body2'>
                      {COMBINED_SL_EXIT_STRATEGY_LABEL[combinedExitStrategy]}
                    </Typography>
                  }
                />
              ))}
            </RadioGroup>
          </Grid>

          <Grid item xs={12}>
            <TextField
              fullWidth
              name='trailEveryPercentageChangeValue'
              value={state.trailEveryPercentageChangeValue}
              onChange={e =>
                onChange({
                  trailEveryPercentageChangeValue: +e.target.value || undefined
                })
              }
              label='Trail SL everytime total premium decreases by %'
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              fullWidth
              name='trailingSlPercent'
              value={state.trailingSlPercent}
              onChange={e =>
                onChange({ trailingSlPercent: +e.target.value || undefined })
              }
              label='Trailing SL %'
            />
          </Grid>
        </>
      ) : null}
      {(state.exitStrategy === EXIT_STRATEGIES.MULTI_LEG_PREMIUM_THRESHOLD ||
        state.exitStrategy === EXIT_STRATEGIES.INDIVIDUAL_LEG_SLM_1X) ? (
        <>
          <Grid item xs={12} style={{ marginBottom: '16px' }}>
            <TextField
              fullWidth
              name='slmPercent'
              value={state.slmPercent}
              onChange={(e: any) => onChange({ slmPercent: +e.target.value || undefined })}
              label={
                state.exitStrategy === EXIT_STRATEGIES.MULTI_LEG_PREMIUM_THRESHOLD
                  ? 'Initial SL %'
                  : 'SL %'
              }
            />
          </Grid>
        </>
      ) : null}
    </>
  )
}

export default SlManagerComponent
