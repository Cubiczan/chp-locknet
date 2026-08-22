# CHP Locknet — Nosana Deployment
# Optimized for $70 credit budget: Simple strategy, short timeout, single replica

FROM node:20-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN npm install --production 2>&1 || true

# Copy source
COPY . .

# Build Next.js
RUN npx next build

# Expose port
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["npx", "next", "start", "-p", "3000"]
