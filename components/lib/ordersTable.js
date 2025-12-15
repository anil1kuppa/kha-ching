import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import React from 'react'

export default function OrdersTable ({ rows }) {
  return (
    <TableContainer>
      <Table size='small' sx={{ maxWidth: '100%' }}>
        <TableBody>
          {rows.map((row, idx) => (
            <TableRow key={idx}>
              {row.map((cell, rIdx) => (
                <TableCell
                  idx={rIdx}
                  key={cell.value}
                  align={cell.align || 'left'}
                  style={idx === 0 ? { fontWeight: 900 } : null}
                >
                  {cell.value}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}
