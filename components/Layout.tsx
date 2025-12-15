import Container from '@mui/material/Container'
import React from 'react'

import Header from './Header'

const Layout = ({ children }) => (
  <>
    <Header />

    <main style={{ paddingBottom: '60px' }}>
      <Container maxWidth='sm'>{children}</Container>
    </main>
  </>
)

export default Layout
