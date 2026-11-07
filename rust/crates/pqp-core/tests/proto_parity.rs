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
        .unwrap_or_else(|e| panic!("{}: Rust refuses a frame zod accepts: {e}", v.r#type));
    let out = serde_json::to_value(&parsed)
        .unwrap_or_else(|e| panic!("{}: Rust cannot re-serialize: {e}", v.r#type));
    assert_eq!(
        out, v.canonical,
        "{}: Rust's JSON differs from zod's parse output",
        v.r#type
    );
    // Parsing zod's own output must give the same struct back, which is what
    // makes the null-vs-absent mapping safe to rely on.
    let again: T = serde_json::from_value(v.canonical.clone())
        .unwrap_or_else(|e| panic!("{}: Rust refuses zod's own output: {e}", v.r#type));
    assert_eq!(
        serde_json::to_value(&again).unwrap(),
        v.canonical,
        "{}: round trip is not idempotent",
        v.r#type
    );
}

#[test]
fn client_frames_round_trip_byte_for_byte() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
    assert_eq!(
        fixture.client.types.len(),
        fixture.client.vectors.len(),
        "one vector per client message type"
    );
    for v in &fixture.client.vectors {
        round_trip::<VoiceClientMessage>(v);
    }
}

#[test]
fn server_frames_round_trip_byte_for_byte() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
    assert_eq!(
        fixture.server.types.len(),
        fixture.server.vectors.len(),
        "one vector per server message type"
    );
    let mut ported = 0;
    for v in &fixture.server.vectors {
        if fixture.server.pending.contains(&v.r#type) {
            continue;
        }
        round_trip::<VoiceSignalingMessage>(v);
        ported += 1;
    }
    assert!(
        ported >= 20,
        "expected the port to cover the voice lifecycle, got {ported}"
    );
}

/// A pending arm has to be **refused**, not accepted into a partially
/// understood struct. Silently coercing `channel-live` into something the port
/// half-reads would surface as a wrong room state; refusing it is loud. When a
/// pending arm is ported, this test fails until it is removed from the list,
/// which is what keeps the list honest.
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
