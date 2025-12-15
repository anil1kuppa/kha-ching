import React from 'react'
import Document, { Head, Html, Main, NextScript } from 'next/document'

import theme from '../src/theme'

export default class MyDocument extends Document {
  render () {
    return (
      <Html lang='en'>
        <Head>
          {/* PWA primary color */}
          <meta name='theme-color' content={theme.palette.primary.main} />
          <link
            rel='stylesheet'
            href='https://fonts.googleapis.com/css?family=Roboto:300,400,500,700&display=swap'
          />
          <script
            dangerouslySetInnerHTML={{
              __html: `
                var beamer_config = {
                  product_id : "aMuOMEAg34072" //DO NOT CHANGE: This is your product code on Beamer
                };
              `
            }}
          />
          <script
            type='text/javascript'
            src='https://app.getbeamer.com/js/beamer-embed.js'
            defer='defer'
          />
        </Head>
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    )
  }
}
