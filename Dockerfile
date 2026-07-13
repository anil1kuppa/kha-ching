# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable

# Copy package files
COPY package.json yarn.lock .yarnrc.yml ./

# Install dependencies
RUN yarn install --immutable

# Copy source code
COPY . .

# Build the application
RUN yarn build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

# Copy package files
COPY package.json yarn.lock .yarnrc.yml ./

# Reuse node_modules from builder instead of reinstalling
COPY --from=builder /app/node_modules ./node_modules

# Copy built application from builder
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/pages ./pages
COPY --from=builder /app/next.config.js ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/server.js ./
COPY --from=builder /app/otel.js ./
COPY --from=builder /app/bootup.js ./
COPY --from=builder /app/drizzle.config.js ./
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts ./scripts

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=90s --timeout=13s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start the application
CMD ["yarn", "start"]

# Dev stage — all deps installed, source mounted via docker-compose volume
FROM node:20-alpine AS dev

WORKDIR /app

RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

EXPOSE 3000
CMD ["yarn", "run", "dev"]
