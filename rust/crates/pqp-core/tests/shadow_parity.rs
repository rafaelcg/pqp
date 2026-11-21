//! The shadow accounting is what phase 2 arms enforcement from, so it is tested
//! against the same generated evidence the value layer is — not against cases
//! written here.
//!
//! Two directions, and both matter: a shadow run that under-counts would arm
//! enforcement on an arm that is actually refusing traffic, and one that
//! over-reports refusals would leave an arm unarmable forever. So every frame in
//! the protocol vectors must land as one frame and no refusal, and every proved
//! violation in the constraint table must land as a refusal of that same arm.
use pqp_core::validate::{self, Shadow};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

const CONSTRAINTS: &str = include_str!("../fixtures/constraints.json");
const VECTORS: &str = include_str!("../fixtures/proto-vectors.json");

#[derive(Deserialize)]
struct Doc {
    violations: Vec<Proved>,
}

#[derive(Deserialize)]
struct Proved {
    union: String,
    r#type: String,
    frame: Value,
}

#[derive(Deserialize)]
struct Vectors {
    client: Side,
    server: Side,
}

#[derive(Deserialize)]
struct Side {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    r#type: String,
    input: Value,
}

fn rules() -> validate::Rules {
    validate::load(CONSTRAINTS).expect("the shipped constraint table loads")
}

fn side(union: &str) -> Side {
    let v: Vectors = serde_json::from_str(VECTORS).expect("the protocol vectors parse");
    if union == "client" {
        v.client
    } else {
        v.server
    }
}

#[test]
fn a_healthy_room_shows_frames_and_no_refusals() {
    let rules = rules();
    for union in ["client", "server"] {
        let vectors = side(union);
        let inputs: Vec<&Value> = vectors.vectors.iter().map(|v| &v.input).collect();
        let report = validate::audit_frames(union, &rules, inputs.iter().copied());
        assert_eq!(
            report.frames,
            vectors.vectors.len(),
            "{union}: every frame has to be counted"
        );
        assert_eq!(
            report.refused, 0,
            "{union}: a frame zod accepts must not be a refusal — the samples were {:?}",
            report.samples
        );
        assert_eq!(report.unparsed, 0, "{union}: every vector is JSON");
        for vector in &vectors.vectors {
            let counts = report
                .per_type
                .get(&vector.r#type)
                .unwrap_or_else(|| panic!("{union}: {} was never counted", vector.r#type));
            assert!(counts.frames >= 1, "{} reached the table", vector.r#type);
        }
        // Every arm in the corpus is therefore ready to arm, and none of it is
        // ready because it was never seen.
        let ready = report.arming_ready();
        let seen: Vec<&str> = report
            .per_type
            .iter()
            .filter(|(_, c)| c.frames > 0)
            .map(|(t, _)| t.as_str())
            .collect();
        assert_eq!(
            ready, seen,
            "{union}: a counted arm with no refusals is arming-ready"
        );
    }
}

#[test]
fn every_proved_violation_shows_up_as_a_refusal_of_its_own_arm() {
    let rules = rules();
    let doc: Doc = serde_json::from_str(CONSTRAINTS).expect("the constraint table parses");

    // Group by union, because one audit run is one direction of the wire.
    let mut by_union: BTreeMap<&str, Vec<&Proved>> = BTreeMap::new();
    for proved in &doc.violations {
        by_union
            .entry(proved.union.as_str())
            .or_default()
            .push(proved);
    }

    let mut audited = 0usize;
    for (union, group) in &by_union {
        let frames: Vec<&Value> = group.iter().map(|p| &p.frame).collect();
        let report = validate::audit_frames(union, &rules, frames.into_iter());
        assert_eq!(
            report.frames,
            group.len(),
            "{union}: each violating frame is one frame"
        );
        assert_eq!(
            report.refused,
            group.len(),
            "{union}: every proved violation has to be a refusal"
        );
        audited += group.len();
        // No arm this run touched may be reported as ready.
        for proved in group {
            assert!(
                !report.arming_ready().contains(&proved.r#type.as_str()),
                "{} looked arming-ready even though its own rule was broken",
                proved.r#type
            );
            assert!(
                !report.quiet_for(&proved.r#type, 1),
                "{} is not quiet",
                proved.r#type
            );
        }
    }
    assert_eq!(
        audited,
        doc.violations.len(),
        "every proved violation was audited"
    );
}

#[test]
fn a_frame_that_is_not_json_is_counted_and_never_called_a_refusal() {
    let rules = rules();
    let report = validate::audit(
        "client",
        &rules,
        ["", "   ", "not json", "{", "{\"type\":\"ping\"}"]
            .iter()
            .copied(),
    );
    // Blank lines are not traffic at all. `not json` and `{` are, and the Node
    // handler tolerates them the same way, so they must not read as refusals.
    assert_eq!(
        report.frames, 1,
        "only the parsed frame reached the value layer"
    );
    assert_eq!(report.unparsed, 2, "two lines were not JSON");
    assert_eq!(report.refused, 0, "unparseable is not the same as illegal");
}

#[test]
fn a_frame_with_no_type_is_counted_rather_than_dropped() {
    let rules = rules();
    let report: Shadow = validate::audit(
        "client",
        &rules,
        ["{\"voiceChannelId\":\"not-a-uuid\"}"].iter().copied(),
    );
    assert_eq!(report.frames, 1, "it reached the edge, so it counts");
    assert!(
        report.per_type.contains_key("<no type>"),
        "an untyped arm has to appear in the per-arm table, got {:?}",
        report.per_type.keys().collect::<Vec<_>>()
    );
}

#[test]
fn quiet_for_needs_traffic_behind_it() {
    // An arm that was never seen is not evidence that enforcement is safe; it is
    // evidence that nobody looked.
    let report = Shadow::default();
    assert!(!report.quiet_for("join-voice-room", 1));
    assert!(report.arming_ready().is_empty());
}
