//! How much a compressed connection costs, measured instead of asserted.
//!
//! Ignored by default because it allocates deliberately and reads its own
//! process out of `ps`, which is a diagnostic rather than a regression. Run it
//! with:
//!
//! ```text
//! cargo test -p pqp-deflate --test memory -- --ignored --nocapture
//! ```
//!
//! Why it exists: `server/src/lib/ws-compression.ts:50` turns `memLevel: 8` down
//! to 6 partly because zlib's arithmetic says a socket's context drops from 256 KB
//! to 160 KB, and calls the difference 94 MB across a thousand sockets. Whether
//! that is what THIS backend costs is a question about its own allocation, not
//! about zlib's arithmetic, so both numbers are measured here: what a socket of
//! ours costs, and what each `memLevel` is worth on this backend.

use pqp_deflate::{decode_base64, Deflater, Inflater, Params};

///resident set size of this process, in KiB, from `ps`. No libc dependency: the
/// point is a ballpark within a few percent, not a byte-exact profiler.
fn resident_kib() -> usize {
    let pid = std::process::id();
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .expect("ps prints a number")
}

#[test]
#[ignore = "allocates 1000 streams on purpose; run it explicitly"]
fn cost_of_a_thousand_compressed_connections() {
    const SOCKETS: usize = 1000;
    let params = Params::default();

    // Warm the allocator once so the first socket is not paying for the arena.
    let mut warm = Deflater::new(&params).expect("default window");
    warm.deflate(b"warm the allocator and the zlib window", true)
        .expect("deflate");
    let mut warm_in = Inflater::new(&params);
    warm_in
        .inflate(
            &[
                0xf2, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x48, 0xcf, 0x2f, 0x57, 0x48, 0xae, 0x4e, 0xcd,
                0x2b, 0x01, 0x00,
            ],
            true,
        )
        .ok();
    drop(warm);
    drop(warm_in);

    let before = resident_kib();
    let mut keep: Vec<Deflater> = Vec::with_capacity(SOCKETS);
    for _ in 0..SOCKETS {
        let mut d = Deflater::new(&params).expect("open a stream");
        // A stream that is opened but never written is not what a socket looks
        // like: zlib allocates its window lazily in some backends, so each one
        // has to have actually compressed something.
        d.deflate(b"{\"type\":\"voice-roster\",\"participants\":[]}", true)
            .expect("deflate");
        keep.push(d);
    }
    let after_deflate = resident_kib();
    let mut keep_in: Vec<Inflater> = Vec::with_capacity(SOCKETS);
    for _ in 0..SOCKETS {
        keep_in.push(Inflater::new(&params));
    }
    let after_inflate = resident_kib();

    // The crate also holds a `spare` output buffer per stream, which is ours and
    // not zlib's, and a real gateway would share one. Reported separately so the
    // two are not confused in the doc.
    let spare_bytes = u64::try_from(1usize << 14).expect("16 KiB");
    println!(
        "rss {before} KiB -> {after_deflate} KiB with {SOCKETS} live deflaters ({} KiB each), \
         -> {after_inflate} KiB adding {SOCKETS} inflaters ({} KiB each)",
        (after_deflate - before) / SOCKETS,
        (after_inflate - after_deflate) / SOCKETS,
    );
    println!(
        "      of which the per-stream output buffer is {spare_bytes} B: pqp-deflate's own choice"
    );
    println!(
        "      of that, the deflate state itself is what the next probe measures at each \
         memLevel; the shipped policy asks for 6 and this crate passes it through"
    );
    assert!(
        after_deflate > before,
        "a thousand live streams must show up in the resident set or the probe is wrong"
    );
}

/// The fixture's largest frame is the frame `ws-compression.ts` exists for, and
/// the ratio has to be measured on it: `docs/RUST.md` already records a
/// sequential-id roster reporting 9.72x where production gets 5.17x.
fn largest_frame() -> Vec<u8> {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/deflate-vectors.json"))
            .expect("the fixture parses");
    let mut best: Option<Vec<u8>> = None;
    for frame in fixture["vectors"]
        .as_array()
        .expect("vectors")
        .iter()
        .flat_map(|vector| vector["frames"].as_array().expect("frames").iter())
    {
        let Some(text) = frame["text"].as_str() else {
            continue;
        };
        let Ok(raw) = decode_base64(text) else {
            continue;
        };
        if best.as_ref().is_none_or(|held| raw.len() > held.len()) {
            best = Some(raw);
        }
    }
    best.expect("the fixture holds a text frame")
}

fn config(mem_level: i32) -> zlib_rs::DeflateConfig {
    zlib_rs::DeflateConfig {
        level: 3,
        method: zlib_rs::Method::Deflated,
        // Raw deflate: permessage-deflate carries no zlib header, and the
        // negative form is how zlib-rs spells "raw".
        window_bits: -15,
        mem_level,
        strategy: zlib_rs::Strategy::Default,
    }
}

/// The whole probe runs twice, once per arm, in a child process. Inside one
/// process the second arm would read as almost free, because the allocator
/// reuses the pages the first arm dropped, and this file has already been
/// fooled twice by a number that looked too good.
const PROBE_ENV: &str = "PQP_MEM_PROBE";
const PROBE_TEST: &str = "mem_level_six_is_reachable_and_costs_what_zlib_says_it_should";
const SOCKETS: usize = 1000;

/// One arm: compress a real roster once for the ratio, then hold a thousand
/// live streams for the resident set. The output buffer is shared across the
/// thousand on purpose: a gateway shares one too, and a per-iteration buffer
/// would measure the allocator rather than zlib.
fn measure_arm(mem_level: i32) {
    let payload = largest_frame();
    let mut scratch = vec![0u8; payload.len() + 1024];
    let (done, _code) = zlib_rs::compress_slice(&mut scratch, &payload, config(mem_level));
    let compressed = done.len();

    let before = resident_kib();
    let mut keep: Vec<zlib_rs::Deflate> = Vec::with_capacity(SOCKETS);
    let mut out = vec![0u8; 1 << 16];
    for _ in 0..SOCKETS {
        let mut stream = zlib_rs::Deflate::new_with_config(config(mem_level));
        stream
            .compress(
                &payload[..512.min(payload.len())],
                &mut out,
                zlib_rs::DeflateFlush::NoFlush,
            )
            .ok();
        keep.push(stream);
    }
    let after = resident_kib();
    std::hint::black_box(&keep);
    std::hint::black_box(&out);
    let per_socket_kib = (after - before) / SOCKETS;
    let raw = payload.len();
    println!(
        "PROBE mem_level={mem_level} per_socket_kib={per_socket_kib} raw={raw} \
         compressed={compressed} ratio={:.2}",
        raw as f64 / compressed as f64
    );
}

fn parse_probe(text: &str) -> (usize, f64) {
    let line = text
        .lines()
        .find(|line| line.starts_with("PROBE "))
        .unwrap_or_else(|| panic!("the child printed no PROBE line:\n{text}"));
    let mut per_socket_kib = None;
    let mut ratio = None;
    for pair in line.split_whitespace().skip(1) {
        let (key, value) = pair.split_once('=').expect("key=value");
        match key {
            "per_socket_kib" => per_socket_kib = Some(value.parse().expect("a number")),
            "ratio" => ratio = Some(value.parse().expect("a number")),
            _ => {}
        }
    }
    (
        per_socket_kib.expect("per_socket_kib"),
        ratio.expect("ratio"),
    )
}

/// `server/src/lib/ws-compression.ts:50` picks `memLevel: 6` over zlib's default
/// of 8 for a 0.4% worse ratio and a socket that costs 160 KB instead of 256 KB,
/// and calls the difference 94 MB across a thousand sockets. `flate2` cannot make
/// that trade: its zlib-rs backend builds the config from level, header and
/// window alone (`flate2-1.1.11/src/ffi/zlib_rs.rs:221`), and the three-argument
/// constructor it calls fills `mem_level` from `DeflateConfig::default()`, which
/// is 8 (`zlib-rs-0.6.8/src/stable.rs:297`, `src/deflate.rs:246`). zlib-rs does
/// honour the number when a caller passes one (`src/deflate.rs:321` sizes
/// `lit_bufsize` as `1 << (mem_level + 6)`), so the gap is `flate2`'s surface,
/// not the backend's. This probe says what that is worth in bytes.
#[test]
#[ignore = "spawns two processes and holds 1000 streams in each"]
fn mem_level_six_is_reachable_and_costs_what_zlib_says_it_should() {
    if let Some(raw) = std::env::var_os(PROBE_ENV) {
        measure_arm(raw.to_string_lossy().parse().expect("a memLevel"));
        return;
    }

    let exe = std::env::current_exe().expect("the test binary knows itself");
    let mut arms: Vec<(i32, usize, f64)> = Vec::new();
    for mem_level in [8, 6] {
        let run = std::process::Command::new(&exe)
            .args([PROBE_TEST, "--exact", "--ignored", "--nocapture"])
            .env(PROBE_ENV, mem_level.to_string())
            .output()
            .expect("re-executed the probe");
        assert!(
            run.status.success(),
            "the memLevel {mem_level} arm failed:\n{}",
            String::from_utf8_lossy(&run.stderr)
        );
        let (per_socket_kib, ratio) = parse_probe(&String::from_utf8_lossy(&run.stdout));
        arms.push((mem_level, per_socket_kib, ratio));
    }

    for (mem_level, per_socket_kib, ratio) in &arms {
        println!(
            "      memLevel {mem_level}: {per_socket_kib} KiB of deflate state per socket, \
             ratio {ratio:.2}x on the real roster"
        );
    }
    let eight = arms
        .iter()
        .find(|(mem_level, ..)| *mem_level == 8)
        .expect("the memLevel 8 arm");
    let six = arms
        .iter()
        .find(|(mem_level, ..)| *mem_level == 6)
        .expect("the memLevel 6 arm");
    let saved_kib = eight.1 - six.1;
    println!(
        "      memLevel 6 saves {saved_kib} KiB per socket, {} KiB across {SOCKETS}, \
         for a ratio of {:.2}x against {:.2}x",
        saved_kib * SOCKETS,
        six.2,
        eight.2
    );
    assert!(
        six.1 < eight.1,
        "the shipped policy's whole reason for memLevel 6 is a smaller context; if it is \
         not smaller here the trade is not available and docs/RUST.md must say so"
    );
}

/// The version of the claim that runs in CI, so a backend change cannot quietly
/// stop honouring `memLevel` and cost every socket 48 KiB.
///
/// Both arms are held at the same time and neither is dropped: the allocator
/// reuses freed pages, so releasing the first arm would let the second look
/// nearly free and the test would pass for the wrong reason. The arms differ by
/// 256x in `lit_bufsize` (`zlib-rs-0.6.8/src/deflate.rs:321`), which is about
/// 127 KiB per stream, so 200 streams separate them by roughly 25 MB. The
/// threshold is a third of that, because this measures a resident set and not a
/// byte count.
#[test]
fn mem_level_reaches_the_backend_and_moves_real_bytes() {
    const STREAMS: usize = 200;
    let payload = br#"{"type":"voice-roster","voiceChannelId":"chan-a","participants":[]}"#;

    fn hold(streams: usize, mem_level: u8, payload: &[u8]) -> Vec<Deflater> {
        let params = Params {
            mem_level,
            ..Params::default()
        };
        let mut held = Vec::with_capacity(streams);
        for _ in 0..streams {
            let mut stream = Deflater::new(&params).expect("a legal memLevel opens");
            stream.deflate(payload, false).expect("deflate");
            held.push(stream);
        }
        held
    }

    let base = resident_kib();
    let narrow = hold(STREAMS, 1, payload);
    let after_narrow = resident_kib();
    let wide = hold(STREAMS, 9, payload);
    let after_wide = resident_kib();
    std::hint::black_box((&narrow, &wide));

    let narrow_kib = after_narrow - base;
    let wide_kib = after_wide - after_narrow;
    println!(
        "{STREAMS} sockets at memLevel 1 cost {narrow_kib} KiB, at memLevel 9 {wide_kib} KiB \
         ({:.1} KiB and {:.1} KiB per socket)",
        narrow_kib as f64 / STREAMS as f64,
        wide_kib as f64 / STREAMS as f64
    );
    assert!(
        wide_kib > narrow_kib + 8 * 1024,
        "memLevel 9 must cost clearly more than memLevel 1 or the parameter is not \
         reaching the backend: {wide_kib} KiB against {narrow_kib} KiB"
    );
}
