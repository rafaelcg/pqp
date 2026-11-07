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
//! `PROTO_COVERAGE` in the fixture names which server message types are not
//! ported yet. The test fails on any type the schema carries that is neither
//! ported nor listed there, so growing the protocol forces an explicit
//! decision instead of a silent gap.

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MusicRepeat {
    Off,
    One,
    All,
}
