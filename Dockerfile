FROM oven/bun:1.3.14 AS scanner
RUN apt-get update && apt-get install -y --no-install-recommends clamav clamav-freshclam ca-certificates && rm -rf /var/lib/apt/lists/*

FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY web ./web
COPY scripts ./scripts
RUN bun install --frozen-lockfile
RUN bun run build
FROM scanner
WORKDIR /app
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/package.json ./package.json
COPY --from=build --chown=bun:bun /app/shared ./shared
COPY --from=build --chown=bun:bun /app/server ./server
COPY --from=build --chown=bun:bun /app/scripts ./scripts
COPY --chown=bun:bun config ./config
COPY --from=build --chown=bun:bun /app/web/dist ./web/dist
RUN mkdir -p /app/data /app/backups && chown -R bun:bun /app/data /app/backups
ENV NODE_ENV=production PORT=3000 STEWARD_CLAMSCAN_PATH=/app/scripts/clamscan.sh
EXPOSE 3000
USER bun
ENTRYPOINT ["sh", "/app/scripts/container-entrypoint.sh"]
CMD ["bun", "server/src/index.ts"]
