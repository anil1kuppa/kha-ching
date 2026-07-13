import Chip from "@mui/material/Chip"
import React from "react"

export default function PnLComponent({ pnl }) {
  return (
    <Chip
      label={`₹${pnl} ${pnl < 0 ? "🥵" : "🎉"}`}
      color={pnl < 0 ? "error" : "success"}
      style={{ fontWeight: "bold" }}
    />
  )
}
