# Wire-contract fixtures

Generated from the shipped zod schemas in `packages/shared/src/signaling.ts` (and
the files it imports). The schemas are the only source of truth; every client
replays these files to prove it reads a frame the way the server does. Plan:
`docs/plans/RUST.md`, phase A. Do not edit the JSON by hand.

| File | Holds | Generator |
|---|---|---|
| `proto-vectors.json` | At least one example frame per arm of the voice socket's client and server unions, with `input` (what is on the wire) and `canonical` (zod's own parse output: defaults applied, an absent nullable field as `null`, an absent field that is not nullable dropped) | `scripts/gen-proto-vectors.mjs` |
| `constraints.json` | Every value rule (`guid`, `url`, `minLen`, `maxItems`, `safeint`, `ge`, `enum`, `refine`, ...) per arm and path, a frame zod refuses for each one (`violations`), probe verdicts for `.url()` and `.guid()` (`formatCases`) and the pinned behaviour of `.refine` (`refinements`) | `scripts/gen-constraints.mjs` |

A path spells an array element `queue[0].id`, and a rule on the array itself
hangs off the path without `[]` (`skipVotes` is a count, `skipVotes[]` a length).

## Regenerate

```bash
pnpm fixtures:wire          # writes both files
pnpm fixtures:wire:check    # regenerates in memory, fails if what is committed differs
```

Run it after any change to a schema reachable from `voiceClientMessageSchema` or
`voiceSignalingMessageSchema`, and commit the result. `src/wire-fixtures.test.ts`
fails (in `pnpm --filter @pqp/shared test`, so in CI) when a committed file
differs from a fresh regeneration. A new frame arm with no example in
`gen-proto-vectors.mjs` stops the generator by name.

## What fails, on purpose

- A generator that emits zero rules, or fewer than the floor committed in the test.
- An arm with no vector; a nullable object seen only filled or only null.
- A zod node type or check the walk (`scripts/zod4-walk.mjs`) has no rule for
  (`z.record`, `.regex()`, `.transform()`, `z.coerce.*`, a zod 3 schema, ...).
  It throws, naming the node and its path; nothing is skipped.
- A value rule no frame can prove: zod must refuse the violation at the named
  path for the kind of reason the rule names.
- A fixture that holds anything but protocol facts: keys are an exact envelope
  plus field names read off the schemas, and no value is a filesystem path. The
  old Rust spike's parity check recorded where `ws` was found on disk, which made
  it pass on one machine and fail on another.

## Reading the fixtures from a client

`Android` and `iOS` replays are steps A2 and A3 of the plan. Until then the only
reader is the vitest file above. A client should decode every `input`, compare
with `canonical`, and refuse every `violations[].frame`.
