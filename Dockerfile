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

# Runtime as non-root; Next.js writes cache under .next
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --create-home nextjs \
    && mkdir -p /app/.next \
    && chown -R nextjs:nodejs /app/.next

USER nextjs

CMD ["npx", "next", "start", "-p", "3000"]
