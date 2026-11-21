//! Replays the A1 wire fixtures (`packages/shared/fixtures/wire/`, generated
//! from the shipped zod schemas) against the prototype's frame types, so the
//! prototype cannot drift from the protocol silently. The rules follow the plan
//! (docs/plans/RUST.md, A2): decode every valid vector of an arm the prototype
//! handles, never apply a refused one it is able to refuse, and keep an exact
//! allowlist of the arms it does not handle that fails the day an arm is added
//! or becomes handled.

use pqp_desktop_proto::wire::{ClientFrame, ServerFrame};
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::path::PathBuf;

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/shared/fixtures/wire")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("fixture is JSON")
}

/// Server arms the prototype reads into a typed frame.
const SERVER_HANDLED: &[&str] = &[
    "welcome",
    "peer-joined",
    "peer-updated",
    "peer-left",
    "voice-roster",
    "voice-roster-delta",
    "voice-room-full",
    "voice-transport-unsupported",
    "voice-transport-changed",
    "voice-join-refused",
    "voice-moderation",
];

/// Server arms the prototype ignores (they decode as `ServerFrame::Other`).
const SERVER_NOT_HANDLED: &[&str] = &[
    "screen-share-denied",
    "camera-denied",
    "offer",
    "answer",
    "ice-candidate",
    "call-incoming",
    "call-ring-cancelled",
    "call-declined",
    "voice-speak-changed",
    "voice-audience",
    "voice-idle-warning",
    "voice-idle-warning-cancelled",
    "watch-party",
    "music",
    "channel-music",
    "live-reactions",
    "soundboard-play",
    "voice-stream",
    "channel-live",
];

/// Client arms the prototype sends.
const CLIENT_SENT: &[&str] = &["join-voice-room", "leave-voice-room", "set-voice-state"];

const CLIENT_NOT_SENT: &[&str] = &[
    "set-sharing-screen",
    "offer",
    "answer",
    "ice-candidate",
    "call-ring",
    "call-decline",
    "set-camera",
    "set-raised-hand",
    "voice-still-here",
    "set-watch-party",
    "set-voice-track-mode",
    "set-music",
    "set-music-listening",
    "live-reaction",
    "soundboard-play",
    "watch-live",
];

/// Value rules the prototype does not enforce on a received frame (C1's job).
/// A violation of any other kind must be refused by the decoder.
const NOT_ENFORCED: &[&str] = &["guid", "minLen", "maxLen", "safeint", "ge", "gt", "url", "maxItems", "minItems"];

fn types(v: &Value, side: &str) -> BTreeSet<String> {
    v[side]["types"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap().to_string())
        .collect()
}

fn vectors<'a>(v: &'a Value, side: &str) -> &'a Vec<Value> {
    v[side]["vectors"].as_array().unwrap()
}

fn assert_partition(all: &BTreeSet<String>, handled: &[&str], not: &[&str], what: &str) {
    let h: BTreeSet<String> = handled.iter().map(|s| s.to_string()).collect();
    let n: BTreeSet<String> = not.iter().map(|s| s.to_string()).collect();
    let both: Vec<_> = h.intersection(&n).collect();
    assert!(both.is_empty(), "{what}: listed as handled AND not handled: {both:?}");
    let listed: BTreeSet<String> = h.union(&n).cloned().collect();
    let new: Vec<_> = all.difference(&listed).collect();
    assert!(
        new.is_empty(),
        "{what}: arms in the fixtures that this prototype neither handles nor lists as not handled: {new:?}"
    );
    let gone: Vec<_> = listed.difference(all).collect();
    assert!(gone.is_empty(), "{what}: arms listed here that the fixtures no longer have: {gone:?}");
}

#[test]
fn every_arm_is_handled_or_listed() {
    let v = fixture("proto-vectors.json");
    assert_partition(&types(&v, "server"), SERVER_HANDLED, SERVER_NOT_HANDLED, "server");
    assert_partition(&types(&v, "client"), CLIENT_SENT, CLIENT_NOT_SENT, "client");
}

/// Every key the prototype modeled reads exactly what zod's canonical parse
/// reads. Keys the prototype does not model are allowed to be absent.
fn assert_subset(mine: &Value, canonical: &Value, path: &str) {
    match (mine, canonical) {
        (Value::Object(m), Value::Object(c)) => {
            for (k, mv) in m {
                let cv = c.get(k).unwrap_or_else(|| {
                    panic!("{path}.{k}: the prototype emits a key zod's canonical parse does not have")
                });
                assert_subset(mv, cv, &format!("{path}.{k}"));
            }
        }
        (Value::Array(m), Value::Array(c)) => {
            assert_eq!(m.len(), c.len(), "{path}: array length");
            for (i, (mv, cv)) in m.iter().zip(c).enumerate() {
                assert_subset(mv, cv, &format!("{path}[{i}]"));
            }
        }
        _ => assert_eq!(mine, canonical, "{path}: value differs from the canonical parse"),
    }
}

#[test]
fn every_valid_server_vector_decodes_to_its_canonical_form() {
    let v = fixture("proto-vectors.json");
    let mut decoded = 0;
    for vec in vectors(&v, "server") {
        let ty = vec["type"].as_str().unwrap();
        let label = vec["label"].as_str().unwrap();
        let frame: ServerFrame = serde_json::from_value(vec["input"].clone())
            .unwrap_or_else(|e| panic!("{label}: a frame zod accepts did not decode: {e}"));
        if SERVER_HANDLED.contains(&ty) {
            assert_ne!(frame, ServerFrame::Other, "{label}: a handled arm fell through to Other");
            let mine = serde_json::to_value(&frame).unwrap();
            assert_subset(&mine, &vec["canonical"], label);
            decoded += 1;
        } else {
            assert_eq!(frame, ServerFrame::Other, "{label}: an ignored arm must decode as Other");
        }
    }
    assert!(decoded >= SERVER_HANDLED.len(), "every handled arm has at least one vector");
}

fn rules_for<'a>(c: &'a Value, side: &str, ty: &str) -> Vec<(&'a str, &'a Map<String, Value>)> {
    let mut out = Vec::new();
    if let Some(list) = c["rules"][side][ty].as_array() {
        for entry in list {
            let path = entry["path"].as_str().unwrap();
            for rule in entry["rules"].as_array().unwrap() {
                out.push((path, rule.as_object().unwrap()));
            }
        }
    }
    out
}

/// Values at a fixture path (`a.b`, `a[]`, `a[].b`); empty when absent.
fn at<'a>(v: &'a Value, path: &str) -> Vec<&'a Value> {
    let mut cur = vec![v];
    for seg in path.split('.') {
        let (key, each) = match seg.strip_suffix("[]") {
            Some(k) => (k, true),
            None => (seg, false),
        };
        let mut next = Vec::new();
        for c in cur {
            if let Some(x) = c.get(key) {
                if each {
                    next.extend(x.as_array().into_iter().flatten());
                } else {
                    next.push(x);
                }
            }
        }
        cur = next;
    }
    cur
}

fn is_guid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// The frames the prototype sends obey every value rule zod has for their arm.
#[test]
fn sent_frames_obey_the_value_rules() {
    let c = fixture("constraints.json");
    let id = "33333333-3333-4333-8333-333333333333";
    let sent = [
        ("join-voice-room", ClientFrame::join(id)),
        ("leave-voice-room", ClientFrame::LeaveVoiceRoom {}),
        ("set-voice-state", ClientFrame::SetVoiceState { muted: true, deafened: false }),
    ];
    let v = fixture("proto-vectors.json");
    for (ty, frame) in sent {
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["type"], ty);
        // Shape: only keys some valid vector of this arm also carries.
        let known: BTreeSet<String> = vectors(&v, "client")
            .iter()
            .filter(|x| x["type"] == ty)
            .flat_map(|x| x["input"].as_object().unwrap().keys().cloned())
            .collect();
        for k in json.as_object().unwrap().keys() {
            assert!(known.contains(k), "{ty}: sends `{k}`, which no valid vector of the arm has");
        }
        for (path, rule) in rules_for(&c, "client", ty) {
            let kind = rule["k"].as_str().unwrap();
            for val in at(&json, path) {
                match kind {
                    "guid" => assert!(is_guid(val.as_str().unwrap()), "{ty}.{path}: not a guid"),
                    "minLen" => assert!(
                        val.as_str().unwrap().chars().count() as u64 >= rule["v"].as_u64().unwrap(),
                        "{ty}.{path}: too short"
                    ),
                    "minItems" => assert!(
                        val.as_array().unwrap().len() as u64 >= rule["v"].as_u64().unwrap(),
                        "{ty}.{path}: too few items"
                    ),
                    "enum" => assert!(
                        rule["v"].as_array().unwrap().contains(val),
                        "{ty}.{path}: {val} is not in the enum"
                    ),
                    other => panic!("{ty}.{path}: rule kind `{other}` has no check here; add one"),
                }
            }
        }
    }
}

/// A violation of a handled server arm is refused by the decoder, unless its
/// rule kind is one the prototype knowingly does not enforce (NOT_ENFORCED).
#[test]
fn violations_of_handled_arms_are_refused_or_knowingly_unenforced() {
    let c = fixture("constraints.json");
    let mut refused = 0;
    let mut ignored = 0;
    let mut unenforced = std::collections::BTreeMap::<String, u32>::new();
    for vio in c["violations"].as_array().unwrap() {
        if vio["union"] != "server" {
            continue;
        }
        let ty = vio["type"].as_str().unwrap();
        if !SERVER_HANDLED.contains(&ty) {
            continue;
        }
        // `enum(a|b)` names its values; the kind is what precedes them.
        let rule_name = vio["rule"].as_str().unwrap();
        let rule = rule_name.split('(').next().unwrap();
        let path = vio["path"].as_str().unwrap();
        match serde_json::from_value::<ServerFrame>(vio["frame"].clone()) {
            Err(_) => refused += 1,
            Ok(ServerFrame::Other) => panic!("{ty}: a violation decoded as Other"),
            Ok(frame) => {
                // A field the prototype never reads cannot mislead it.
                let mine = serde_json::to_value(&frame).unwrap();
                if at(&mine, path).is_empty() {
                    ignored += 1;
                    continue;
                }
                assert!(
                    NOT_ENFORCED.contains(&rule),
                    "{ty} at {path}: a `{rule_name}` violation of a field the prototype reads was accepted; only {NOT_ENFORCED:?} may be"
                );
                *unenforced.entry(rule.to_string()).or_default() += 1;
            }
        }
    }
    assert!(refused > 0, "at least the enum violations must be refused");
    // Written down, not hidden: what gets through until C1's validator exists.
    eprintln!(
        "violations refused: {refused}; on fields the prototype does not read: {ignored}; \
         accepted on fields it reads (not enforced until C1): {unenforced:?}"
    );
}
