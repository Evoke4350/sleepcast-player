# syntax=docker/dockerfile:1.7
# ── base ─────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# ── deps (cacheable layer) ───────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── build ────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV ASTRO_TELEMETRY_DISABLED=1
RUN npm run build

# ── runtime ──────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
ENV ASTRO_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOST=0.0.0.0

# The standalone adapter emits both the server and the client assets under
# dist/, and serves the client ones itself — no separate web server needed.
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules

# Nothing here writes to disk: no database, no uploads, no session store. The
# only state is in the visitor's browser, so the container can run unprivileged
# and be replaced at any moment.
USER node
EXPOSE 3000
CMD ["node", "./dist/server/entry.mjs"]
