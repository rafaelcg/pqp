//! Value-parity test: the checks zod applies *after* the shape is right.
//!
//! `rust/fixtures/constraints.json` holds the value rules read off the shipped
//! zod schemas, and for each one a frame that zod was shown and refused. The
//! frames matter: a rule recorded in a fixture only means something if the port
//! turns it into the same accept/reject decision as zod, at the same path, so
//! every rule here is checked by replaying the evidence rather than by reading
//! the rule back.
//!
//! Coverage is derived from the schema, not listed here. `every_arm_is_known`
//! fails if an arm of either union is in neither the rule table nor the
//! documented `armsWithoutRules` list, which is how a message type added to
//! `packages/shared/src/signaling.ts` would otherwise become an arm nobody
//! value-checks — the same failure mode as the #406 handler gap, one layer up.

use std::collections::{BTreeMap, BTreeSet};

use pqp_core::validate;
use serde::Deserialize;
use serde_json::Value;

const CONSTRAINTS: &str = include_str!("../../../fixtures/constraints.json");
const VECTORS: &str = include_str!("../../../fixtures/proto-vectors.json");

/// Limit how many failures one assertion dumps, so a systematic mismatch is
/// still readable.
const REPORT: usize = 12;

fn table() -> validate::Rules {
    validate::load(CONSTRAINTS).expect("the shipped constraint table loads")
}

#[derive(Deserialize)]
struct Doc {
    counts: Counts,
    #[serde(rename = "armsWithoutRules")]
    arms_without_rules: BTreeMap<String, Vec<String>>,
    violations: Vec<Proved>,
    skipped: Vec<Skipped>,
}

#[derive(Deserialize)]
struct Counts {
    rules: usize,
    violations: usize,
    skipped: usize,
}

/// One rule plus the frame zod was shown that breaks it.
#[derive(Deserialize)]
struct Proved {
    union: String,
    r#type: String,
    path: String,
    rule: String,
    frame: Value,
    #[serde(rename = "zodPaths")]
    zod_paths: Vec<String>,
}

/// A rule no example frame reaches, so nothing here proves it.
#[derive(Deserialize)]
struct Skipped {
    union: String,
    r#type: String,
    path: String,
    rule: String,
    why: String,
}

#[derive(Deserialize)]
struct Vectors {
    client: Side,
    server: Side,
}

#[derive(Deserialize)]
struct Side {
    types: Vec<String>,
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    r#type: String,
    label: String,
    input: Value,
    canonical: Value,
}

fn doc() -> Doc {
    serde_json::from_str(CONSTRAINTS).expect("the shipped constraint table parses")
}

fn vectors() -> Vectors {
    serde_json::from_str(VECTORS).expect("the protocol vectors parse")
}

/// The rule identity out of a label: `minLen(1)` and `gt(0)` are about one zod
/// check, and the number in it is already pinned by which value zod refused.
fn kind(label: &str) -> &str {
    label.split('(').next().unwrap_or(label)
}

fn report(label: &str, problems: &[String]) {
    let mut out = format!(
        "{label} ({} of {} shown):\n",
        problems.len().min(REPORT),
        problems.len()
    );
    for line in problems.iter().take(REPORT) {
        out.push_str("  ");
        out.push_str(line);
        out.push('\n');
    }
    panic!("{}", out);
}

/// Frames zod accepts must pass here too. A value layer that over-refuses is
/// worse than one that under-refuses: it hangs up a call that was working.
#[test]
fn every_valid_frame_passes_the_value_layer() {
    let all = vectors();
    let mut problems = Vec::new();
    for (name, side, check) in [
        (
            "client",
            &all.client,
            validate::client as fn(&Value) -> validate::Outcome,
        ),
        (
            "server",
            &all.server,
            validate::server as fn(&Value) -> validate::Outcome,
        ),
    ] {
        for vector in &side.vectors {
            if let Err(violations) = check(&vector.input) {
                problems.push(format!(
                    "{name} {}/{} refused by {:?}",
                    vector.r#type,
                    vector.label,
                    violations
                        .iter()
                        .map(|violation| format!("{}:{}", violation.path, violation.rule))
                        .collect::<Vec<_>>()
                ));
            }
        }
    }
    if !problems.is_empty() {
        report(
            "a frame zod accepted was refused by the value layer",
            &problems,
        );
    }
}

/// The same check on the canonical form zod produces, which is what Rust puts on
/// the wire when it is the sender. A default zod fills in without re-checking it
/// would be accepted by Node and refused here.
#[test]
fn the_canonical_form_zod_produces_also_passes() {
    let all = vectors();
    let mut problems = Vec::new();
    for (name, side, result) in [
        (
            "client",
            &all.client,
            validate::client as fn(&Value) -> validate::Outcome,
        ),
        (
            "server",
            &all.server,
            validate::server as fn(&Value) -> validate::Outcome,
        ),
    ] {
        for vector in &side.vectors {
            if let Err(violations) = result(&vector.canonical) {
                problems.push(format!(
                    "{name} {}/{} canonical refused by {:?}",
                    vector.r#type,
                    vector.label,
                    violations
                        .iter()
                        .map(|violation| format!("{}:{}", violation.path, violation.rule))
                        .collect::<Vec<_>>()
                ));
            }
        }
    }
    if !problems.is_empty() {
        report(
            "the canonical form was refused by the value layer",
            &problems,
        );
    }
}

/// Replay the evidence: every frame zod refused has to be refused here, blaming
/// the same path and the same kind of rule.
#[test]
fn every_proved_violation_is_refused_at_the_same_path() {
    let rules = table();
    let evidence = doc();
    let mut problems = Vec::new();
    for proved in &evidence.violations {
        let found = match validate::check(&proved.union, &rules, &proved.frame) {
            Ok(()) => {
                problems.push(format!(
                    "{}/{} {} ({}) was accepted",
                    proved.union, proved.r#type, proved.path, proved.rule
                ));
                continue;
            }
            Err(found) => found,
        };
        let rust_paths: BTreeSet<String> = found.iter().map(|v| v.path.clone()).collect();
        let zod_paths: BTreeSet<String> = proved.zod_paths.iter().cloned().collect();
        if rust_paths != zod_paths {
            problems.push(format!(
                "{}/{} {} ({}): blamed {:?}, zod blamed {:?}",
                proved.union, proved.r#type, proved.path, proved.rule, rust_paths, zod_paths
            ));
        }
        let kinds: BTreeSet<&str> = found.iter().map(|v| kind(&v.rule)).collect();
        if !kinds.contains(kind(&proved.rule)) {
            problems.push(format!(
                "{}/{} {} ({}): blamed {:?}, expected a {} rule",
                proved.union,
                proved.r#type,
                proved.path,
                proved.rule,
                kinds,
                kind(&proved.rule)
            ));
        }
    }
    if !problems.is_empty() {
        report(
            "a violation zod proved was blamed elsewhere or accepted",
            &problems,
        );
    }
}

/// `.url()` is "`new URL(value)` parses" in zod, which is not "looks like http".
/// These are the verdicts zod itself gave, so the WHATWG parser is a tested
/// choice rather than an assumption.
#[test]
fn url_verdicts_match_the_ones_zod_gave() {
    let rules = table();
    let problems: Vec<String> = rules
        .url_cases()
        .iter()
        .filter(|(value, ok)| validate::url_accepts(value) != *ok)
        .map(|(value, ok)| {
            format!(
                "zod said {ok} for {value:?}, Rust said {}",
                validate::url_accepts(value)
            )
        })
        .collect();
    assert!(
        problems.is_empty(),
        "the .url() port disagrees with zod:\n{}",
        problems.join("\n")
    );
}

/// Same for the one `.refine` on the wire, pinned by what the predicate actually
/// returned rather than by a description of it.
#[test]
fn refinement_verdicts_match_the_ones_zod_gave() {
    let rules = table();
    let mut problems = Vec::new();
    let mut pinned = 0;
    for (name, cases) in rules.refinement_cases() {
        assert!(!cases.is_empty(), "{name} arrived with no cases");
        for (value, ok) in cases {
            pinned += 1;
            match rules.refinement_verdict(name, value) {
                Some(verdict) if verdict == *ok => {}
                other => problems.push(format!(
                    "{name}({value:?}): zod said {ok}, Rust said {other:?}"
                )),
            }
        }
    }
    assert!(pinned > 0, "no refinement is pinned by the fixture");
    assert!(
        problems.is_empty(),
        "the refinement port disagrees with zod:\n{}",
        problems.join("\n")
    );
}

/// Every arm of both unions is either value-checked or listed as having nothing
/// to check. Nothing in between: an arm nobody looked at is a port gap.
#[test]
fn every_arm_is_known() {
    let rules = table();
    let evidence = doc();
    let all = vectors();
    let mut problems = Vec::new();
    for (name, side) in [("client", &all.client), ("server", &all.server)] {
        let checked: BTreeSet<&str> = rules
            .arms_for(name)
            .map(|arms| arms.keys().map(String::as_str).collect())
            .unwrap_or_default();
        let bare: BTreeSet<&str> = rules
            .arms_without_rules(name)
            .iter()
            .map(String::as_str)
            .collect();
        for arm in &side.types {
            if !checked.contains(arm.as_str()) && !bare.contains(arm.as_str()) {
                problems.push(format!(
                    "{name}/{arm}: neither value-checked nor listed as rule-free"
                ));
            }
        }
        for arm in checked.union(&bare) {
            if !side.types.iter().any(|known| known == arm) {
                problems.push(format!(
                    "{name}/{arm}: in the rule table, not in the schema's union"
                ));
            }
        }
        assert_eq!(
            checked.len() + bare.len(),
            evidence.arms_without_rules[name].len() + checked.len(),
            "{name}: the fixture's rule-free list and the loaded table disagree"
        );
    }
    assert!(
        !all.client.types.is_empty() && !all.server.types.is_empty(),
        "the vector fixture carries no arms to check"
    );
    if !problems.is_empty() {
        report("an arm of the protocol is unaccounted for", &problems);
    }
}

/// The table states its own size, so a generator change that quietly drops rules
/// or stops proving them shows up as a failing test rather than a smaller diff.
#[test]
fn the_table_says_how_much_it_covers() {
    let rules = table();
    let evidence = doc();
    let counted = ["client", "server"]
        .iter()
        .filter_map(|union| rules.arms_for(union))
        .flat_map(|arms| arms.values())
        .flat_map(|rows| rows.iter().map(|row| row.rules.len()))
        .sum::<usize>();
    assert_eq!(
        counted, evidence.counts.rules,
        "the rule table holds {counted} rules, the fixture claims {}",
        evidence.counts.rules
    );
    assert_eq!(
        evidence.violations.len(),
        evidence.counts.violations,
        "the fixture claims {} proved violations and holds {}",
        evidence.counts.violations,
        evidence.violations.len()
    );
    assert_eq!(
        evidence.skipped.len(),
        evidence.counts.skipped,
        "the fixture claims {} untested rules and holds {}",
        evidence.counts.skipped,
        evidence.skipped.len()
    );
    assert!(
        !evidence.violations.is_empty(),
        "no rule is proved by a frame zod refused"
    );
}

/// Each untested rule says why, and is a rule the table really has. Silence here
/// would be how the value layer stops covering a field without anyone noticing.
#[test]
fn untested_rules_are_reported_with_a_reason() {
    let rules = table();
    let evidence = doc();
    let mut problems = Vec::new();
    for skipped in &evidence.skipped {
        if skipped.why.trim().is_empty() {
            problems.push(format!(
                "{}/{} {} {}: skipped with no reason",
                skipped.union, skipped.r#type, skipped.path, skipped.rule
            ));
            continue;
        }
        let known = rules
            .arms_for(&skipped.union)
            .and_then(|arms| arms.get(&skipped.r#type))
            .is_some_and(|rows| {
                rows.iter()
                    .any(|row| validate::spell(&row.path) == skipped.path)
            });
        if !known {
            problems.push(format!(
                "{}/{} {} {}: reported untested but the table has no such path",
                skipped.union, skipped.r#type, skipped.path, skipped.rule
            ));
        }
    }
    if !problems.is_empty() {
        report("an untested rule is unexplained or stale", &problems);
    }
}

/// Every generated path survives a round trip through the port's path reader, so
/// a rule cannot land on a field near the one zod put it on. Without this, a
/// reader bug would move a constraint to a different field and every test above
/// could still pass, because they check the paths the reader itself produced.
#[test]
fn every_generated_path_round_trips_through_the_path_reader() {
    let raw: Value = serde_json::from_str(CONSTRAINTS).expect("the constraint table parses");
    let mut checked = 0;
    for union in ["client", "server"] {
        let arms = raw["rules"][union]
            .as_object()
            .expect("the table holds both unions");
        for rows in arms.values() {
            for row in rows.as_array().expect("an arm is a list of field rules") {
                let path = row["path"].as_str().expect("a field rule has a path");
                assert_eq!(
                    validate::spell(&validate::parse_path(path)),
                    path,
                    "{path:?} does not survive the port's path reader"
                );
                checked += 1;
            }
        }
    }
    assert!(
        checked >= 180,
        "only {checked} paths were round-tripped, which is fewer than the table holds"
    );
}
