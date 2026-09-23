# Builds rampub (tools/ll-loss-harness/publisher, this directory) and packages
# it with iproute2 so the container can apply its own netem loss (see
# entrypoint.sh) before it dials LiveKit. Build context is this directory --
# rampub is a standalone Go module with no dependency on the rest of the repo.
FROM golang:1-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -o /out/rampub .

FROM debian:bookworm-slim
# iproute2: `tc` for netem loss injection on this container's own eth0
# (entrypoint.sh). ca-certificates: the LiveKit SDK dials wss:// even
# though this harness always points it at plain ws:// locally; keeping it
# costs nothing and avoids a surprise if that ever changes.
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/rampub /usr/local/bin/rampub
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
