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
node -e 'import("zod").then(
  () => import("./rust/scripts/ts-register.mjs"),
  () => { console.error("zod unavailable; skipping proto regen"); process.exit(3) },
).then(() => import("./rust/scripts/gen-proto-vectors.mjs"))' 2>/dev/null \
  || node --experimental-strip-types --no-warnings \
       --import ./rust/scripts/ts-register.mjs rust/scripts/gen-proto-vectors.mjs >/dev/null \
  || echo "NOTE: zod is not installed, skipping protocol fixture regen. Regenerate
      after 'pnpm install'; cargo still tests the committed fixtures." >&2

# The value rules pqp-core compiles in, plus the frame each rule was proved
# against. A throw here is a real failure: it means the schema grew a constraint
# or a refinement this generator cannot name, which is exactly what must not ship
# unported. It is skipped only when zod itself is unavailable.
if node -e 'import("zod").then(() => process.exit(0), () => process.exit(3))' 2>/dev/null; then
  node --experimental-strip-types --no-warnings \
       --import ./rust/scripts/ts-register.mjs rust/scripts/gen-constraints.mjs >/dev/null
else
  echo "NOTE: zod is not installed, skipping the constraint-table regen. Cargo still
      tests the committed fixture." >&2
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
