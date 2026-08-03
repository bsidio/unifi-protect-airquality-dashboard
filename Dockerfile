# syntax=docker/dockerfile:1

# ─────────────────────────── deps ───────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ─────────────────────────── build ──────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `next build` requires these variables to EXIST, not to be correct — nothing
# here connects to a console or a database. Real values arrive at runtime from
# the Kubernetes secret. The collector is explicitly off so the build never
# opens a socket.
ENV UNIFI_HOST=build.invalid \
    UNIFI_USER=build \
    UNIFI_PASS=build \
    CLICKHOUSE_URL=http://build.invalid:8123 \
    CLICKHOUSE_DB=unifi_aq \
    CLICKHOUSE_USER=build \
    CLICKHOUSE_PASSWORD=build \
    APP_SECRET=build-only-not-a-real-secret \
    COLLECTOR_ENABLED=false \
    NEXT_TELEMETRY_DISABLED=1

# Next inlines process.env into the Edge middleware bundle at build time, so
# AUTH_ENABLED must be baked here rather than injected at runtime — a runtime
# override would change the app but not the middleware that guards it.
# This deployment is intentionally open, so the guard is compiled out.
# Rebuild with --build-arg AUTH_ENABLED=true to require a login again.
ARG AUTH_ENABLED=false
ENV AUTH_ENABLED=${AUTH_ENABLED}

RUN npm run build

# ────────────────────────── runtime ─────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Non-sensitive defaults live here (per the cluster's onboarding guide).
# Everything secret comes from the `unifi-airquality-secrets` Kubernetes secret.
ENV APP_NAME="Air Quality" \
    AUTH_ENABLED=false \
    AUTH_USER=admin \
    UNIFI_VERIFY_SSL=0 \
    CLICKHOUSE_DB=unifi_aq \
    COLLECTOR_ENABLED=true \
    COLLECTOR_FLUSH_MS=5000 \
    COLLECTOR_DEDUPE=true

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# /api/health needs no auth-bearing state and returns booleans only, so it is
# a safe liveness target.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
