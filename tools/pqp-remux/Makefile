.PHONY: build test vet fmt fmtcheck run rund

build:
	go build ./...

test:
	go test ./... -race -count=1

vet:
	go vet ./...

fmt:
	gofmt -w .

fmtcheck:
	@out="$$(gofmt -l .)"; \
	if [ -n "$$out" ]; then \
		echo "gofmt needs to be run on:"; echo "$$out"; exit 1; \
	fi

# Run against a real room, e.g. the staging SFU (see README.md's "Try it
# against staging"). Requires LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET/ROOM.
run: build
	go run ./cmd/pqp-remux

# Run the L1.6 control-plane supervisor. Requires
# LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET and REMUX_CONTROL_SECRET;
# see README.md's "Control API" section.
rund: build
	go run ./cmd/pqp-remuxd
