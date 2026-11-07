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
//! Why it exists: `server/src/lib/ws-compression.ts` turns `memLevel: 8` down to
//! 6 because that drops a socket's zlib context from 256 KB to 160 KB, and calls
//! the difference 94 MB across a thousand sockets. `flate2` hardcodes 8, so a
//! Rust gateway cannot make that trade. Whether that means it costs 94 MB more is
//! a question about this backend's actual allocation, not about zlib's arithmetic,
//! and `docs/RUST.md` should carry a measured number rather than the same
//! sentence in a new font.

use pqp_deflate::{Deflater, Inflater, Params};

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
        "      the shipped policy's arithmetic says 160 KiB per socket at memLevel 6 and \
         256 KiB at 8; flate2 cannot pick 6"
    );
    assert!(
        after_deflate > before,
        "a thousand live streams must show up in the resident set or the probe is wrong"
    );
}
