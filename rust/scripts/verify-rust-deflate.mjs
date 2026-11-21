#!/usr/bin/env node
/**
 * The reverse leg of the permessage-deflate parity: `ws` must read what the Rust
 * crate compressed.
 *
 * `cargo test` alone only proves Rust can inflate what Node wrote. That is the
 * half a browser hitting a Rust gateway exercises; this is the half a rolling
 * deploy exercises -- a browser that negotiated with the Node server's framing
 * receiving frames from Rust. A crate that passes its own inflate tests and
 * writes a stream `ws` cannot read hangs up every socket it touches, and the
 * failure is silent because both sides think they compressed successfully.
 *
 * The client is driven from the RESPONSE HEADER the Rust code produced, not from
 * the fixture's copy of it, so the negotiation Rust actually performs is what
 * gets exercised: a Rust response that drops `server_no_context_takeover` would
 * make this instance keep a dictionary the server thinks it dropped, which is a
 * memory difference rather than a crash, and is exactly the kind of thing a
 * round-trip test catches and a unit test does not.
 *
 * Usage: node rust/scripts/verify-rust-deflate.mjs <path-to-rust-deflate.json>
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWs } from "./ws-locate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const path = process.argv[2];
if (!path) {
  console.error("usage: node rust/scripts/verify-rust-deflate.mjs <rust-deflate.json>");
  process.exit(2);
}
const minted = JSON.parse(readFileSync(path, "utf8"));
const { PerMessageDeflate, extension, package: wsPackage } = loadWs(root);
const { WS_PER_MESSAGE_DEFLATE } = await import(
  resolve(here, "../../server/src/lib/ws-compression.ts")
);

if (minted.wsVersionExpected !== wsPackage.version) {
  console.error(
    `FAIL: the Rust fixtures were recorded against ws ${minted.wsVersionExpected} and this is ` +
      `${wsPackage.version}. Regenerate rather than verify across versions.`,
  );
  process.exit(1);
}

function step(instance, method, data, fin) {
  return new Promise((done, fail) => {
    instance[method](data, fin, (err, result) => (err ? fail(err) : done(result)));
  });
}

let checked = 0;
let rawPassthrough = 0;
let rustBytes = 0;
let nodeBytes = 0;

for (const vector of minted.vectors) {
  const client = new PerMessageDeflate({ ...WS_PER_MESSAGE_DEFLATE, isServer: false });
  const offers = extension.parse(vector.response_header);
  if (!offers[PerMessageDeflate.extensionName]) {
    throw new Error(`${vector.name}: Rust answered with no permessage-deflate: ${vector.response_header}`);
  }
  // acceptAsClient, exactly as `ws` does on a handshake response.
  client.accept(offers[PerMessageDeflate.extensionName]);

  for (const [i, frame] of vector.frames.entries()) {
    const want = Buffer.from(frame.text, "base64");
    if (!frame.rsv1) {
      if (frame.deflated != null) {
        throw new Error(`${vector.name} frame ${i}: RSV1 clear but Rust still sent deflate data`);
      }
      rawPassthrough += 1;
      continue;
    }
    const got = await step(client, "decompress", Buffer.from(frame.deflated, "base64"), frame.fin);
    if (!got.equals(want)) {
      throw new Error(
        `${vector.name} frame ${i}: ws read ${got.length} bytes of ${want.length} expected ` +
          `(${JSON.stringify(got.subarray(0, 48).toString())}...)`,
      );
    }
    rustBytes += Buffer.from(frame.deflated, "base64").length;
    checked += 1;
  }
  client.cleanup();
}

// The ratio difference is not a failure, and printing it is the point: Rust runs
// `flate2` at memLevel 8 where the Node server chose 6, so it should be slightly
// WORSE per frame and slightly bigger per socket. A number here that drifts far
// from parity means the backend changed, not that the protocol broke.
const nodeFixture = JSON.parse(
  readFileSync(resolve(here, "../crates/pqp-deflate/fixtures/deflate-vectors.json"), "utf8"),
);
for (const v of nodeFixture.vectors) {
  for (const f of v.frames) {
    if (f.deflated) nodeBytes += Buffer.from(f.deflated, "base64").length;
  }
}

console.log(
  `PASS: ws read every frame the Rust crate compressed (${checked} frames, ` +
    `${rawPassthrough} sent raw under the threshold) on ${minted.vectors.length} connections\n` +
    `      Rust ${rustBytes} B vs ws ${nodeBytes} B on the frames the fixtures overlap ` +
    `(${rustBytes === 0 ? "n/a" : ((rustBytes / nodeBytes) * 100).toFixed(1)}% -- ` +
    `levels and memLevel differ between the backends, so byte counts are expected to differ)`,
);
