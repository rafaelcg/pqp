//! Differential parity test against the shipped TypeScript implementation.
//!
//! Every case in `rust/fixtures/resume-vectors.json` was produced by
//! `server/src/ws/voice-resume-token.ts` and carries the verdict the
//! TypeScript verifier reached. This test does not encode what the author
//! believes a resume token should do; it asserts the Rust port reaches the
//! same verdict and the same claims on the same bytes. Regenerate the fixture
//! with `node rust/scripts/gen-resume-vectors.mjs` after touching either side.

use pqp_core::resume::{
    mint_voice_resume_token, verify_voice_resume_token, ResumeClaims, ResumeSecret,
    VoiceRoomTransport,
};
use serde::Deserialize;
use std::path::PathBuf;

const FIXTURE: &str = include_str!("../../../fixtures/resume-vectors.json");

#[derive(Deserialize)]
struct Fixture {
    keys: Keys,
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Keys {
    clerk: String,
    dev: String,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    env: String,
    token: Option<String>,
    now: i64,
    #[serde(rename = "match")]
    match_: Match,
    ts: TsVerdict,
}

#[derive(Deserialize, Debug)]
struct Match {
    #[serde(rename = "userId")]
    user_id: String,
    #[serde(rename = "peerId")]
    peer_id: String,
    #[serde(rename = "voiceChannelId")]
    voice_channel_id: String,
}

#[derive(Deserialize, Debug)]
struct TsVerdict {
    ok: bool,
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    region: Option<String>,
}

fn secret_for(env: &str, keys: &Keys) -> ResumeSecret {
    match env {
        "clerk" => ResumeSecret::new(Some(keys.clerk.clone()), false),
        "dev" => {
            // The dev stand-in lives in the crate, so pin it to the value the
            // TypeScript used. A drift here is a broken local dev resume that
            // only shows up when someone reboots mid-call.
            assert_eq!(keys.dev, pqp_core::resume::DEV_RESUME_SECRET);
            ResumeSecret::new(None, true)
        }
        "none" => ResumeSecret::new(None, false),
        other => panic!("unknown env kind {other}"),
    }
}

/// Both sides must agree on accept/reject *and* on the claims that come back.
/// A Rust that only matched the accept/reject bit could still hand the room a
/// different transport or region, which puts a peer on the wrong media path.
#[test]
fn matches_the_typescript_verdict_on_every_vector() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
    let mut verified = 0;
    for v in &fixture.vectors {
        let secret = secret_for(&v.env, &fixture.keys);
        let got = verify_voice_resume_token(
            &secret,
            v.token.as_deref(),
            ResumeClaims {
                user_id: &v.match_.user_id,
                peer_id: &v.match_.peer_id,
                voice_channel_id: &v.match_.voice_channel_id,
            },
            v.now,
        );
        match (&v.ts, got) {
            (TsVerdict { ok: false, .. }, None) => {}
            (TsVerdict { ok: false, .. }, Some(g)) => panic!(
                "{}: TypeScript refused, Rust accepted as {:?} in region {:?}",
                v.name, g.transport, g.region
            ),
            (_ts, None) => panic!("{}: TypeScript accepted, Rust refused", v.name),
            (ts, Some(g)) => {
                let transport = match g.transport {
                    VoiceRoomTransport::Mesh => "mesh",
                    VoiceRoomTransport::Livekit => "livekit",
                };
                assert_eq!(
                    ts.transport.as_deref(),
                    Some(transport),
                    "{}: transport",
                    v.name
                );
                assert_eq!(
                    ts.region.as_deref(),
                    g.region.as_deref(),
                    "{}: region",
                    v.name
                );
                verified += 1;
            }
        }
    }
    assert!(
        verified >= 8,
        "expected most vectors to verify, got {verified}"
    );
}

/// The payload is hashed as bytes, so claim order and the absent-vs-empty
/// region rule are part of the wire format. Pin the exact token a given set of
/// claims produces, using a token the TypeScript minted for the same claims.
#[test]
fn mints_bytes_identical_to_typescript() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
    for name in [
        "mesh-no-region",
        "livekit-with-region",
        "empty-region-is-absent",
        "dev-bypass-key",
    ] {
        let v = fixture.vectors.iter().find(|v| v.name == name).expect(name);
        let secret = secret_for(&v.env, &fixture.keys);
        let transport = if v.name == "livekit-with-region" {
            VoiceRoomTransport::Livekit
        } else {
            VoiceRoomTransport::Mesh
        };
        let region = if v.name == "livekit-with-region" {
            Some("gru")
        } else {
            None
        };
        let minted = mint_voice_resume_token(
            &secret,
            &v.match_.user_id,
            &v.match_.peer_id,
            &v.match_.voice_channel_id,
            transport,
            region,
            1_700_000_000_000,
        )
        .expect("mint");
        assert_eq!(
            minted,
            v.token.as_deref().unwrap(),
            "{name}: token bytes differ from TypeScript"
        );
    }
}

/// No signing key means resume is off, and minting must say so rather than
/// produce a token nobody can check.
#[test]
fn minting_without_a_signing_key_yields_nothing() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
    let secret = ResumeSecret::new(None, false);
    assert_eq!(
        mint_voice_resume_token(&secret, "u", "p", "c", VoiceRoomTransport::Mesh, None, 0),
        None
    );
    assert!(fixture
        .vectors
        .iter()
        .any(|v| v.name == "no-signing-key" && v.token.is_none()));
}

/// Reverse leg: hand the TypeScript verifier tokens that only Rust produced.
/// Emitted for `rust/scripts/verify-rust-tokens.mjs`, which runs them through
/// the real `verifyVoiceResumeToken`. Skipped when the path is not requested,
/// so a plain `cargo test` stays self-contained.
#[test]
fn emits_rust_minted_tokens_for_the_typescript_verifier() {
    let Some(out) = std::env::var_os("PQP_RUST_MINTED_OUT") else {
        eprintln!("PQP_RUST_MINTED_OUT unset, skipping reverse leg");
        return;
    };
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
    let secret = ResumeSecret::new(Some(fixture.keys.clerk.clone()), false);
    let now = 1_700_000_000_000i64;
    let cases = [
        ("mesh", VoiceRoomTransport::Mesh, None),
        ("livekit-gru", VoiceRoomTransport::Livekit, Some("gru")),
        ("livekit-no-region", VoiceRoomTransport::Livekit, None),
    ];
    let minted: Vec<serde_json::Value> = cases
        .iter()
        .map(|(name, transport, region)| {
            let token = mint_voice_resume_token(
                &secret,
                "11111111-1111-4111-8111-111111111111",
                "peer-a",
                "chan-a",
                *transport,
                *region,
                now,
            )
            .expect("mint");
            serde_json::json!({
                "name": name,
                "token": token,
                "now": now,
                "expected": { "transport": name.split('-').next().unwrap(), "region": region },
            })
        })
        .collect();
    std::fs::write(
        PathBuf::from(out),
        serde_json::to_vec_pretty(&minted).unwrap(),
    )
    .expect("write minted tokens");
}
