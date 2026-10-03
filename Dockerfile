# HangKH app image — ONE image, two modes (APP_MODE=hub | shop). Architecture v2.1. Built on the owner's PC (deploy.cmd).
# Build stage: install all workspace deps, build web (vite) + server (esbuild bundle incl. @sms/shared).
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
ENV VITE_APP_NAME="One Team Service" VITE_APP_SHORT="One Team"
RUN pnpm --filter @sms/web build && pnpm --filter @sms/server build \
 && pnpm --filter @sms/server --prod deploy /out

# Runtime stage: production deps of the server only, non-root, tini as PID 1.
FROM node:22-alpine
RUN apk add --no-cache tini wget
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /src/apps/server/dist ./dist
COPY --from=build --chown=node:node /src/apps/web/dist ./web
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
USER node
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 WEB_DIST=/app/web MIGRATIONS_DIR=/app/dist/migrations HUB_MIGRATIONS_DIR=/app/dist/migrations_hub BRAND_DIR=/app/dist/brand PUB_DIR=/app/dist/pub UPLOADS_DIR=/app/data/uploads
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.mjs"]
