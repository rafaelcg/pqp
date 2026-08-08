# The ambient runner, as a machine of its own.
#
# Separate from the API's Dockerfile at the repo root on purpose: this is a
# different service with a different lifecycle, and coupling them would mean
# every persona edit redeploys the API and every API deploy restarts the cast
# mid-scene.
#
# It builds from the REPO ROOT, not from this directory, because provisioning
# reuses `server/dist/services/characters.js` — the whole point of that reuse is
# that there is one implementation of how a character account is minted, and the
# image has to carry it.
#
#   fly deploy --config tools/ambient/fly.toml --dockerfile tools/ambient/Dockerfile
FROM node:22-slim AS build

WORKDIR /repo
RUN corepack enable

# The server + shared build, for `provision.mjs`. Copied narrowly so a change to
# the client or the docs does not invalidate this layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
RUN pnpm install --frozen-lockfile --filter @pqp/shared --filter @pqp/server

COPY packages/shared packages/shared
COPY server server
RUN pnpm --filter @pqp/shared build && pnpm --filter @pqp/server build

# ------------------------------------------------------------------- runtime
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# The runner's own install — two dependencies, outside the workspace.
COPY tools/ambient/package.json tools/ambient/package-lock.json* ./tools/ambient/
RUN cd tools/ambient && npm install --omit=dev --no-audit --no-fund

COPY tools/ambient ./tools/ambient
COPY --from=build /repo/server/dist ./server/dist
COPY --from=build /repo/server/node_modules ./server/node_modules
COPY --from=build /repo/packages/shared ./packages/shared

# Durable state — memory, placements, the audit log — lives on the volume, not
# in the image. Overwritten by the `[mounts]` block in fly.toml.
ENV AMBIENT_STATE_DIR=/data
VOLUME /data

WORKDIR /app/tools/ambient
CMD ["node", "src/runner.js", "--watch"]
