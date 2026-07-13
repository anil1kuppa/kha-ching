import { Box, Container, Link, Paper, TextField } from "@mui/material"
import Accordion from "@mui/material/Accordion"
import AccordionDetails from "@mui/material/AccordionDetails"
import AccordionSummary from "@mui/material/AccordionSummary"
import Backdrop from "@mui/material/Backdrop"
import Button from "@mui/material/Button"
import Chip from "@mui/material/Chip"
import Fade from "@mui/material/Fade"
import FormControl from "@mui/material/FormControl"
import Grid from "@mui/material/Grid"
import InputLabel from "@mui/material/InputLabel"
import MenuItem from "@mui/material/MenuItem"
import Modal from "@mui/material/Modal"
import Select from "@mui/material/Select"
import Typography from "@mui/material/Typography"
import ExpandMoreIcon from "@mui/icons-material/ExpandMore"
import axios from "axios"
import { omit } from "lodash"
import React, { useEffect, useState } from "react"
import Layout from "../components/Layout"
import ATMStraddleTradeForm from "../components/trades/atmStraddle/TradeSetupForm"
import ATMStrangleTradeForm from "../components/trades/atmStrangle/TradeSetupForm"
import { getSchedulingStateProps } from "../lib/browserUtils"
import { EXPIRY_TYPE, INSTRUMENTS, INSTRUMENT_DETAILS, PRODUCT_TYPE, STRATEGIES, STRATEGIES_DETAILS } from "../lib/constants"
import useUser from "../lib/useUser"
import { DailyPlansConfig, DailyPlansDayKey } from "../types/misc"
import { ATM_STRADDLE_CONFIG, ATM_STRANGLE_CONFIG, AvailablePlansConfig } from "../types/plans"

/**
 *
 * remote storage
 *
 * https://api.signalx.trade/key_16_digit_api_key/dayOfWeek
 */

interface StrategySelection {
  dayOfWeek: DailyPlansDayKey
  selectedStrategy: STRATEGIES
}

const getDefaultState = (strategy: STRATEGIES): AvailablePlansConfig =>
  ({
    ...STRATEGIES_DETAILS[strategy].defaultFormState,
    ...getSchedulingStateProps(strategy),
  }) as unknown as AvailablePlansConfig

const resetDefaultStratState = (): Record<STRATEGIES, AvailablePlansConfig> => {
  return {
    [STRATEGIES.ATM_STRADDLE]: getDefaultState(STRATEGIES.ATM_STRADDLE),
    [STRATEGIES.ATM_STRANGLE]: getDefaultState(STRATEGIES.ATM_STRANGLE),
    [STRATEGIES.SUBSCRIBE_CHASE]: getDefaultState(STRATEGIES.SUBSCRIBE_CHASE),
  } as Record<STRATEGIES, AvailablePlansConfig>
}

const Plan = () => {
  useUser({ redirectTo: "/" })

  const [dayState, setDayState] = useState<DailyPlansConfig>({
    monday: {
      heading: "Monday",
      selectedStrategy: "",
      strategies: {},
    },
    tuesday: {
      heading: "Tuesday",
      selectedStrategy: "",
      strategies: {},
    },
    wednesday: {
      heading: "Wednesday",
      selectedStrategy: "",
      strategies: {},
    },
    thursday: {
      heading: "Thursday",
      selectedStrategy: "",
      strategies: {},
    },
    friday: {
      heading: "Friday",
      selectedStrategy: "",
      strategies: {},
    },
  })
  const [open, setOpen] = useState(false)
  const [currentEditDay, setCurrentEditDay] = useState<DailyPlansDayKey>()
  const [currentEditStrategy, setCurrentEditStrategy] = useState<STRATEGIES>()

  const [stratState, setStratState] = useState(resetDefaultStratState)

  const handleOpen = () => {
    setOpen(true)
  }

  const handleClose = () => {
    setOpen(false)
  }

  const handleSelectStrategy = ({ dayOfWeek, selectedStrategy }: StrategySelection) => {
    setDayState({
      ...dayState,
      [dayOfWeek]: {
        ...dayState[dayOfWeek],
        selectedStrategy,
      },
    })
  }

  const onClickConfigureStrategy = ({ dayOfWeek, selectedStrategy }: StrategySelection) => {
    setCurrentEditDay(dayOfWeek)
    setCurrentEditStrategy(selectedStrategy)
    setStratState(resetDefaultStratState())
    handleOpen()
  }

  const stratOnChangeHandler = (
    changedProps: Partial<AvailablePlansConfig>,
    strategy: STRATEGIES
  ) => {
    if ("instruments" in changedProps && changedProps.instruments != null) {
      setStratState({
        ...stratState,
        [strategy]: {
          ...stratState[strategy],
          instruments: {
            ...(stratState[strategy] as ATM_STRADDLE_CONFIG | ATM_STRANGLE_CONFIG).instruments,
            ...(changedProps as ATM_STRADDLE_CONFIG | ATM_STRANGLE_CONFIG).instruments,
          },
        },
      })
    } else {
      setStratState({
        ...stratState,
        [strategy]: {
          ...stratState[strategy],
          ...changedProps,
        },
      })
    }
  }

  const commonOnCancelHandler = () => {
    handleClose()
  }

  const cleanupForRemoteSync = (props: AvailablePlansConfig) => {
    return omit(props, ["instruments", "disableInstrumentChange"])
  }

  const commonOnSubmitHandler = async (
    formattedStateForApiProps: AvailablePlansConfig
  ): Promise<any> => {
    const selectedConfig = stratState[currentEditStrategy!]
    // console.log('commonOnSubmitHandler', selectedConfig)

    if (currentEditStrategy === STRATEGIES.SUBSCRIBE_CHASE) {
      const chaseConfig = cleanupForRemoteSync({
        ...selectedConfig,
        strategy: STRATEGIES.SUBSCRIBE_CHASE,
        name: "Chase",
        instrument: INSTRUMENTS.NIFTY,
        expiryType: EXPIRY_TYPE.CURRENT,
        productType: PRODUCT_TYPE.NRML,
      } as any)

      let chaseUpdatedConfig
      if (selectedConfig.id) {
        await axios.put("/api/plan", {
          id: selectedConfig.id,
          dayOfWeek: currentEditDay?.toUpperCase(),
          config: chaseConfig,
        })
        chaseUpdatedConfig = { [selectedConfig.id]: { ...chaseConfig, id: selectedConfig.id } }
      } else {
        const { data: newConfig } = await axios.post("/api/plan", {
          dayOfWeek: currentEditDay?.toUpperCase(),
          config: [chaseConfig],
        })
        chaseUpdatedConfig = { [newConfig.id]: newConfig }
      }

      setDayState({
        ...dayState,
        [currentEditDay as string]: {
          ...dayState[currentEditDay!],
          strategies: {
            ...dayState[currentEditDay!].strategies,
            ...chaseUpdatedConfig,
          },
        },
      })
      handleClose()
      return
    }

    let updatedConfig
    if (selectedConfig.id) {
      // editing an existing strategy
      await axios.put("/api/plan", {
        id: selectedConfig.id,
        dayOfWeek: currentEditDay?.toUpperCase(),
        config: cleanupForRemoteSync({
          ...selectedConfig,
          ...formattedStateForApiProps,
        } as AvailablePlansConfig),
      })

      updatedConfig = { [selectedConfig.id]: selectedConfig }
    } else {
      // creating a new strategy
      const straddleOrStrangleConfig = selectedConfig as ATM_STRADDLE_CONFIG | ATM_STRANGLE_CONFIG
      const config = Object.keys(straddleOrStrangleConfig.instruments)
        .filter(instrument => straddleOrStrangleConfig.instruments[instrument])
        .map(
          (instrument): AvailablePlansConfig => ({
            ...selectedConfig,
            ...formattedStateForApiProps,
            instrument: instrument as INSTRUMENTS,
            strategy: currentEditStrategy as any,
          })
        )
        .map(cleanupForRemoteSync)

      const { data: newStrategyConfig } = await axios.post("/api/plan", {
        dayOfWeek: currentEditDay?.toUpperCase(),
        config,
      })

      // updatedConfig = newStrategyConfig.reduce(
      //   (accum, item) => ({
      //     ...accum,
      //     [item.id]: item
      //   }),
      //   {}
      // )
      console.log("[plan.tsx]:", newStrategyConfig)
      updatedConfig = { [newStrategyConfig.id]: newStrategyConfig }
      //updatedConfig[newStrategyConfig.id]=newStrategyConfig
    }

    setDayState({
      ...dayState,
      [currentEditDay as string]: {
        ...dayState[currentEditDay!],
        strategies: {
          ...dayState[currentEditDay!].strategies,
          ...updatedConfig,
        },
      },
    })
    handleClose()
  }

  const handleEditStrategyConfig = ({
    dayOfWeek,
    strategyKey,
  }: {
    dayOfWeek: DailyPlansDayKey
    strategyKey: string
  }) => {
    setCurrentEditDay(dayOfWeek)
    const stratConfig = dayState[dayOfWeek].strategies[strategyKey]
    const { strategy } = stratConfig
    setCurrentEditStrategy(strategy)

    if (strategy === STRATEGIES.SUBSCRIBE_CHASE) {
      setStratState({
        ...stratState,
        [strategy]: {
          ...STRATEGIES_DETAILS[strategy].defaultFormState,
          ...stratConfig,
        },
      })
    } else {
      setStratState({
        ...stratState,
        [strategy]: {
          ...STRATEGIES_DETAILS[strategy].defaultFormState,
          ...stratConfig,
          instruments: { [stratConfig.instrument]: true } as Record<INSTRUMENTS, boolean>,
          disableInstrumentChange: true,
        },
      })
    }

    handleOpen()
  }

  const handleDeleteStrategyConfig = async ({
    dayOfWeek,
    strategyKey,
  }: {
    dayOfWeek: DailyPlansDayKey
    strategyKey: string
  }) => {
    const stratConfig = dayState[dayOfWeek].strategies[strategyKey]
    await axios.delete("/api/plan", {
      // notice the change in payload for delete request
      data: {
        dayOfWeek: currentEditDay,
        config: stratConfig,
      },
    })

    setDayState({
      ...dayState,
      [dayOfWeek]: {
        ...dayState[dayOfWeek],
        strategies: Object.keys(dayState[dayOfWeek].strategies)
          .filter(key => key !== strategyKey)
          .reduce(
            (accum, key) => ({
              ...accum,
              [key]: dayState[dayOfWeek].strategies[key],
            }),
            {}
          ),
      },
    })
  }

  // useEffect(() => {
  //   console.log('dayState updated', dayState);
  // }, []);

  useEffect(() => {
    async function fn() {
      const { data } = await axios("/api/plan")
      const dayWiseData = data.reduce((accum, config) => {
        const dayKey = (config.day_of_week || config.dayOfWeek || config.collection)?.toLowerCase()
        if (!dayKey) {
          return accum
        }

        if (accum[dayKey]) {
          return {
            ...accum,
            [dayKey]: {
              ...accum[dayKey],
              [config.id]: config,
            },
          }
        }
        return {
          ...accum,
          [dayKey]: { [config.id]: config },
        }
      }, {})
      const updatedDayState: DailyPlansConfig = Object.keys(dayState).reduce(
        (accum: any, dayKey: DailyPlansDayKey) => {
          return {
            ...accum,
            [dayKey]: {
              ...dayState[dayKey],
              strategies: dayWiseData[dayKey] || {},
            },
          }
        },
        {}
      )

      setDayState(updatedDayState)
    }

    fn()
  }, [])

  return (
    <Layout>
      <Typography variant="h5" component="h1" style={{ marginBottom: 16 }}>
        Your daily trade plan
      </Typography>
      {Object.keys(dayState).map((dayOfWeek: DailyPlansDayKey) => {
        const dayProps = dayState[dayOfWeek]
        return (
          <Accordion key={dayOfWeek}>
            <AccordionSummary
              expandIcon={<ExpandMoreIcon />}
              aria-controls={`${dayOfWeek}-content`}
              id={`${dayOfWeek}-header`}
            >
              <Typography sx={{ fontSize: "0.9375rem", fontWeight: 400 }}>
                {dayProps.heading}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ flexDirection: "column" }}>
              {Object.keys(dayProps.strategies).length > 0 ? (
                <>
                  <Typography component="p" variant="subtitle1">
                    Saved trades — (click to edit, or cross to delete)
                  </Typography>
                  <Box
                    sx={{
                      display: "flex",
                      flexWrap: "wrap",
                      marginBottom: "16px",
                      "& > *": { margin: "4px" },
                    }}
                  >
                    {Object.keys(dayProps.strategies)
                      .filter(
                        strategyKey => dayProps.strategies[strategyKey].strategy in stratState
                      )
                      .map(strategyKey => {
                        const config = dayProps.strategies[strategyKey]
                        return (
                          <Chip
                            color="secondary"
                            key={`${dayOfWeek}_${strategyKey}`}
                            label={`${config.name}`}
                            onClick={() =>
                              handleEditStrategyConfig({
                                dayOfWeek,
                                strategyKey,
                              })
                            }
                            onDelete={async () =>
                              await handleDeleteStrategyConfig({
                                dayOfWeek,
                                strategyKey,
                              })
                            }
                          />
                        )
                      })}
                  </Box>
                </>
              ) : null}
              <Grid container alignItems="flex-start" spacing={2}>
                <FormControl sx={{ m: 1, minWidth: 120 }}>
                  <InputLabel id={`${dayOfWeek}_label`}>Select trade here</InputLabel>
                  <Select
                    labelId={`${dayOfWeek}_label`}
                    id={`${dayOfWeek}_strat_select`}
                    value={dayProps.selectedStrategy}
                    style={{ minWidth: 200 }}
                    onChange={e =>
                      handleSelectStrategy({
                        dayOfWeek,
                        selectedStrategy: e.target.value as STRATEGIES,
                      })
                    }
                  >
                    {[STRATEGIES.ATM_STRADDLE, STRATEGIES.ATM_STRANGLE, STRATEGIES.SUBSCRIBE_CHASE].map(strategyKey => (
                      <MenuItem value={strategyKey} key={`${dayOfWeek}_${strategyKey}`}>
                        {STRATEGIES_DETAILS[strategyKey].heading}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Grid item xs={12}>
                  <Button
                    variant="contained"
                    color="primary"
                    type="button"
                    onClick={() =>
                      onClickConfigureStrategy({
                        dayOfWeek,
                        selectedStrategy: dayProps.selectedStrategy as STRATEGIES,
                      })
                    }
                  >
                    Configure
                  </Button>
                </Grid>
              </Grid>
            </AccordionDetails>
          </Accordion>
        )
      })}
      {currentEditStrategy ? (
        <Modal
          aria-labelledby="transition-modal-title"
          aria-describedby="transition-modal-description"
          sx={{
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            overflow: "auto",
            pt: 4,
          }}
          open={open}
          onClose={handleClose}
          closeAfterTransition
          slots={{ backdrop: Backdrop }}
          slotProps={{ backdrop: { timeout: 500 } }}
        >
          <Fade in={open}>
            <Container
              maxWidth="sm"
              tabIndex={-1}
              sx={{ outline: "none", position: "relative", zIndex: 1 }}
            >
              <Box>
                <Typography variant="subtitle2">
                  <Link onClick={commonOnCancelHandler} style={{ color: "white" }}>
                    &lt; cancel and go back
                  </Link>
                </Typography>
                {currentEditStrategy === STRATEGIES.SUBSCRIBE_CHASE ? (
                  <Box sx={{ backgroundColor: "background.paper", p: 3, borderRadius: 1 }}>
                    <Typography variant="h6" sx={{ mb: 2 }}>Configure Chase</Typography>
                    <TextField
                      label="Lots"
                      type="text"
                      inputMode="numeric"
                      inputProps={{ pattern: "[0-9]*" }}
                      value={
                        (stratState[STRATEGIES.SUBSCRIBE_CHASE] as any)?.lots
                          ? String((stratState[STRATEGIES.SUBSCRIBE_CHASE] as any).lots)
                          : ""
                      }
                      onChange={e => {
                        const raw = e.target.value.replace(/[^0-9]/g, "")
                        stratOnChangeHandler(
                          { lots: raw === "" ? 0 : parseInt(raw, 10) } as any,
                          STRATEGIES.SUBSCRIBE_CHASE
                        )
                      }}
                      onBlur={() => {
                        const current = (stratState[STRATEGIES.SUBSCRIBE_CHASE] as any)?.lots ?? 0
                        if (current < 1)
                          stratOnChangeHandler({ lots: 1 } as any, STRATEGIES.SUBSCRIBE_CHASE)
                      }}
                      sx={{ mb: 3 }}
                    />
                    <Box sx={{ display: "flex", gap: 2 }}>
                      <Button variant="contained" onClick={() => commonOnSubmitHandler(stratState[STRATEGIES.SUBSCRIBE_CHASE]!)}>
                        Add
                      </Button>
                      <Button onClick={commonOnCancelHandler}>Cancel</Button>
                    </Box>
                  </Box>
                ) : currentEditStrategy === STRATEGIES.ATM_STRADDLE ? (
                  <ATMStraddleTradeForm
                    formHeading={`Editing ${
                      STRATEGIES_DETAILS[currentEditStrategy].heading
                    } for ${dayState[currentEditDay!].heading}`}
                    state={stratState[STRATEGIES.ATM_STRADDLE] as ATM_STRADDLE_CONFIG}
                    onChange={changedProps =>
                      stratOnChangeHandler(changedProps, STRATEGIES.ATM_STRADDLE)
                    }
                    onSubmit={commonOnSubmitHandler}
                    onCancel={commonOnCancelHandler}
                    isRunnable={false}
                    strategy={STRATEGIES.ATM_STRADDLE}
                  />
                ) : currentEditStrategy === STRATEGIES.ATM_STRANGLE ? (
                  <ATMStrangleTradeForm
                    formHeading={`Editing ${
                      STRATEGIES_DETAILS[currentEditStrategy].heading
                    } for ${dayState[currentEditDay!].heading}`}
                    state={stratState[STRATEGIES.ATM_STRANGLE] as ATM_STRANGLE_CONFIG}
                    onChange={changedProps =>
                      stratOnChangeHandler(changedProps, STRATEGIES.ATM_STRANGLE)
                    }
                    onSubmit={commonOnSubmitHandler}
                    onCancel={commonOnCancelHandler}
                    isRunnable={false}
                    strategy={STRATEGIES.ATM_STRANGLE}
                  />
                ) : null}
              </Box>
            </Container>
          </Fade>
        </Modal>
      ) : null}
    </Layout>
  )
}

export default Plan
