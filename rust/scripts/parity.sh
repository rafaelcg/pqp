#!/usr/bin/env bash
# The pqp-core regression gate.
#
# Run this, not bare `cargo test`. `cargo test` alone only proves Rust reads
# what TypeScript produced; this also sends Rust's own output back through the
# shipped TypeScript, which is the half that decides whether a rolling deploy
# hangs up a live call.
#
# It fails if a committed fixture no longer matches what the TypeScript
# generates, so a schema change cannot ship with a stale Rust fixture that
# keeps CI green.
set -euo pipefail
cd "$(dirname "$0")/../.."

node rust/scripts/gen-resume-vectors.mjs >/dev/null
# zod is not hoisted to the workspace root: it lives in packages/shared/
# node_modules, where the shipped sources resolve it. Asked from the root it
# always answers "missing", so a probe that runs there skips both generators and
# still leaves the gate green — a drift check that never drifts. The probe asks
# from the package that depends on zod.
if (cd packages/shared && node --input-type=module \
      -e 'const { z } = await import("zod"); process.exit(z ? 0 : 1)') 2>/dev/null; then
  # A throw from either generator is fatal, which is the point: it means the
  # schema grew a field, a constraint or a refinement these generators cannot
  # name, and that is exactly what must not ship unported.
  node --experimental-strip-types --no-warnings \
       --import ./rust/scripts/ts-register.mjs rust/scripts/gen-proto-vectors.mjs >/dev/null
  node --experimental-strip-types --no-warnings \
       --import ./rust/scripts/ts-register.mjs rust/scripts/gen-constraints.mjs >/dev/null
else
  echo "NOTE: zod is not installed, so neither the protocol fixtures nor the value
      rule table were regenerated. Run 'pnpm install'. Cargo still tests the
      committed fixtures." >&2
fi

if ! git diff --exit-code --quiet rust/fixtures/; then
  echo "FAIL: fixtures under rust/fixtures/ no longer match the shipped TypeScript." >&2
  echo "The port has drifted from the schema. Review the diff and commit it." >&2
  git --no-pager diff --stat rust/fixtures/ >&2
  exit 1
fi

out="$(mktemp -d)/rust-minted.json"
PQP_RUST_MINTED_OUT="$out" cargo test --manifest-path rust/Cargo.toml --all-targets
node rust/scripts/verify-rust-tokens.mjs "$out"
cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path rust/Cargo.toml --all --check
echo "PASS: pqp-core agrees with the shipped TypeScript in both directions"
