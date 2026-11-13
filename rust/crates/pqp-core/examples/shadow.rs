//! Shadow validator: read captured frames, report what the value layer *would*
//! refuse, and refuse nothing.
//!
//! Phase 2 has to learn whether live clients send frames the schemas dislike
//! before it is allowed to act on that (`validate::shadow` explains why enforcing
//! first would hang calls up). This is the tool that learns it: pipe it a log of
//! newline-separated frames and it prints the per-arm counts an operator would arm
//! enforcement from.
//!
//! ```text
//! cargo run --release --example shadow -- client < frames.jsonl
//! cat hall-a/*.jsonl | cargo run --release --example shadow -- server
//! ```
//!
//! The exit code is 0 even when frames would be refused, because that is what
//! shadow means: a report, not a gate. `--deny` opts out of that, for anyone who
//! wants this as a check rather than a measurement.
use std::io::{self, Read, Write};

fn main() {
    let mut deny = false;
    let mut union: Option<String> = None;
    for arg in std::env::args().skip(1) {
        if arg == "--deny" {
            deny = true;
        } else if union.is_none() && (arg == "client" || arg == "server") {
            union = Some(arg);
        } else {
            eprintln!("usage: shadow <client|server> [--deny] < frames.jsonl");
            std::process::exit(2);
        }
    }
    let Some(union) = union else {
        eprintln!("usage: shadow <client|server> [--deny] < frames.jsonl");
        std::process::exit(2);
    };

    let rules = pqp_core::validate::embedded().unwrap_or_else(|reason| {
        eprintln!("the compiled-in constraint table is unreadable: {reason}");
        std::process::exit(2);
    });

    // Read the whole log before auditing: `audit` borrows the lines it reports
    // on, so they have to outlive it. A captured log is a file, not an unbounded
    // stream — the thing that *would* stream is phase 2's socket, and it will
    // hold one `Shadow` per direction rather than a Vec of every frame.
    let mut raw = String::new();
    match io::stdin().read_to_string(&mut raw) {
        Ok(_) => {}
        // A pipe that died mid-log still delivered the lines that arrived;
        // report what was read rather than throwing the run away.
        Err(error) => eprintln!("stdin stopped early: {error}"),
    }
    let report = pqp_core::validate::audit(&union, rules, raw.lines());

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(
        out,
        "{union}: {} frames, {} would be refused, {} not JSON at all",
        report.frames, report.refused, report.unparsed
    );
    let width = report
        .per_type
        .keys()
        .map(|t| t.len())
        .max()
        .unwrap_or(4)
        .max(4);
    for (frame_type, counts) in &report.per_type {
        let _ = writeln!(
            out,
            "  {frame_type:width$}  {:>6} frames  {:>4} refused",
            counts.frames, counts.refused
        );
    }
    if report.samples.is_empty() {
        let _ = writeln!(out, "no arm would be refused: every arm is arming-ready");
    } else {
        let _ = writeln!(out, "would refuse, first {}:", report.samples.len());
        for sample in &report.samples {
            for violation in &sample.violations {
                let _ = writeln!(
                    out,
                    "  {} {}: {}",
                    sample.frame_type, violation.path, violation.rule
                );
            }
        }
        let ready = report.arming_ready();
        let _ = writeln!(
            out,
            "arming-ready ({} of {} arms seen): {}",
            ready.len(),
            report.per_type.len(),
            if ready.is_empty() {
                "none".to_owned()
            } else {
                ready.join(", ")
            }
        );
    }

    if deny && report.refused > 0 {
        std::process::exit(1);
    }
}
