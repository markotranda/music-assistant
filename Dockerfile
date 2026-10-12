# syntax=docker/dockerfile:1

# ---- Build stage: install workspace deps and build all packages ----
FROM node:26-slim AS build
WORKDIR /app
# Corepack is no longer bundled with Node 25+; install pnpm directly (pinned to
# the version in package.json "packageManager").
RUN npm install --global pnpm@12.11.2

# Dependency manifests first for layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY packages/core/package.json packages/core/
COPY packages/integrations/package.json packages/integrations/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ---- Runtime stage: node + ffmpeg + yt-dlp (with EJS scripts + Node JS runtime) ----
FROM node:26-slim AS runtime

# yt-dlp must be installed via pip (not as a bare binary) so its EJS challenge
# scripts are present; the Node runtime in this image executes them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
  && pip3 install --break-system-packages --no-cache-dir --upgrade yt-dlp yt-dlp-ejs \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/apps/server/dist/server.js ./server.js
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/apps/web/dist ./web

RUN useradd --system --uid 1001 --create-home ma \
  && mkdir -p /app/data /app/collection \
  && chown -R ma:ma /app
USER ma

ENV PORT=8787
ENV MA_WEB_DIR=./web
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
