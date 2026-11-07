//! Wire-parity test for the voice protocol against zod.
//!
//! `rust/fixtures/proto-vectors.json` holds one zod-validated frame per arm of
//! `voiceClientMessageSchema` and `voiceSignalingMessageSchema`, together with
//! the canonical form of zod's own parse output. Canonical means: defaults
//! filled, a field that is nullable and absent written as `null`, a field that
//! is merely optional and absent dropped. That is the mapping documented in
//! `proto.rs`, so this test checks the port against the schema rather than
//! against anyone's reading of it.
//!
//! Coverage is derived from the schema, not from a list in this file: the
//! generator refuses to write a fixture that skips an arm, so a message type
//! added to the schema and not to the port fails CI. That is the #406 bug
//! class — `set-raised-hand` and `voice-still-here` each reached no handler
//! once because the accepted-type list was maintained by hand, and the second
//! one hung up people who were still in the call.

use pqp_core::proto::{VoiceClientMessage, VoiceSignalingMessage};
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../fixtures/proto-vectors.json");

#[derive(Deserialize)]
struct Fixture {
    client: Side,
    server: ServerSide,
}

#[derive(Deserialize)]
struct ServerSide {
    types: Vec<String>,
    vectors: Vec<Vector>,
    pending: Vec<String>,
}

#[derive(Deserialize)]
struct Side {
    types: Vec<String>,
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    r#type: String,
    /// Which example of this arm the vector is, e.g. `music#2`. An arm with a
    /// nullable nested object is tested both filled and null, so one arm can
    /// own several vectors.
    label: String,
    input: Value,
    canonical: Value,
}

/// `input` must parse, and re-serializing must produce exactly `canonical`.
/// A field the port drops that zod kept, or a default the port fails to fill,
/// changes the JSON the other side reads, so compare the whole document rather
/// than a few fields.
fn round_trip<T>(v: &Vector)
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let parsed: T = serde_json::from_value(v.input.clone())
        .unwrap_or_else(|e| panic!("{}: Rust refuses a frame zod accepts: {e}", v.label));
    let out = serde_json::to_value(&parsed)
        .unwrap_or_else(|e| panic!("{}: Rust cannot re-serialize: {e}", v.label));
    assert_eq!(
        out, v.canonical,
        "{}: Rust's JSON differs from zod's parse output",
        v.label
    );
    // Parsing zod's own output must give the same struct back, which is what
    // makes the null-vs-absent mapping safe to rely on.
    let again: T = serde_json::from_value(v.canonical.clone())
        .unwrap_or_else(|e| panic!("{}: Rust refuses zod's own output: {e}", v.label));
    assert_eq!(
        serde_json::to_value(&again).unwrap(),
        v.canonical,
        "{}: round trip is not idempotent",
        v.label
    );
}

/// Every arm the schema has must own at least one vector, and no vector may
/// belong to an arm the schema does not have. `types` comes from the union
/// itself, so this fails when somebody adds a message type and only updates
/// one side of the port.
fn assert_arm_coverage(types: &[String], vectors: &[Vector], side: &str) {
    assert!(!types.is_empty(), "{side}: the union is empty");
    let arms: std::collections::HashSet<&str> = types.iter().map(String::as_str).collect();
    for arm in types {
        assert!(
            vectors.iter().any(|v| &v.r#type == arm),
            "{side}: {arm} has no vector; the fixture is stale"
        );
    }
    for v in vectors {
        assert!(
            arms.contains(v.r#type.as_str()),
            "{side}: a vector for {} is not an arm of the schema",
            v.r#type
        );
    }
}

#[test]
fn client_frames_round_trip_byte_for_byte() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
    assert_arm_coverage(&fixture.client.types, &fixture.client.vectors, "client");
    for v in &fixture.client.vectors {
        round_trip::<VoiceClientMessage>(v);
    }
}

#[test]
fn server_frames_round_trip_byte_for_byte() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
    assert_arm_coverage(&fixture.server.types, &fixture.server.vectors, "server");
    let mut ported = std::collections::HashSet::new();
    for v in &fixture.server.vectors {
        if fixture.server.pending.contains(&v.r#type) {
            continue;
        }
        round_trip::<VoiceSignalingMessage>(v);
        ported.insert(v.r#type.as_str());
    }
    // Phase 1 ported the last of the server arms, so the honest claim now is
    // the whole union, not "enough of it". An arm added to the schema later
    // has to be ported here or listed as pending in the generator.
    let arms: std::collections::HashSet<&str> =
        fixture.server.types.iter().map(String::as_str).collect();
    assert_eq!(
        ported, arms,
        "server arms the port does not speak (subtract the ones listed as pending)"
    );
}

/// A pending arm has to be **refused**, not accepted into a partially
/// understood struct. Silently coercing `channel-live` into something the port
/// half-reads would surface as a wrong room state; refusing it is loud. When a
/// pending arm is ported, this test fails until it is removed from the list,
/// which is what keeps the list honest. Phase 1 emptied the list, so this loop
/// passes by doing nothing today; it is the guard for the next arm somebody
/// adds to the schema and cannot port in the same PR.
#[test]
fn pending_server_frames_are_refused_not_misread() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
    let types: std::collections::HashSet<&str> = fixture
        .server
        .vectors
        .iter()
        .map(|v| v.r#type.as_str())
        .collect();
    for pending in &fixture.server.pending {
        assert!(
            types.contains(pending.as_str()),
            "pending entry {pending} has no vector; the fixture is stale"
        );
        let vector = fixture
            .server
            .vectors
            .iter()
            .find(|v| &v.r#type == pending)
            .expect("vector");
        assert!(
            serde_json::from_value::<VoiceSignalingMessage>(vector.input.clone()).is_err(),
            "{pending} is listed as pending but the port parses it: move it out of `pending`"
        );
    }
}

/// Frames that are not in the union must not parse. A permissive fallback here
/// would let a malformed frame become a half-populated struct, and voice code
/// that acts on a struct with the wrong type tag moves people between rooms.
#[test]
fn unknown_and_malformed_frames_are_refused() {
    let bad = [
        serde_json::json!({"type": "voice-teleport", "voiceChannelId": "c"}),
        serde_json::json!({"type": "set-voice-state", "muted": "yes", "deafened": false}),
        // `canSpeak` is optional and not nullable: null is a violation, unlike
        // `cameraStreamId`, where null and absent mean the same thing.
        serde_json::json!({"type": "welcome", "peerId": "p", "peers": [], "voiceChannelId": "c",
                           "self": {"peerId": "p", "userId": "u", "displayName": "d",
                                     "avatarUrl": null, "canSpeak": null}}),
        serde_json::json!({"type": "voice-roster-delta", "voiceChannelId": "c", "seq": 1}),
        serde_json::json!({"noType": true}),
        // The arms phase 1 ported, on the cases zod refuses. Value constraints
        // (a uuid, a max length, a non-empty array) are NOT re-checked here,
        // only structure — see the limits note in `proto.rs`.
        serde_json::json!({"type": "channel-live", "channelId": "c", "stream": null,
                           "watching": 2, "ended": null}),
        serde_json::json!({"type": "music", "channelId": "c", "state": {}}),
        serde_json::json!({"type": "voice-audience", "voiceChannelId": "c",
                           "audience": {"since": 1, "byUserId": "u", "speakerUserIds": []},
                           "change": {"kind": "sideways"}}),
        serde_json::json!({"type": "soundboard-play", "channelId": "c"}),
        serde_json::json!({"type": "voice-stream", "channelId": "c",
                           "stream": {"startedAt": 1, "presenterPeerId": "p"}}),
    ];
    for frame in bad {
        assert!(
            serde_json::from_value::<VoiceSignalingMessage>(frame.clone()).is_err(),
            "Rust accepted a frame zod would refuse: {frame}"
        );
    }
}

/// The two frames behind #406 must survive the port, because their absence is
/// invisible: nothing errors, a button just stops working and a person alone
/// in a call gets hung up.
#[test]
fn the_frames_the_router_once_dropped_still_dispatch() {
    for raw in [
        r#"{"type":"set-raised-hand","raised":true}"#,
        r#"{"type":"voice-still-here"}"#,
    ] {
        let parsed: VoiceClientMessage =
            serde_json::from_str(raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
        assert_eq!(serde_json::to_string(&parsed).unwrap(), raw);
    }
}
