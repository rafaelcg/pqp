//! What one voice frame costs pqp-core, next to what it costs the TypeScript
//! (`rust/scripts/frame-throughput.mjs` runs the same corpus through zod).
//!
//! Phase 2 gets to exist only if a Rust socket is measurably cheaper on the path
//! that ends a connection, so this measures that path instead of waiting for a
//! server that does not exist yet. Stages are billed the way a socket pays for
//! them, once each, in nanoseconds per frame:
//!
//! * `json`    — bytes to a `serde_json::Value`. Node pays this too: zod is
//!   handed an object, so `JSON.parse` comes first.
//! * `shape`   — the parsed frame to the typed frame: the port of zod's shape
//!   checks. Read from the `Value`, not from the bytes again, because a socket
//!   that reads the bytes twice is throwing work away.
//! * `rules`   — `validate` over the parsed frame: `.uuid()`, bounds, `.url()`,
//!   the soundboard refinement.
//! * `checked` — `json` + `shape` + `rules`, which is the comparable number.
//!
//! One asymmetry survives, and `docs/RUST.md` states it: zod checks shape and
//! values in one pass, so its `shape` row covers both of the Rust rows. `checked`
//! is the column to compare, and it is reported whether it flatters the port or
//! not — a throughput number that only exists when it is favourable is marketing.
//! The machine and the version print themselves, because without them a number is
//! folklore.
//!
//! `cargo run --release --example throughput`

use pqp_core::{
    proto::{VoiceClientMessage, VoiceSignalingMessage},
    validate,
};
use serde::Deserialize;
use serde_json::Value;
use std::hint::black_box;
use std::time::{Duration, Instant};

const FIXTURE: &str = include_str!("../fixtures/proto-vectors.json");
/// Long enough that timer resolution and cache warm-up stop mattering.
const TARGET: Duration = Duration::from_millis(1200);

#[derive(Deserialize)]
struct Fixture {
    client: Side,
    server: Side,
}

#[derive(Deserialize)]
struct Side {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    input: Value,
}

/// Mean nanoseconds per frame over whole passes until `TARGET` has passed.
/// Three warm-up passes first, so the timed ones do not pay for demand paging.
fn measure<F: FnMut(&str)>(frames: &[String], mut work: F) -> f64 {
    for _ in 0..3 {
        for frame in frames {
            work(frame);
        }
    }
    let mut done = 0_u64;
    let started = Instant::now();
    while started.elapsed() < TARGET {
        for frame in frames {
            work(frame);
        }
        done += frames.len() as u64;
    }
    started.elapsed().as_nanos() as f64 / done as f64
}

fn main() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
    let total = fixture.client.vectors.len() + fixture.server.vectors.len();
    println!(
        "pqp-core {} on {}-{}, release build, {} frames per pass",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        total
    );

    for (name, side, is_client) in [
        ("client", fixture.client, true),
        ("server", fixture.server, false),
    ] {
        let frames: Vec<String> = side
            .vectors
            .iter()
            .map(|v| serde_json::to_string(&v.input).expect("frame serialises"))
            .collect();

        let json = measure(&frames, |raw| {
            black_box(serde_json::from_str::<Value>(raw).is_ok());
        });
        let values: Vec<&Value> = side.vectors.iter().map(|v| &v.input).collect();
        let shape = {
            let one = |value: &Value| {
                black_box(if is_client {
                    VoiceClientMessage::deserialize(value).is_ok()
                } else {
                    VoiceSignalingMessage::deserialize(value).is_ok()
                })
            };
            for _ in 0..3 {
                for value in &values {
                    one(value);
                }
            }
            let mut done = 0_u64;
            let started = Instant::now();
            while started.elapsed() < TARGET {
                for value in &values {
                    one(value);
                }
                done += values.len() as u64;
            }
            started.elapsed().as_nanos() as f64 / done as f64
        };
        let rules = {
            let work = |value: &Value| {
                black_box(
                    (if is_client {
                        validate::client(value)
                    } else {
                        validate::server(value)
                    })
                    .is_ok(),
                );
            };
            for _ in 0..3 {
                for value in &values {
                    work(value);
                }
            }
            let mut done = 0_u64;
            let started = Instant::now();
            while started.elapsed() < TARGET {
                for value in &values {
                    work(value);
                }
                done += values.len() as u64;
            }
            started.elapsed().as_nanos() as f64 / done as f64
        };

        println!(
            "{name:>6}: json {json:>7.0}  shape {shape:>7.0}  rules {rules:>7.0}  checked {:.0} ns/frame",
            json + shape + rules
        );
    }
}
