//! The network side, on one tokio runtime: the HTTP reads at boot, the `/ws`
//! socket (auth, rosters, join and leave, mute and deafen), and the call.
//! Commands come from the window and from stdin (the bench driver).

use crate::call::Call;
use crate::state::{CallPhase, Channel, Msg, Shared, SocketState, bench_line};
use crate::wire::{ClientFrame, RosterEffect, ServerFrame, Transport};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message as WsMessage;

#[derive(Debug, Clone)]
pub struct Config {
    pub api_url: String,
    pub ws_url: String,
    pub token: String,
    pub server_name: String,
    pub text_channel: String,
}

#[derive(Debug, Clone)]
pub enum Command {
    /// Join a voice channel, by name or id.
    Join(String),
    Leave,
    Mute(bool),
    Deafen(bool),
    Status,
    Quit,
}

impl Command {
    pub fn parse(line: &str) -> Option<Command> {
        let mut parts = line.split_whitespace();
        Some(match parts.next()? {
            "join" => Command::Join(parts.next().unwrap_or("Lobby").to_string()),
            "leave" => Command::Leave,
            "mute" => Command::Mute(true),
            "unmute" => Command::Mute(false),
            "deafen" => Command::Deafen(true),
            "undeafen" => Command::Deafen(false),
            "status" => Command::Status,
            "quit" => Command::Quit,
            _ => return None,
        })
    }
}

#[derive(Deserialize)]
struct ServersResponse {
    servers: Vec<ApiServer>,
}
#[derive(Deserialize)]
struct ApiServer {
    id: String,
    name: String,
}
#[derive(Deserialize)]
struct ChannelsResponse {
    channels: Vec<ApiChannel>,
}
#[derive(Deserialize)]
struct ApiChannel {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
}
#[derive(Deserialize)]
struct MessagesResponse {
    messages: Vec<ApiMessage>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiMessage {
    author_name: String,
    body: String,
    created_at: String,
}
/// `voiceSessionSchema` (packages/shared/src/voice-backend.ts).
#[derive(Deserialize)]
struct VoiceSession {
    url: String,
    token: String,
    speak: Option<bool>,
}

struct Http {
    client: reqwest::Client,
    base: String,
    token: String,
}

impl Http {
    async fn get<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, String> {
        let r = self
            .client
            .get(format!("{}{}", self.base, path))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| format!("GET {path}: {e}"))?;
        if !r.status().is_success() {
            return Err(format!("GET {path}: HTTP {}", r.status()));
        }
        r.json().await.map_err(|e| format!("GET {path}: {e}"))
    }

    async fn post<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<T, String> {
        let r = self
            .client
            .post(format!("{}{}", self.base, path))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("POST {path}: {e}"))?;
        if !r.status().is_success() {
            return Err(format!("POST {path}: HTTP {}", r.status()));
        }
        r.json().await.map_err(|e| format!("POST {path}: {e}"))
    }
}

/// Boot reads: the hall, its channels, the latest page of one text channel.
async fn boot(http: &Http, cfg: &Config, shared: &Shared) -> Result<(), String> {
    let servers: ServersResponse = http.get("/api/servers").await?;
    let server = servers
        .servers
        .into_iter()
        .find(|s| s.name == cfg.server_name)
        .ok_or_else(|| format!("no server named {}", cfg.server_name))?;
    let channels: ChannelsResponse = http
        .get(&format!("/api/servers/{}/channels", server.id))
        .await?;
    let text = channels
        .channels
        .iter()
        .find(|c| c.kind == "text" && c.name == cfg.text_channel)
        .or_else(|| channels.channels.iter().find(|c| c.kind == "text"))
        .map(|c| c.id.clone())
        .ok_or("no text channel")?;
    let page: MessagesResponse = http
        .get(&format!("/api/channels/{text}/messages?limit=50"))
        .await?;
    let mut messages: Vec<(String, Msg)> = page
        .messages
        .into_iter()
        .map(|m| {
            let time = m.created_at.get(11..16).unwrap_or("").to_string();
            (
                m.created_at,
                Msg {
                    author: m.author_name,
                    time,
                    body: m.body,
                },
            )
        })
        .collect();
    messages.sort_by(|a, b| a.0.cmp(&b.0));
    shared.update(|s| {
        s.server_name = server.name;
        s.channels = channels
            .channels
            .into_iter()
            .map(|c| Channel {
                id: c.id,
                name: c.name,
                kind: c.kind,
            })
            .collect();
        s.text_channel_id = Some(text);
        s.messages = messages.into_iter().map(|(_, m)| m).collect();
    });
    Ok(())
}

type WsSink = futures::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    WsMessage,
>;

struct Session {
    sink: Option<WsSink>,
    /// `ready` received on the current socket.
    ready: bool,
    call: Option<Call>,
    /// The voice channel the user asked for, kept across a socket reconnect.
    wanted_room: Option<String>,
    /// A write failed: the socket is dead even if no read has said so yet.
    broken: bool,
}

impl Session {
    /// Write a frame. A failed write marks the socket broken, and the read
    /// loop reconnects (and rejoins `wanted_room`) instead of carrying on as
    /// if the server had the frame.
    async fn send(&mut self, frame: ClientFrame) {
        if let Some(sink) = self.sink.as_mut()
            && sink.send(WsMessage::text(frame.to_json())).await.is_err()
        {
            self.broken = true;
        }
    }
}

/// Wait out a reconnect delay while still obeying commands (a `quit` must not
/// queue behind retries). Returns false when the caller should stop.
async fn wait_obeying(
    delay: Duration,
    commands: &mut UnboundedReceiver<Command>,
    session: &mut Session,
    shared: &Shared,
) -> bool {
    let sleep = tokio::time::sleep(delay);
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            _ = &mut sleep => return true,
            cmd = commands.recv() => {
                let Some(cmd) = cmd else { return false };
                if !handle_command(cmd, session, shared).await {
                    return false;
                }
            }
        }
    }
}

fn status_json(shared: &Shared, session: &Session) -> serde_json::Value {
    let s = shared.read();
    let me = s.rosters.me().cloned();
    let room = s
        .call
        .voice_channel_id
        .as_ref()
        .and_then(|id| s.rosters.rooms.get(id))
        .map(|r| r.values().map(|p| json!({"peerId": p.peer_id, "name": p.display_name, "muted": p.muted, "deafened": p.deafened})).collect::<Vec<_>>())
        .unwrap_or_default();
    json!({
        "socket": format!("{:?}", s.socket),
        "phase": format!("{:?}", s.call.phase),
        "muted": s.call.muted,
        "deafened": s.call.deafened,
        "micPublished": session.call.as_ref().is_some_and(|c| c.mic_published()),
        "remoteLevelDbfs": if s.call.remote_level_dbfs.is_finite() { json!((s.call.remote_level_dbfs * 10.0).round() / 10.0) } else { json!(null) },
        "remotePeakDbfs": if s.call.remote_peak_dbfs.is_finite() { json!((s.call.remote_peak_dbfs * 10.0).round() / 10.0) } else { json!(null) },
        "remoteAudibleSeconds": s.call.remote_audible_seconds,
        "remoteFramesIn": session.call.as_ref().map(|c| c.frames_in.load(std::sync::atomic::Ordering::Relaxed)).unwrap_or(0),
        "speaking": s.call.speaking.iter().collect::<Vec<_>>(),
        "self": me.map(|p| json!({"peerId": p.peer_id, "muted": p.muted, "deafened": p.deafened})),
        "roster": room,
        "messages": s.messages.len(),
        "channels": s.channels.len(),
    })
}

fn resolve_voice(shared: &Shared, key: &str) -> Option<String> {
    let s = shared.read();
    s.channels
        .iter()
        .find(|c| c.kind == "voice" && (c.id == key || c.name.eq_ignore_ascii_case(key)))
        .map(|c| c.id.clone())
}

async fn leave_call(session: &mut Session, shared: &Shared) {
    if let Some(call) = session.call.take() {
        call.close().await;
    }
    shared.update(|s| {
        s.rosters.leave();
        s.call = Default::default();
    });
}

async fn handle_command(cmd: Command, session: &mut Session, shared: &Shared) -> bool {
    match cmd {
        Command::Join(key) => {
            let Some(id) = resolve_voice(shared, &key) else {
                bench_line("ERROR", format!("no voice channel {key}"));
                return true;
            };
            if session.call.is_some() || shared.read().rosters.seat.is_some() {
                session.send(ClientFrame::LeaveVoiceRoom {}).await;
                leave_call(session, shared).await;
            }
            session.wanted_room = Some(id.clone());
            shared.update(|s| {
                s.call.phase = CallPhase::Joining;
                s.call.voice_channel_id = Some(id.clone());
            });
            // Before `ready` the join waits; the Ready handler sends it.
            if session.ready {
                session.send(ClientFrame::join(&id)).await;
            }
        }
        Command::Leave => {
            session.wanted_room = None;
            session.send(ClientFrame::LeaveVoiceRoom {}).await;
            leave_call(session, shared).await;
        }
        Command::Mute(muted) => {
            let deafened = shared.update(|s| {
                s.call.muted = muted;
                s.call.deafened
            });
            if let Some(c) = &session.call {
                c.set_muted(muted || deafened);
            }
            session
                .send(ClientFrame::SetVoiceState { muted, deafened })
                .await;
        }
        Command::Deafen(deafened) => {
            let muted = shared.update(|s| {
                s.call.deafened = deafened;
                s.call.muted
            });
            if let Some(c) = &session.call {
                c.set_deafened(deafened);
                c.set_muted(muted || deafened);
            }
            session
                .send(ClientFrame::SetVoiceState { muted, deafened })
                .await;
        }
        Command::Status => bench_line("STATUS", status_json(shared, session)),
        Command::Quit => {
            session.send(ClientFrame::LeaveVoiceRoom {}).await;
            leave_call(session, shared).await;
            return false;
        }
    }
    true
}

/// What happened to the call after a frame.
async fn on_seated(http: &Http, shared: &Shared, seat: crate::wire::Seat) -> Result<Call, String> {
    if seat.transport != Transport::Livekit {
        return Err("seated in a mesh room; this client only speaks livekit".into());
    }
    bench_line(
        "SEATED",
        json!({"peerId": seat.peer_id, "voiceChannelId": seat.voice_channel_id}),
    );
    let mut body = json!({"voiceChannelId": seat.voice_channel_id, "peerId": seat.peer_id});
    if let Some(t) = &seat.resume_token {
        body["resumeToken"] = json!(t);
    }
    let session: VoiceSession = http.post("/api/voice/token", body).await?;
    Call::connect(
        &session.url,
        &session.token,
        session.speak.unwrap_or(true),
        shared.clone(),
    )
    .await
}

pub async fn run(
    cfg: Config,
    shared: Shared,
    mut commands: UnboundedReceiver<Command>,
    self_tx: UnboundedSender<Command>,
) {
    let http = Http {
        client: reqwest::Client::new(),
        base: cfg.api_url.clone(),
        token: cfg.token.clone(),
    };
    if let Err(e) = boot(&http, &cfg, &shared).await {
        bench_line("ERROR", format!("boot: {e}"));
        shared.update(|s| s.error = Some(e));
    }
    let _ = self_tx; // kept so the command channel never closes under us

    let mut session = Session {
        sink: None,
        ready: false,
        call: None,
        wanted_room: None,
        broken: false,
    };
    let mut backoff = Duration::from_millis(500);
    let mut announced_ready = false;
    'reconnect: loop {
        shared.update(|s| s.socket = SocketState::Connecting);
        let connect = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::connect_async(cfg.ws_url.as_str()),
        );
        let ws = match connect.await {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(e)) => {
                shared.update(|s| s.socket = SocketState::Closed(e.to_string()));
                if !wait_obeying(backoff, &mut commands, &mut session, &shared).await {
                    break 'reconnect;
                }
                backoff = (backoff * 2).min(Duration::from_secs(10));
                continue;
            }
            Err(_) => {
                shared.update(|s| s.socket = SocketState::Closed("connect timed out".into()));
                if !wait_obeying(backoff, &mut commands, &mut session, &shared).await {
                    break 'reconnect;
                }
                backoff = (backoff * 2).min(Duration::from_secs(10));
                continue;
            }
        };
        let (sink, mut stream) = ws.split();
        session.sink = Some(sink);
        session.broken = false;
        session.send(ClientFrame::auth(&cfg.token)).await;

        while !session.broken {
            tokio::select! {
                msg = stream.next() => {
                    let text = match msg {
                        Some(Ok(WsMessage::Text(t))) => t,
                        Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                        Some(Ok(_)) => continue, // pings are answered by tungstenite
                    };
                    let frame = match ServerFrame::parse(text.as_str()) {
                        Ok(f) => f,
                        Err(e) => {
                            bench_line("ERROR", format!("undecodable frame: {e}"));
                            continue;
                        }
                    };
                    if frame == ServerFrame::Ready {
                        backoff = Duration::from_millis(500);
                        shared.update(|s| s.socket = SocketState::Ready);
                        if !announced_ready {
                            announced_ready = true;
                            bench_line("READY", "");
                        }
                        session.ready = true;
                        // The boot reads failed earlier (the API was down):
                        // the API answers now, so read again.
                        if shared.read().channels.is_empty() {
                            match boot(&http, &cfg, &shared).await {
                                Ok(()) => shared.update(|s| s.error = None),
                                Err(e) => bench_line("ERROR", format!("boot: {e}")),
                            }
                        }
                        // A join asked for before `ready`, or a call the last
                        // socket dropped: (re)join as a new seat. No resume:
                        // the prototype keeps no media across a reconnect.
                        if let Some(room) = session.wanted_room.clone() {
                            shared.update(|s| { s.call.phase = CallPhase::Joining; s.call.voice_channel_id = Some(room.clone()); });
                            session.send(ClientFrame::join(&room)).await;
                        }
                        continue;
                    }
                    let effect = shared.update(|s| s.rosters.apply(&frame));
                    match effect {
                        RosterEffect::Seated(seat) => {
                            if let Some(old) = session.call.take() { old.close().await; }
                            shared.update(|s| s.call.phase = CallPhase::Connecting);
                            match on_seated(&http, &shared, seat).await {
                                Ok(call) => {
                                    let (muted, deafened) = { let s = shared.read(); (s.call.muted, s.call.deafened) };
                                    call.set_muted(muted || deafened);
                                    call.set_deafened(deafened);
                                    let published = call.mic_published();
                                    session.call = Some(call);
                                    shared.update(|s| s.call.phase = CallPhase::Connected);
                                    bench_line("IN_CALL", json!({"micPublished": published}));
                                }
                                Err(e) => {
                                    bench_line("ERROR", format!("call: {e}"));
                                    session.send(ClientFrame::LeaveVoiceRoom {}).await;
                                    shared.update(|s| { s.rosters.leave(); s.call.phase = CallPhase::Failed(e); });
                                }
                            }
                        }
                        RosterEffect::Refused(why) | RosterEffect::Removed(why) => {
                            bench_line("ERROR", format!("voice: {why}"));
                            session.wanted_room = None;
                            if let Some(call) = session.call.take() { call.close().await; }
                            shared.update(|s| s.call.phase = CallPhase::Failed(why));
                        }
                        RosterEffect::None => {}
                    }
                }
                cmd = commands.recv() => {
                    let Some(cmd) = cmd else { break 'reconnect };
                    if !handle_command(cmd, &mut session, &shared).await {
                        break 'reconnect;
                    }
                }
            }
        }
        session.sink = None;
        session.ready = false;
        // The seat went with the socket; the media goes too, and the Ready
        // handler rejoins if the user still wants the room.
        if let Some(call) = session.call.take() {
            call.close().await;
        }
        let rejoin = session.wanted_room.clone();
        shared.update(|s| {
            s.rosters.leave();
            s.socket = SocketState::Closed("socket closed".into());
            // No media is up any more: say so, and keep the room the user
            // wants so the next `ready` rejoins it.
            let keep = (s.call.muted, s.call.deafened);
            s.call = Default::default();
            (s.call.muted, s.call.deafened) = keep;
            if let Some(room) = rejoin {
                s.call.phase = CallPhase::Joining;
                s.call.voice_channel_id = Some(room);
            }
        });
        if !wait_obeying(backoff, &mut commands, &mut session, &shared).await {
            break 'reconnect;
        }
        backoff = (backoff * 2).min(Duration::from_secs(10));
    }
    if let Some(mut sink) = session.sink.take() {
        let _ = sink.close().await;
    }
    bench_line("BYE", "");
    std::process::exit(0);
}
