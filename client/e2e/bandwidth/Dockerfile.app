# The root Dockerfile, plus one thing it deliberately never does: bake dev
# auth bypass into the client bundle. `VITE_*` values are inlined by Vite at
# build time, not read at runtime, so there is no environment variable that
# turns it on in an image built from the root Dockerfile — this harness needs
# its own build. Build context is the repo root (see docker-compose.yml).
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json ./server/
COPY client/package.json ./client/
COPY electron/package.json ./electron/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=deps /app/client/node_modules ./client/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
# Same-origin: this image serves the client and the API from one port, so the
# client needs no VITE_API_URL/VITE_WS_URL (docs/HANDOVER.md pitfall #3 is
# about a *static-only* host like Pages, which is not this).
ENV VITE_DEV_AUTH_BYPASS=true
RUN pnpm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json ./server/
COPY packages/shared/package.json ./packages/shared/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/client/dist ./client/dist
RUN pnpm install --prod --filter @pqp/server --filter @pqp/shared --frozen-lockfile
USER node
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
