import { createMuiTheme } from '@mui/material/styles'

// Create a theme instance.
const theme = createMuiTheme({
  palette: {
    primary: {
      main: '#556cd6',
      contrastText: '#fff'
    },
    secondary: {
      main: '#19857b',
      contrastText: '#fff'
    },
    error: {
      main: '#e83d55',
      contrastText: '#fff'
    },
    warning: {
      main: '#ff9800',
      contrastText: '#fff'
    },
    info: {
      main: '#2196f3',
      contrastText: '#fff'
    },
    success: {
      main: '#4caf50',
      contrastText: '#fff'
    },
    background: {
      default: '#fff'
    }
  }
})

export default theme
