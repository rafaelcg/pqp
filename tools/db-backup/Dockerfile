# Nightly logical backup of production Postgres, as a scheduled Fly machine.
#
# Fly Managed Postgres (*.flympg.net) is only reachable on the org's private
# 6PN network, so the dump has to run from inside Fly. This image is that
# runner: postgresql-client-17 + aws-cli, one script, exits when done.
#
# Build and push (from this directory, so COPY sees backup.sh):
#   cd tools/db-backup && fly deploy --build-only --push --image-label v1
# Schedule (once): see docs/DB_RUNBOOK.md, "Creating the backup machine".
FROM debian:bookworm-slim

RUN set -eux; \
    apt-get update -qq; \
    apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg jq gzip coreutils; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update -qq; \
    apt-get install -y -qq --no-install-recommends postgresql-client-17 awscli; \
    apt-get clean; rm -rf /var/lib/apt/lists/*; \
    pg_dump --version; aws --version

RUN useradd --create-home --uid 10001 backup
COPY --chown=backup:backup backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

USER backup
WORKDIR /home/backup
CMD ["/usr/local/bin/backup.sh"]
