//! The voice wire protocol, ported from `packages/shared/src/signaling.ts`.
//!
//! # Wire compatibility rules
//!
//! The port has to produce and accept the same JSON as the TypeScript, so the
//! mapping from Zod to serde is fixed and not a matter of taste:
//!
//! | Zod                     | Rust                                  | Serialized      |
//! |-------------------------|---------------------------------------|-----------------|
//! | `T`                     | `T`                                   | always present  |
//! | `T.nullable()`          | `Option<T>`                           | always, `null` ok |
//! | `T.nullable().optional()` | `Option<T>`                         | always, `null` ok |
//! | `T.optional()`          | `Option<T>` + `skip_serializing_if`   | only when set   |
//! | `T.default(x)`          | `T` + `#[serde(default)]`             | always present  |
//!
//! The asymmetry in the last two rows is the whole point. `canSpeak?: boolean`
//! and `cameraStreamId?: string | null` are not the same field shape: sending
//! `canSpeak: null` is a schema violation the server rejects, while
//! `cameraStreamId: null` and an absent `cameraStreamId` mean the same thing
//! and the sender omits it to keep frames small. A port that flattened both
//! into one optional type would either emit `null` where zod refuses it or
//! drop a field the receiver reads, and both failures are a silent voice bug
//! rather than an error. `tests/proto_parity.rs` pins every case against
//! zod's own parse output.
//!
//! Integers are ported as `i64` where the schema means an integer (epoch ms,
//! sequence numbers, bps). `z.number()` is a float, so the fixture generator
//! asserts integrality before emitting, which is what keeps that shortcut
//! honest.
//!
//! # Coverage
//!
//! Both unions here are complete: every arm of `voiceClientMessageSchema` and
//! `voiceSignalingMessageSchema` has a Rust variant, and the fixture's
//! `server.pending` list — the arms the port is allowed to refuse — is empty.
//! The mechanism stays, because the failure that matters is the next one: a
//! message type added to the schema and not to the port. The generator refuses
//! to write a fixture without an example for every arm, and
//! `tests/proto_parity.rs` fails on any arm that is neither ported nor listed
//! as pending, so growing the protocol forces a decision instead of a gap.
//!
//! An arm whose frame can hold a nested object is tested **both** with it and
//! null. One example either way is not enough: expanding `null` into an
//! all-`null` object and dropping a present object both look correct against a
//! single example, and the first one was a real bug here (`candidate: null`
//! became a bogus ICE frame). The generator derives the list of fields that
//! need both from the schema, so a newly nullable field demands its own
//! example.
//!
//! # What this port checks, and what it does not
//!
//! Serde checks **structure**: which fields are present, what type they are,
//! that an unknown key is refused. Zod also checks **values** — `.uuid()`,
//! `.min(1)`, `.max(64)`, `.url()`, `.refine(isSoundboardSoundId)`, array
//! bounds — and those are in [`crate::validate`], which compiles in the rule
//! table `rust/scripts/gen-constraints.mjs` reads off these same schemas.
//! `tests/value_parity.rs` then replays every frame zod refused and demands the
//! same refusal, blaming the same path for the same kind of rule. That is what
//! makes "Rust enforces what Node enforces" a checked claim instead of a
//! promise, and both layers are what a Rust socket needs before it is allowed to
//! end a connection on its own.
//!
//! Coverage is total: every rule in the table has a frame zod proved as a
//! violation, including the element rules a path spells `skipVotes[]` and the
//! fields an earlier set of examples never carried — `handRaisedAt`,
//! `channel-live`'s `stream.*`, `updated[].userId`, the `transports[]` enum, a
//! music `history`. `tests/value_parity.rs` fails if a rule ships without a
//! proved violation, so a schema field no example frame reaches stops the gate
//! instead of quietly narrowing what the port is known to enforce.

use crate::VoiceRoomTransport;
use serde::{Deserialize, Serialize};

/// A field that is optional but **not** nullable, as serde sees it.
///
/// `Option<T>` alone is not enough: serde reads `null` as `None`, while zod
/// refuses `null` for `canSpeak?: boolean` outright. Reading the two as the
/// same thing makes the port accept frames the server would reject, and the
/// difference shows up as a room state that quietly disagrees with the sender's.
/// Nullable fields keep the plain `Option<T>` (absent and `null` really do mean
/// the same thing there) and are the ones without this annotation.
pub(crate) mod strict_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Option::<Option<T>>::deserialize(deserializer)?.ok_or_else(|| {
            serde::de::Error::custom("this field is optional, not nullable: null is not valid")
        })
    }
}

/// A person's seat in a voice room, as every roster carries it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceParticipant {
    pub peer_id: String,
    pub user_id: String,
    pub display_name: String,
    /// Required and nullable: an absent `avatarUrl` is a schema violation.
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub sharing_screen: bool,
    pub camera_stream_id: Option<String>,
    pub screen_audio_stream_id: Option<String>,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub deafened: bool,
    /// Not nullable: only present when the server has an opinion.
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub can_speak: Option<bool>,
    #[serde(default)]
    pub server_muted: bool,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub can_stream: Option<bool>,
    pub hand_raised_at: Option<i64>,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub listening_music: Option<bool>,
}

/// Audience mode ("Liberar o microfone") state for a room.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAudienceState {
    /// When it was turned on, epoch ms.
    pub since: i64,
    pub by_user_id: String,
    /// Sorted by the server so two machines send the same array for the same
    /// rows. Do not sort or dedupe here; compare as received.
    pub speaker_user_ids: Vec<String>,
    /// People the media server has not confirmed as silenced. Always empty on
    /// a mesh room; absent reads as empty.
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub unenforced_user_ids: Option<Vec<String>>,
}

/// What just happened to audience mode, for the transient notice in the call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceAudienceChangeKind {
    On,
    Off,
    SpeakerAdded,
    SpeakerRemoved,
}

/// Why audience mode switched off by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceAudienceEndReason {
    /// A host turned it off.
    Host,
    /// The last person who could run the stage left the call.
    NoHost,
    /// The operator turned the feature off for this server.
    FlagOff,
}

/// The one-shot explanation that travels beside a `voice-audience` frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAudienceChange {
    pub kind: VoiceAudienceChangeKind,
    /// Who did it. `None` when the server did it on its own, which is also
    /// what an absent field means here: nullable **and** optional, so plain
    /// `Option` with no `skip_serializing_if` — zod's parse output always
    /// carries the key.
    pub by_user_id: Option<String>,
    /// `speaker-*` only: whom it was about.
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub user_id: Option<String>,
    /// `off` only: why.
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub reason: Option<VoiceAudienceEndReason>,
}

/// An ICE candidate, mirroring the browser's `RTCIceCandidateInit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceCandidateInit {
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub candidate: Option<String>,
    pub sdp_mid: Option<String>,
    pub sdp_m_line_index: Option<i64>,
    pub username_fragment: Option<String>,
}

/// Who is ringing whom in a DM or group call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerInfo {
    pub user_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallKind {
    Dm,
    Group,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RingCancelReason {
    Answered,
    Declined,
    Cancelled,
    Timeout,
}

/// Why the server moved a room off the transport it was pinned to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransportChangeReason {
    Cameras,
    Screens,
    RoomFull,
    RoomSize,
    StalePin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModerationAction {
    Disconnected,
    Moved,
    Muted,
    Unmuted,
}

/// Why a seat went idle: only the alone-in-a-call timer exists today, and the
/// `Option` is where a second reason would land.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModerationReason {
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeakReason {
    Permission,
    Audience,
}

/// The fixed reaction set the room coalesces. An emoji outside this list is a
/// schema violation, not a reaction to forward.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LiveReaction {
    #[serde(rename = "👍")]
    ThumbsUp,
    #[serde(rename = "❤️")]
    Heart,
    #[serde(rename = "😂")]
    Laugh,
    #[serde(rename = "😮")]
    Wow,
    #[serde(rename = "🔥")]
    Fire,
    #[serde(rename = "🎉")]
    Party,
}

/// One emoji's coalesced total in a `live-reactions` burst. The frame carries
/// counts only: never who tapped, and nothing is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveReactionCount {
    pub emoji: LiveReaction,
    /// Always at least one; a zero-count entry is a schema violation.
    pub count: i64,
}

/// Frames the client sends on the voice socket.
///
/// This union is **complete**: it mirrors every arm of
/// `voiceClientMessageSchema`, including `set-raised-hand` and
/// `voice-still-here`, which the Node router each failed to dispatch once
/// because its accepted-type list was kept by hand (#406). The idle-seat
/// miss meant a person alone in a call was hung up while pressing "still
/// here". `tests/proto_parity.rs` compares this enum's type strings against
/// the list the schema derives at runtime, on both sides of the port.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum VoiceClientMessage {
    #[serde(rename_all = "camelCase")]
    JoinVoiceRoom {
        voice_channel_id: String,
        /// What this client can actually do. The server picks the room's
        /// transport from this and the room size; it is a capability claim,
        /// not a preference.
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        transports: Option<Vec<VoiceRoomTransport>>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        resume_peer_id: Option<String>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        resume_token: Option<String>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        resume: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    LeaveVoiceRoom {
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        resume_peer_id: Option<String>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        resume_token: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    SetSharingScreen {
        sharing: bool,
        audio_stream_id: Option<String>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        uplink_bps: Option<i64>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        source_height: Option<i64>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        audio_needs_sfu: Option<bool>,
    },
    Offer {
        from: String,
        to: String,
        sdp: String,
    },
    Answer {
        from: String,
        to: String,
        sdp: String,
    },
    #[serde(rename_all = "camelCase")]
    IceCandidate {
        from: String,
        to: String,
        candidate: Option<IceCandidateInit>,
    },
    #[serde(rename_all = "camelCase")]
    CallRing {
        conversation_id: String,
    },
    #[serde(rename_all = "camelCase")]
    CallDecline {
        conversation_id: String,
    },
    #[serde(rename_all = "camelCase")]
    SetCamera {
        stream_id: Option<String>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        uplink_bps: Option<i64>,
    },
    SetVoiceState {
        muted: bool,
        deafened: bool,
    },
    SetRaisedHand {
        raised: bool,
    },
    /// The idle-seat "still here" press. Carries no fields; the frame itself
    /// is the signal, and the socket it arrived on identifies the seat.
    VoiceStillHere,
    #[serde(rename_all = "camelCase")]
    SetVoiceTrackMode {
        separated: bool,
    },
    #[serde(rename_all = "camelCase")]
    SetMusicListening {
        listening: bool,
    },
    #[serde(rename_all = "camelCase")]
    LiveReaction {
        channel_id: String,
        emoji: LiveReaction,
    },
    /// Watch party state the seat is publishing to the room. `null` ends the
    /// party. `rev` is the room's monotonic revision: a write whose `rev` is
    /// not the room's next is dropped, which is how two hosts pausing at the
    /// same time settle on one answer.
    #[serde(rename_all = "camelCase")]
    SetWatchParty {
        state: Option<WatchPartyState>,
    },
    /// Music queue write. The write shape is deliberately sparse: absent
    /// `skipVotes`/`history` mean "keep what the room holds", and filling them
    /// from the client would wipe a room's votes on the next position sample.
    #[serde(rename_all = "camelCase")]
    SetMusic {
        state: Option<MusicStateWrite>,
    },
    #[serde(rename_all = "camelCase")]
    SoundboardPlay {
        channel_id: String,
        /// Validated against the room's sounds by the server, which also
        /// checks `channelId` against the seat rather than trusting it.
        sound_id: String,
    },
    #[serde(rename_all = "camelCase")]
    WatchLive {
        channel_id: String,
        watching: bool,
    },
}

/// Frames the server sends on the voice socket.
///
/// Partial by design during the port; see the coverage note in the module doc.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum VoiceSignalingMessage {
    #[serde(rename_all = "camelCase")]
    Welcome {
        peer_id: String,
        peers: Vec<VoiceParticipant>,
        voice_channel_id: String,
        /// The joiner's own seat, which may differ from what is in `peers`
        /// (the roster hides what the joiner may not see).
        #[serde(rename = "self")]
        self_participant: VoiceParticipant,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        transport: Option<VoiceRoomTransport>,
        /// False on a cold join. When true the client must not rebuild its
        /// peer connections: the point of resume is keeping the media session.
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        resumed: Option<bool>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        resume_token: Option<String>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        can_speak: Option<bool>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        can_stream: Option<bool>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        can_manage_music: Option<bool>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        can_use_soundboard: Option<bool>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        can_manage_soundboard: Option<bool>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        speak_reason: Option<SpeakReason>,
        audience: Option<VoiceAudienceState>,
    },
    #[serde(rename_all = "camelCase")]
    PeerJoined { peer: VoiceParticipant },
    #[serde(rename_all = "camelCase")]
    PeerUpdated { peer: VoiceParticipant },
    #[serde(rename_all = "camelCase")]
    PeerLeft { peer_id: String },
    #[serde(rename_all = "camelCase")]
    VoiceRoster {
        voice_channel_id: String,
        participants: Vec<VoiceParticipant>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        transport: Option<VoiceRoomTransport>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        seq: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    VoiceRosterDelta {
        voice_channel_id: String,
        /// Apply only when this is the held sequence number plus one; a gap
        /// means the client must fall back to a full roster.
        seq: i64,
        /// Room size once this delta is applied.
        size: i64,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        transport: Option<VoiceRoomTransport>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        joined: Option<Vec<VoiceParticipant>>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        updated: Option<Vec<VoiceParticipant>>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        left: Option<Vec<String>>,
    },
    #[serde(rename_all = "camelCase")]
    VoiceRoomFull {
        voice_channel_id: String,
        limit: i64,
    },
    #[serde(rename_all = "camelCase")]
    VoiceTransportUnsupported {
        voice_channel_id: String,
        transport: VoiceRoomTransport,
        /// Only `promoted` today: the room moved to an the SFU cannot use for
        /// this client, so nobody was told about a join that never happened.
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        reason: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    VoiceTransportChanged {
        voice_channel_id: String,
        transport: VoiceRoomTransport,
        reason: TransportChangeReason,
        /// The room's roster after the change: the media path changed for
        /// everyone, so every client rebuilds against this list.
        participants: Vec<VoiceParticipant>,
    },
    #[serde(rename_all = "camelCase")]
    VoiceJoinRefused {
        voice_channel_id: String,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        reason: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ScreenShareDenied { voice_channel_id: String },
    #[serde(rename_all = "camelCase")]
    CameraDenied { voice_channel_id: String },
    Offer {
        from: String,
        to: String,
        sdp: String,
    },
    Answer {
        from: String,
        to: String,
        sdp: String,
    },
    #[serde(rename_all = "camelCase")]
    IceCandidate {
        from: String,
        to: String,
        candidate: Option<IceCandidateInit>,
    },
    #[serde(rename_all = "camelCase")]
    CallIncoming {
        conversation_id: String,
        kind: CallKind,
        caller: CallerInfo,
    },
    #[serde(rename_all = "camelCase")]
    CallRingCancelled {
        conversation_id: String,
        reason: RingCancelReason,
    },
    #[serde(rename_all = "camelCase")]
    CallDeclined {
        conversation_id: String,
        user_id: String,
    },
    #[serde(rename_all = "camelCase")]
    VoiceModeration {
        action: ModerationAction,
        voice_channel_id: String,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        moved_to_channel_id: Option<String>,
        /// Human-readable copy the client shows. Server-authored and already
        /// localized, so the client renders it verbatim.
        message: String,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        reason: Option<ModerationReason>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        alone_minutes: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    VoiceSpeakChanged {
        voice_channel_id: String,
        can_speak: bool,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        can_stream: Option<bool>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        can_manage_music: Option<bool>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        can_use_soundboard: Option<bool>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        can_manage_soundboard: Option<bool>,
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        speak_reason: Option<SpeakReason>,
    },
    #[serde(rename_all = "camelCase")]
    VoiceIdleWarning {
        voice_channel_id: String,
        disconnect_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    VoiceIdleWarningCancelled { voice_channel_id: String },
    /// Audience mode ("Liberar o microfone") changed, or the media server's
    /// confirmation did. The joiner's own grant travels separately on
    /// `voice-speak-changed`; this is the state everybody draws.
    #[serde(rename_all = "camelCase")]
    VoiceAudience {
        voice_channel_id: String,
        /// `None` means off.
        audience: Option<VoiceAudienceState>,
        /// Only on the frame that announced the change, not on a state sync.
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        change: Option<VoiceAudienceChange>,
    },
    #[serde(rename_all = "camelCase")]
    WatchParty {
        channel_id: String,
        state: Option<WatchPartyState>,
    },
    #[serde(rename_all = "camelCase")]
    Music {
        channel_id: String,
        state: Option<MusicState>,
        /// The server handing back what it holds because the sender's write
        /// was refused. The client adopts it whatever its own `rev` says.
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        forced: Option<bool>,
    },
    /// What a channel is playing, for viewers outside the call.
    #[serde(rename_all = "camelCase")]
    ChannelMusic {
        channel_id: String,
        track: Option<ChannelMusicTrack>,
    },
    /// Coalesced reaction counts for the room. `items` is never empty.
    #[serde(rename_all = "camelCase")]
    LiveReactions {
        channel_id: String,
        items: Vec<LiveReactionCount>,
        seq: i64,
    },
    /// One clip for the room. Not stored.
    #[serde(rename_all = "camelCase")]
    SoundboardPlay {
        channel_id: String,
        sound_id: String,
        user_id: String,
        display_name: String,
        emoji: String,
        played_at: i64,
    },
    /// The room's screen-share egress. Reaches sockets inside the room only.
    #[serde(rename_all = "camelCase")]
    VoiceStream {
        channel_id: String,
        stream: Option<LiveHlsStream>,
    },
    /// The channel-level live path: `voice-stream` does not reach a viewer
    /// without a seat, so the sidebar pill and watch-mode viewers read this.
    #[serde(rename_all = "camelCase")]
    ChannelLive {
        channel_id: String,
        stream: Option<LiveHlsStream>,
        /// Watch-mode viewers without a seat, counted by this process.
        watching: i64,
        /// Distinct accounts counted across every API machine. Shown in place
        /// of `watching` by a client that knows it.
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        viewers: Option<i64>,
        /// With `stream: None`, the server is CERTAIN there is no session. A
        /// client holding a stream must not drop it on a null without this:
        /// an API machine that is not running the egress says null for a party
        /// that is live on another one.
        #[serde(
            default,
            deserialize_with = "strict_option::deserialize",
            skip_serializing_if = "Option::is_none"
        )]
        ended: Option<bool>,
    },
}

/// Watch party playback state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPartyState {
    /// The YouTube video id, or `None` when the party exists with nothing
    /// loaded.
    pub video_id: Option<String>,
    pub status: WatchPartyStatus,
    /// Playback position sampled at `at_ms`.
    pub position_ms: i64,
    /// The sender's clock when `position_ms` was sampled.
    ///
    /// Diagnostic only. Never subtract it from a receiver's clock: mesh
    /// latency is small and bounded, clock offset is neither, and two
    /// consumer machines routinely disagree by tens of seconds.
    pub at_ms: i64,
    /// Room revision. A write that is not the next revision is dropped.
    pub rev: i64,
    pub actor_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchPartyStatus {
    Playing,
    Paused,
    Ended,
}

/// One track in the music queue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrack {
    pub id: String,
    pub provider: MusicProvider,
    pub video_id: String,
    pub title: String,
    pub source_url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub duration_ms: Option<i64>,
    pub added_by_user_id: String,
    pub added_by_name: String,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub autoplayed: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MusicProvider {
    Youtube,
}

/// What a client may write to the room's music state.
///
/// `skip_votes`, `history`, `open_controls`, `repeat` and `autoplay` are
/// optional here in a way the read state is not: absent means "unchanged", so
/// a position sample that omits them does not wipe a room's votes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicStateWrite {
    pub current: Option<MusicTrack>,
    pub queue: Vec<MusicTrack>,
    pub status: MusicStatus,
    pub position_ms: i64,
    pub at_ms: i64,
    pub rev: i64,
    pub actor_id: String,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub open_controls: Option<bool>,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub repeat: Option<MusicRepeat>,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub skip_votes: Option<Vec<String>>,
    /// Most recent first.
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub history: Option<Vec<MusicTrack>>,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub autoplay: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MusicStatus {
    Playing,
    Paused,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MusicRepeat {
    /// The Zod default, and therefore the serde default for a read state.
    #[default]
    Off,
    One,
    All,
}

/// What the room holds as its music state, as the server sends it.
///
/// This is the **read** form and it is not [`MusicStateWrite`]: here
/// `open_controls`, `repeat`, `skip_votes` and `history` carry Zod defaults,
/// so they are plain fields that always serialize, while in the write form the
/// same names are absent-means-unchanged and must not be filled. Confusing the
/// two would let a position sample wipe a room's skip votes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicState {
    /// `None` beside a non-empty queue is a transient the next write fixes.
    pub current: Option<MusicTrack>,
    pub queue: Vec<MusicTrack>,
    pub status: MusicStatus,
    pub position_ms: i64,
    pub at_ms: i64,
    /// Logical clock. Higher wins; ties break on `actor_id`.
    pub rev: i64,
    pub actor_id: String,
    /// While true, anyone who may speak is treated as a manager.
    #[serde(default)]
    pub open_controls: bool,
    #[serde(default)]
    pub repeat: MusicRepeat,
    /// User ids that have voted to skip the current track.
    #[serde(default)]
    pub skip_votes: Vec<String>,
    /// Most recent first.
    #[serde(default)]
    pub history: Vec<MusicTrack>,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub autoplay: Option<bool>,
}

/// The sidebar's copy of the current track: enough to say what is playing,
/// with no queue, position or votes to keep in step. Note this is a different
/// shape from [`MusicTrack`], so `channel-music` cannot reuse it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMusicTrack {
    pub video_id: String,
    pub title: String,
    pub thumbnail_url: Option<String>,
    /// Seated peers whose player is on. Absent on an older server.
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub listeners: Option<i64>,
}

/// How the egress is packaged. Absent means a server that predates the
/// low-latency ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveHlsMode {
    Conventional,
    Ll,
}

/// A running screen-share HLS session.
///
/// Every field after `presenter_peer_id` is optional because it was added
/// later and iOS, Android and older web clients still parse this frame: the
/// port must not invent a value for a field the sender left out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveHlsStream {
    /// Either a full public URL or an API-relative path the client prefixes
    /// with its own API base.
    pub hls_url: String,
    pub started_at: i64,
    pub presenter_peer_id: String,
    /// The presenting **person**, beside the peer id. A session outlives the
    /// socket that started it, so for a window after a presenter reloads the
    /// two name different ids.
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub presenter_user_id: Option<String>,
    /// What the latency badge should claim.
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub delay_seconds: Option<i64>,
    /// The tallest rendition this session actually started, in lines.
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub top_height: Option<i64>,
    /// Highest framerate a started rung actually encodes.
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub top_framerate: Option<i64>,
    /// Whether this transcode has any audio at all.
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub has_audio: Option<bool>,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub camera_hls_url: Option<String>,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub camera_has_video: Option<bool>,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub camera_has_voice_audio: Option<bool>,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub mode: Option<LiveHlsMode>,
    #[serde(
        default,
        deserialize_with = "strict_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub part_target_ms: Option<i64>,
}
