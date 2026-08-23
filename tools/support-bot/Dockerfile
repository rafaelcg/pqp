# The support bot, as a machine of its own.
#
# Separate from `tools/ambient`'s image and from the API's, for the same reason
# they are separate from each other: different lifecycle, different blast
# radius, different kill switch. A fact-file edit should redeploy this and
# nothing else, and this process wedging should take down support answers, not
# the chat server.
#
# It builds from the REPO ROOT, not from this directory, because the bot imports
# the ambient runner's wire client, identity, log and rate-cap modules by
# relative path. That reuse is deliberate (one implementation of how this
# product's protocol is spoken), so the image has to carry both trees.
#
#   fly deploy --config tools/support-bot/fly.toml --dockerfile tools/support-bot/Dockerfile
#
# NO SERVER BUILD HERE, unlike the ambient image. `provision.mjs` and
# `join-server.mjs` need `server/dist`, but those are operator actions run from
# a laptop against DATABASE_URL, never from this machine. The running bot only
# ever speaks HTTP and WebSocket, so the image stays small.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Its own install, outside the pnpm workspace. One optional dependency (the
# Anthropic SDK); `--omit=dev` keeps devDependencies out but still installs
# optionalDependencies, which is exactly what is wanted.
COPY tools/support-bot/package.json tools/support-bot/package-lock.json* ./tools/support-bot/
RUN cd tools/support-bot && npm install --omit=dev --no-audit --no-fund

COPY tools/support-bot ./tools/support-bot
# Only `src`. The ambient runner's personas.yaml, fixtures and scripts are not
# this service's business and must not be reachable from it.
COPY tools/ambient/src ./tools/ambient/src
COPY tools/ambient/package.json ./tools/ambient/package.json

# The ledger, the audit log and the escalation list live on the volume, not in
# the image. The ledger especially: a daily spend ceiling that resets whenever
# the machine restarts is not a ceiling, and restarting is what happens when
# something is going wrong.
ENV SUPPORT_STATE_DIR=/data
VOLUME /data

WORKDIR /app/tools/support-bot
CMD ["node", "src/bot.js", "--watch"]
