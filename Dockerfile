# syntax=docker/dockerfile:1.7
# Comb — production image. Build: docker build -t comb:1.5.0 .
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm -w web run build && npm -w server run typecheck

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# Runtime deps only; install scripts stay off (no native builds are required).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace server --workspace shared

FROM node:24-bookworm-slim
# pg_dump/pg_restore for the built-in logical backups.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system comb && useradd --system --gid comb --home /app --shell /usr/sbin/nologin comb
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 COMB_WEB_DIST=/app/web/dist COMB_BACKUP_DIR=/data/backups
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server/src ./server/src
COPY --from=build /app/server/migrations ./server/migrations
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/package.json ./package.json
RUN mkdir -p /data/backups && chown -R comb:comb /data
USER comb
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/src/index.ts"]
