//! The voice socket frames this prototype reads and sends, and the roster it
//! builds from them. The shipped zod schemas in `packages/shared/src/signaling.ts`
//! are the only source of truth; `tests/wire_fixtures.rs` replays the A1 vectors
//! in `packages/shared/fixtures/wire/` against these types, so a frame that
//! changes shape fails a test here instead of drifting silently.
//!
//! This is the prototype's own socket code (plan step D2 starts "with the
//! spike's own socket code"). D1 replaces it with `pqp-client-core`.
//!
//! Only the fields the prototype uses are modeled. A field the server sends and
//! this file does not name is ignored by serde; the fixture test checks that
//! every field that IS named reads exactly what zod's canonical parse reads
//! (defaults applied, absent nullable as null).
//!
//! Value rules (`guid`, `minLen`, `safeint` ...) are NOT enforced on received
//! frames: that is the core's job in C1 ("value rules stay data, loaded
//! fail-closed"). Enum rules are, because they are serde enums here. The test
//! pins exactly which rule kinds get through, so the gap is written down.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// What the prototype declares in `join-voice-room.transports`. Only the SFU:
/// the server refuses it in a mesh room, as the plan designs it.
pub const TRANSPORTS: &[Transport] = &[Transport::Livekit];

/// Optional wire features this build understands (`auth.caps`). Deliberately
/// none of the web client's: no `voice-roster-delta` (full rosters are simpler
/// and still correct), no `presence-delta`, no `mesh-resume` (no mesh at all),
/// no `sfu-region` (only the local single-region stack is supported). Adding a
/// cap is a promise; this prototype makes none it cannot keep.
pub const CAPS: &[&str] = &[];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Mesh,
    Livekit,
}

/// Frames the prototype sends.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientFrame {
    /// Not part of the voice union (the server hand-parses it, `ws/index.ts`).
    Auth {
        token: String,
        caps: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    JoinVoiceRoom {
        voice_channel_id: String,
        transports: Vec<Transport>,
    },
    LeaveVoiceRoom {},
    SetVoiceState {
        muted: bool,
        deafened: bool,
    },
}

impl ClientFrame {
    pub fn auth(token: &str) -> Self {
        ClientFrame::Auth {
            token: token.to_string(),
            caps: CAPS.iter().map(|c| c.to_string()).collect(),
        }
    }

    pub fn join(voice_channel_id: &str) -> Self {
        ClientFrame::JoinVoiceRoom {
            voice_channel_id: voice_channel_id.to_string(),
            transports: TRANSPORTS.to_vec(),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("a client frame always serialises")
    }
}

/// One person in a voice room (`voiceParticipantSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub peer_id: String,
    pub user_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub sharing_screen: bool,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub deafened: bool,
    #[serde(default)]
    pub server_muted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_speak: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModerationAction {
    Disconnected,
    Moved,
    Muted,
    Unmuted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JoinRefusedReason {
    MeshMultiInstance,
}

/// Frames the prototype reads. Every other `type` (chat, presence, music...)
/// lands in `Other` and is ignored; a frame whose `type` is one of these but
/// whose body does not decode is an error, never `Other`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerFrame {
    /// After `auth` succeeds. Not part of the voice union.
    Ready,
    #[serde(rename_all = "camelCase")]
    Welcome {
        peer_id: String,
        peers: Vec<Participant>,
        voice_channel_id: String,
        transport: Transport,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_token: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        can_speak: Option<bool>,
    },
    PeerJoined {
        peer: Participant,
    },
    PeerUpdated {
        peer: Participant,
    },
    #[serde(rename_all = "camelCase")]
    PeerLeft {
        peer_id: String,
    },
    #[serde(rename_all = "camelCase")]
    VoiceRoster {
        voice_channel_id: String,
        participants: Vec<Participant>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transport: Option<Transport>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seq: Option<u64>,
    },
    /// Never sent to this prototype (it does not declare the cap), modeled so
    /// a server that sends one anyway is still read correctly.
    #[serde(rename_all = "camelCase")]
    VoiceRosterDelta {
        voice_channel_id: String,
        seq: u64,
        size: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transport: Option<Transport>,
        joined: Vec<Participant>,
        updated: Vec<Participant>,
        left: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    VoiceRoomFull {
        voice_channel_id: String,
        limit: u64,
    },
    #[serde(rename_all = "camelCase")]
    VoiceTransportUnsupported {
        voice_channel_id: String,
        transport: Transport,
    },
    #[serde(rename_all = "camelCase")]
    VoiceJoinRefused {
        voice_channel_id: String,
        reason: JoinRefusedReason,
    },
    #[serde(rename_all = "camelCase")]
    VoiceTransportChanged {
        voice_channel_id: String,
        transport: Transport,
        participants: Vec<Participant>,
    },
    #[serde(rename_all = "camelCase")]
    VoiceModeration {
        action: ModerationAction,
        voice_channel_id: String,
    },
    #[serde(other)]
    Other,
}

impl ServerFrame {
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }
}

/// Every voice room the socket has heard about, and which one is ours.
#[derive(Debug, Default, Clone)]
pub struct Rosters {
    /// voice channel id -> peer id -> participant
    pub rooms: BTreeMap<String, BTreeMap<String, Participant>>,
    /// The room this socket is seated in, and its own peer id.
    pub seat: Option<Seat>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Seat {
    pub voice_channel_id: String,
    pub peer_id: String,
    pub transport: Transport,
    pub resume_token: Option<String>,
}

/// What a frame means for the call, beyond the roster.
#[derive(Debug, Clone, PartialEq)]
pub enum RosterEffect {
    None,
    /// `welcome`: seated. The SFU token can be minted now.
    Seated(Seat),
    /// The server will not seat this client in that room, and why.
    Refused(String),
    /// The server removed this client from the room (moderation).
    Removed(String),
}

impl Rosters {
    fn room(&mut self, id: &str) -> &mut BTreeMap<String, Participant> {
        self.rooms.entry(id.to_string()).or_default()
    }

    fn room_of_peer(&self, peer_id: &str) -> Option<String> {
        if let Some(seat) = &self.seat
            && self
                .rooms
                .get(&seat.voice_channel_id)
                .is_some_and(|r| r.contains_key(peer_id))
        {
            return Some(seat.voice_channel_id.clone());
        }
        self.rooms
            .iter()
            .find(|(_, r)| r.contains_key(peer_id))
            .map(|(id, _)| id.clone())
    }

    /// Fold one frame in. Pure: no I/O, no clock.
    pub fn apply(&mut self, frame: &ServerFrame) -> RosterEffect {
        match frame {
            ServerFrame::Welcome {
                peer_id,
                peers,
                voice_channel_id,
                transport,
                resume_token,
                ..
            } => {
                let room = self.room(voice_channel_id);
                room.clear();
                for p in peers {
                    room.insert(p.peer_id.clone(), p.clone());
                }
                let seat = Seat {
                    voice_channel_id: voice_channel_id.clone(),
                    peer_id: peer_id.clone(),
                    transport: *transport,
                    resume_token: resume_token.clone(),
                };
                self.seat = Some(seat.clone());
                RosterEffect::Seated(seat)
            }
            ServerFrame::PeerJoined { peer } | ServerFrame::PeerUpdated { peer } => {
                // These carry no channel id: they are about the room we sit in.
                if let Some(seat) = self.seat.clone() {
                    self.room(&seat.voice_channel_id)
                        .insert(peer.peer_id.clone(), peer.clone());
                }
                RosterEffect::None
            }
            ServerFrame::PeerLeft { peer_id } => {
                if let Some(room) = self.room_of_peer(peer_id) {
                    self.room(&room).remove(peer_id);
                }
                RosterEffect::None
            }
            ServerFrame::VoiceRoster {
                voice_channel_id,
                participants,
                ..
            } => {
                let room = self.room(voice_channel_id);
                room.clear();
                for p in participants {
                    room.insert(p.peer_id.clone(), p.clone());
                }
                RosterEffect::None
            }
            ServerFrame::VoiceTransportChanged {
                voice_channel_id,
                transport,
                participants,
            } => {
                let room = self.room(voice_channel_id);
                room.clear();
                for p in participants {
                    room.insert(p.peer_id.clone(), p.clone());
                }
                // Our room moved: the seat follows. This client only has the
                // SFU path, so a move to anything else ends its call.
                if let Some(seat) = self.seat.as_mut()
                    && &seat.voice_channel_id == voice_channel_id
                {
                    seat.transport = *transport;
                    if *transport != Transport::Livekit {
                        self.leave();
                        return RosterEffect::Refused(format!(
                            "the room moved to {transport:?}, this client only speaks livekit"
                        ));
                    }
                }
                RosterEffect::None
            }
            ServerFrame::VoiceRosterDelta {
                voice_channel_id,
                joined,
                updated,
                left,
                ..
            } => {
                let room = self.room(voice_channel_id);
                for p in joined.iter().chain(updated) {
                    room.insert(p.peer_id.clone(), p.clone());
                }
                for id in left {
                    room.remove(id);
                }
                RosterEffect::None
            }
            ServerFrame::VoiceRoomFull { limit, .. } => {
                RosterEffect::Refused(format!("room full ({limit})"))
            }
            ServerFrame::VoiceTransportUnsupported { transport, .. } => RosterEffect::Refused(
                format!("the room runs {transport:?}, this client only speaks livekit"),
            ),
            ServerFrame::VoiceJoinRefused { reason, .. } => {
                RosterEffect::Refused(format!("join refused: {reason:?}"))
            }
            ServerFrame::VoiceModeration {
                action: action @ (ModerationAction::Disconnected | ModerationAction::Moved),
                voice_channel_id,
            } if self
                .seat
                .as_ref()
                .is_some_and(|s| &s.voice_channel_id == voice_channel_id) =>
            {
                self.leave();
                RosterEffect::Removed(format!("{action:?}"))
            }
            _ => RosterEffect::None,
        }
    }

    /// Our own row, as the server last described it.
    pub fn me(&self) -> Option<&Participant> {
        let seat = self.seat.as_ref()?;
        self.rooms.get(&seat.voice_channel_id)?.get(&seat.peer_id)
    }

    pub fn leave(&mut self) {
        if let Some(seat) = self.seat.take()
            && let Some(room) = self.rooms.get_mut(&seat.voice_channel_id)
        {
            room.remove(&seat.peer_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: &str, name: &str) -> Participant {
        Participant {
            peer_id: id.into(),
            user_id: "11111111-1111-4111-8111-111111111111".into(),
            display_name: name.into(),
            avatar_url: None,
            sharing_screen: false,
            muted: false,
            deafened: false,
            server_muted: false,
            can_speak: None,
        }
    }

    #[test]
    fn join_declares_only_livekit() {
        let json = ClientFrame::join("c").to_json();
        assert_eq!(
            json,
            r#"{"type":"join-voice-room","voiceChannelId":"c","transports":["livekit"]}"#
        );
    }

    #[test]
    fn welcome_seats_and_peer_frames_follow() {
        let mut r = Rosters::default();
        let eff = r.apply(&ServerFrame::Welcome {
            peer_id: "a".into(),
            peers: vec![p("a", "me"), p("b", "bob")],
            voice_channel_id: "room".into(),
            transport: Transport::Livekit,
            resume_token: Some("t".into()),
            can_speak: Some(true),
        });
        assert!(matches!(eff, RosterEffect::Seated(_)));
        let mut muted = p("a", "me");
        muted.muted = true;
        r.apply(&ServerFrame::PeerUpdated { peer: muted });
        assert!(r.me().unwrap().muted);
        r.apply(&ServerFrame::PeerLeft {
            peer_id: "b".into(),
        });
        assert_eq!(r.rooms["room"].len(), 1);
        r.leave();
        assert!(r.me().is_none());
        assert!(r.rooms["room"].is_empty());
    }

    #[test]
    fn a_transport_change_away_from_the_sfu_ends_the_seat() {
        let mut r = Rosters::default();
        r.apply(&ServerFrame::Welcome {
            peer_id: "a".into(),
            peers: vec![p("a", "me")],
            voice_channel_id: "room".into(),
            transport: Transport::Livekit,
            resume_token: None,
            can_speak: None,
        });
        let eff = r.apply(&ServerFrame::VoiceTransportChanged {
            voice_channel_id: "room".into(),
            transport: Transport::Mesh,
            participants: vec![p("a", "me")],
        });
        assert!(matches!(eff, RosterEffect::Refused(_)));
        assert!(r.seat.is_none());
    }

    #[test]
    fn unknown_types_are_other_but_a_bad_known_frame_is_an_error() {
        assert_eq!(
            ServerFrame::parse(r#"{"type":"presence","x":1}"#).unwrap(),
            ServerFrame::Other
        );
        assert!(ServerFrame::parse(r#"{"type":"peer-left"}"#).is_err());
        assert!(ServerFrame::parse(r#"{"type":"welcome","peerId":"a"}"#).is_err());
    }
}
