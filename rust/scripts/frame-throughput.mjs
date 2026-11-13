/**
 * The other half of `cargo run --release --example throughput`: the same frames
 * through the shipped zod schemas, so phase 2 argues with numbers instead of
 * with a feeling about Rust being fast.
 *
 *   node --experimental-strip-types --no-warnings \
 *        --import ./rust/scripts/ts-register.mjs rust/scripts/frame-throughput.mjs
 *
 * One asymmetry survives, and `docs/RUST.md` states it: zod checks shape and
 * values in one pass, so its `shape` row covers what Rust splits into `shape`
 * and `rules`. `checked` — every stage once — is the column to compare.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sig = await import(resolve(here, "../../packages/shared/src/signaling.ts"));
const frames = JSON.parse(
  readFileSync(resolve(here, "../crates/pqp-core/fixtures/proto-vectors.json"), "utf8"),
);

const TARGET_MS = 1200;

/** Mean nanoseconds per frame over whole passes until the target has passed.
 *  The warm-up passes matter here more than in Rust: V8 needs them to tier up. */
function measure(raws, work) {
  for (let pass = 0; pass < 20; pass += 1) for (const raw of raws) work(raw);
  let done = 0;
  const started = process.hrtime.bigint();
  while (Number(process.hrtime.bigint() - started) / 1e6 < TARGET_MS) {
    for (const raw of raws) work(raw);
    done += raws.length;
  }
  return Number(process.hrtime.bigint() - started) / done;
}

const unions = {
  client: { schema: sig.voiceClientMessageSchema, vectors: frames.client.vectors },
  server: { schema: sig.voiceSignalingMessageSchema, vectors: frames.server.vectors },
};

console.log(
  `zod ${process.env.ZOD_VERSION ?? "workspace"} on node ${process.versions.node}, ` +
    `${frames.client.vectors.length + frames.server.vectors.length} frames per pass`,
);

for (const [name, { schema, vectors }] of Object.entries(unions)) {
  const raws = vectors.map((vector) => JSON.stringify(vector.input));
  const json = measure(raws, (raw) => JSON.parse(raw));
  // zod is handed an object, which is why the JSON stage is billed separately:
  // a socket reads the bytes once and passes the object down. The objects are
  // built once outside the timed loop so this row is zod and not the reader.
  const objects = raws.map((raw) => JSON.parse(raw));
  const shape = (() => {
    for (let pass = 0; pass < 20; pass += 1) for (const value of objects) schema.safeParse(value);
    let done = 0;
    const started = process.hrtime.bigint();
    while (Number(process.hrtime.bigint() - started) / 1e6 < TARGET_MS) {
      for (const value of objects) schema.safeParse(value);
      done += objects.length;
    }
    return Number(process.hrtime.bigint() - started) / done;
  })();
  const checked = json + shape;
  const pad = (n) => n.toFixed(0).padStart(7);
  console.log(
    `${name.padStart(6)}: json ${pad(json)}  shape ${pad(shape)}  checked ${pad(checked)} ns/frame`,
  );
}
