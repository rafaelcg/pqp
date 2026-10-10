# Docker Hub rate-limits anonymous pulls from shared CI runners (a 429 on this
# line blocked two API deploys on 2026-10-09). mirror.gcr.io is Google's public
# pull-through cache of the same official image: no account, no limit we hit.
FROM mirror.gcr.io/library/node:22-alpine AS base
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

# The application, shared by the two images below. Not built on its own.
FROM mirror.gcr.io/library/node:22-alpine AS app
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

# The worker image (`docker build --target worker`, tagged `<sha>-worker`):
# the same application plus ffmpeg, for the voice note AAC transcode
# (server/src/speech/transcode.ts). Only the worker runs that job, so only the
# worker pays for ffmpeg: about 131 MB uncompressed, 49 MB compressed, on
# linux/amd64 (node:22-alpine, 2026-10). A process without ffmpeg never claims
# a transcode job, so an API image doing a worker's job just leaves them queued.
FROM app AS worker
USER root
RUN apk add --no-cache ffmpeg
USER node
CMD ["node", "server/dist/worker.js"]

# The API image, and the default target: what `docker build .` and
# `fly deploy` produce, byte for byte the image this file always built.
# Last on purpose, because the last stage is the one built without --target.
FROM app AS runner
