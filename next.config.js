const withPWA = require('next-pwa')

module.exports = withPWA({
  images: {
    unoptimized: true
  },
  disable: process.env.NODE_ENV !== 'production',
  dest: 'public'
})
