import Table from "@mui/material/Table"
import TableBody from "@mui/material/TableBody"
import TableCell from "@mui/material/TableCell"
import TableContainer from "@mui/material/TableContainer"
import TableHead from "@mui/material/TableHead"
import TableRow from "@mui/material/TableRow"
import React from "react"

export default function OrdersTable({ rows = [] }) {
  const safeRows = Array.isArray(rows) ? rows.filter(Boolean) : []

  return (
    <TableContainer>
      <Table size="small" sx={{ maxWidth: "100%" }}>
        <TableBody>
          {safeRows.map((row, idx) => {
            const cells = Array.isArray(row) ? row : [{ value: row }]

            return (
              <TableRow key={idx}>
                {cells.map((cell, rIdx) => (
                  <TableCell
                    key={rIdx}
                    align={(cell && cell.align) || "left"}
                    style={idx === 0 ? { fontWeight: 900 } : null}
                  >
                    {cell && cell.value != null ? cell.value : ""}
                  </TableCell>
                ))}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </TableContainer>
  )
}
