//! What the window draws, written by the network side and read by the UI.
//! One mutex, one "something changed" channel; the UI redraws on a ping.

use crate::wire::Rosters;
use futures::channel::mpsc::UnboundedSender;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Debug, Clone)]
pub struct Channel {
    pub id: String,
    pub name: String,
    /// `text`, `voice`, `watch_party`, ...
    pub kind: String,
}

#[derive(Debug, Clone)]
pub struct Msg {
    pub author: String,
    pub time: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SocketState {
    Connecting,
    Ready,
    Closed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum CallPhase {
    Idle,
    /// `join-voice-room` sent, waiting for `welcome`.
    Joining,
    /// Seated on the socket, connecting to the SFU.
    Connecting,
    Connected,
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct CallView {
    pub phase: CallPhase,
    pub voice_channel_id: Option<String>,
    pub muted: bool,
    pub deafened: bool,
    /// Peer ids the SFU currently reports as speaking (LiveKit identities are
    /// pqp peer ids).
    pub speaking: BTreeSet<String>,
    /// Peak level of the other people's audio over the last second, dBFS.
    pub remote_level_dbfs: f32,
    /// Loudest one-second window since joining, dBFS.
    pub remote_peak_dbfs: f32,
    /// One-second windows whose peak was above -60 dBFS.
    pub remote_audible_seconds: u64,
}

impl Default for CallView {
    fn default() -> Self {
        Self {
            phase: CallPhase::Idle,
            voice_channel_id: None,
            muted: false,
            deafened: false,
            speaking: BTreeSet::new(),
            remote_level_dbfs: f32::NEG_INFINITY,
            remote_peak_dbfs: f32::NEG_INFINITY,
            remote_audible_seconds: 0,
        }
    }
}

#[derive(Debug)]
pub struct AppState {
    pub server_name: String,
    pub channels: Vec<Channel>,
    pub text_channel_id: Option<String>,
    pub messages: Vec<Msg>,
    pub socket: SocketState,
    pub rosters: Rosters,
    pub call: CallView,
    pub error: Option<String>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            server_name: String::new(),
            channels: Vec::new(),
            text_channel_id: None,
            messages: Vec::new(),
            socket: SocketState::Connecting,
            rosters: Rosters::default(),
            call: CallView::default(),
            error: None,
        }
    }
}

/// The state plus the ping that tells the window to redraw.
#[derive(Clone)]
pub struct Shared {
    inner: Arc<Mutex<AppState>>,
    changed: UnboundedSender<()>,
}

impl Shared {
    pub fn new(changed: UnboundedSender<()>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(AppState::default())),
            changed,
        }
    }

    pub fn read(&self) -> MutexGuard<'_, AppState> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Mutate, then ping the window.
    pub fn update<R>(&self, f: impl FnOnce(&mut AppState) -> R) -> R {
        let r = f(&mut self.read());
        let _ = self.changed.unbounded_send(());
        r
    }
}

/// One line on stdout for the bench driver (`tools/desktop-bench/native-bench.mjs`).
pub fn bench_line(tag: &str, rest: impl std::fmt::Display) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{tag} {rest}");
    let _ = out.flush();
}
