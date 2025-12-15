import React from 'react'
import { Box } from '@mui/material'
import Typography from '@mui/material/Typography'
import Slider from '@mui/material/Slider'

export default function DiscreteSlider ({
  label,
  defaultValue,
  step,
  min,
  max,
  value,
  onChange
}: any) {
  return (
    <Box sx={{ width: 300 }}>
      <Typography gutterBottom>{label}</Typography>
      <Slider
        value={value}
        defaultValue={defaultValue}
        step={step}
        marks
        min={min}
        max={max}
        valueLabelDisplay='auto'
        onChange={onChange}
      />
    </Box>
  )
}
