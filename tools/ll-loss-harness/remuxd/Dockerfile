# Builds pqp-remuxd (the real production control-plane supervisor,
# tools/pqp-remux/cmd/pqp-remuxd -- unmodified) for the local loss harness.
# Build context is the repo root (see docker-compose.yaml's `context: ../../..`
# from this file's directory), because tools/pqp-remux is a Go module that
# needs no code outside itself, but Docker's build context has to be a
# directory containing everything COPY references.
FROM golang:1-bookworm AS build
WORKDIR /src/tools/pqp-remux
COPY tools/pqp-remux/go.mod tools/pqp-remux/go.sum ./
RUN go mod download
COPY tools/pqp-remux/ ./
RUN CGO_ENABLED=0 go build -o /out/pqp-remuxd ./cmd/pqp-remuxd

# internal/aacenc shells out to ffmpeg (tools/pqp-remux/README.md's
# FFMPEG_PATH) to encode the mixed stage audio to AAC-LC -- needed even
# though this harness's ramp.h264 has no real audio track, because the
# pipeline still spins up the audio side and would otherwise fail loudly
# the first time a viewer's client asks for the audio rendition.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/pqp-remuxd /usr/local/bin/pqp-remuxd
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/pqp-remuxd"]
