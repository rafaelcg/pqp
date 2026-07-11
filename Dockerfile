FROM node:22-alpine AS base
# pnpm version comes from the root package.json "packageManager" field.
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

# Run as the unprivileged built-in node user rather than root.
USER node

EXPOSE 3001
CMD ["node", "server/dist/index.js"]
