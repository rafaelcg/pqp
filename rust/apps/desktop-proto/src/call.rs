//! The SFU half of a call, on the LiveKit Rust SDK (the media engine Zed ships).
//!
//! Playout is WebRTC's own platform audio device module (CoreAudio on macOS,
//! through `PlatformAudio`), the same engine Chromium plays remote audio with.
//!
//! The microphone is SYNTHETIC by default, and published as a microphone: a
//! macOS microphone grant cannot be given unattended, so (like the Electron
//! bench's fake capture device) the published track is a generated beep pushed
//! into a `NativeAudioSource`, with WebRTC's echo canceller, noise suppressor
//! and gain control on, as the web client asks the browser for. It is published
//! with `TrackSource::Microphone`: the publish grant is an allowlist of sources
//! and an untagged track is refused (CLAUDE.md, pitfall 14). ADM recording is
//! switched off so nothing opens the real microphone. `PQP_REAL_MIC=1` publishes
//! the platform microphone instead (needs the grant; not used by the bench).

use crate::state::{CallPhase, Shared, bench_line};
use futures::StreamExt;
use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::rtc_engine::lk_runtime::LkRuntime;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::peer_connection_factory::native::PeerConnectionFactoryExt;
use livekit::webrtc::prelude::AudioFrame;
use livekit::PlatformAudio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::task::JoinHandle;

const SAMPLE_RATE: u32 = 48_000;
const FRAME: usize = (SAMPLE_RATE / 100) as usize; // 10 ms

pub struct Call {
    room: Arc<Room>,
    mic: Option<LocalTrackPublication>,
    tasks: Vec<JoinHandle<()>>,
    _audio: PlatformAudio,
    pub frames_in: Arc<AtomicU64>,
}

impl Drop for Call {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

/// The local beep: 440 Hz at about -20 dBFS, on for 250 ms of every second,
/// like Chromium's fake capture device beeps. Paced by the source's own queue
/// (`capture_frame` waits while it is full), so no timer is needed.
async fn run_tone(source: NativeAudioSource) {
    let mut n: u64 = 0;
    let mut buf = vec![0i16; FRAME];
    loop {
        for (i, s) in buf.iter_mut().enumerate() {
            let t = n + i as u64;
            let in_beep = (t % SAMPLE_RATE as u64) < (SAMPLE_RATE as u64 / 4);
            *s = if in_beep {
                let phase = 2.0 * std::f32::consts::PI * 440.0 * (t as f32 / SAMPLE_RATE as f32);
                (phase.sin() * 3_277.0) as i16
            } else {
                0
            };
        }
        n += FRAME as u64;
        let frame = AudioFrame {
            data: buf.as_slice().into(),
            sample_rate: SAMPLE_RATE,
            num_channels: 1,
            samples_per_channel: FRAME as u32,
        };
        if source.capture_frame(&frame).await.is_err() {
            return;
        }
    }
}

fn dbfs(peak_rms: f32) -> f32 {
    if peak_rms <= 0.0 {
        f32::NEG_INFINITY
    } else {
        20.0 * (peak_rms / 32_768.0).log10()
    }
}

/// Measure one remote audio track: the loudest 10 ms RMS of each second, as
/// dBFS, into the shared state. This is the "measure the other's audio level"
/// half of the D2 exit on this side.
async fn run_meter(track: RemoteAudioTrack, shared: Shared, frames_in: Arc<AtomicU64>) {
    let mut stream = NativeAudioStream::new(track.rtc_track(), SAMPLE_RATE as i32, 1);
    let mut window_peak = 0.0f32;
    let mut window_start = std::time::Instant::now();
    while let Some(frame) = stream.next().await {
        frames_in.fetch_add(1, Ordering::Relaxed);
        let data = &frame.data;
        if !data.is_empty() {
            let sum: f64 = data.iter().map(|s| (*s as f64) * (*s as f64)).sum();
            let rms = (sum / data.len() as f64).sqrt() as f32;
            window_peak = window_peak.max(rms);
        }
        if window_start.elapsed().as_millis() >= 1_000 {
            let level = dbfs(window_peak);
            shared.update(|s| {
                s.call.remote_level_dbfs = level;
                s.call.remote_peak_dbfs = s.call.remote_peak_dbfs.max(level);
                if level > -60.0 {
                    s.call.remote_audible_seconds += 1;
                }
            });
            window_peak = 0.0;
            window_start = std::time::Instant::now();
        }
    }
}

impl Call {
    pub async fn connect(
        url: &str,
        token: &str,
        may_speak: bool,
        shared: Shared,
    ) -> Result<Call, String> {
        let real_mic = std::env::var("PQP_REAL_MIC").as_deref() == Ok("1");
        // Playout through WebRTC's platform ADM. Must exist before the room.
        let audio = PlatformAudio::new().map_err(|e| format!("platform audio: {e}"))?;
        if !real_mic {
            // Synthetic microphone: make sure nothing opens the real one.
            LkRuntime::instance().pc_factory().set_adm_recording_enabled(false);
        }

        let (room, mut events) = Room::connect(url, token, RoomOptions::default())
            .await
            .map_err(|e| format!("livekit connect: {e}"))?;
        let room = Arc::new(room);
        let frames_in = Arc::new(AtomicU64::new(0));
        let mut tasks = Vec::new();

        // Room events: remote audio, who is speaking, an unplanned disconnect.
        {
            let shared = shared.clone();
            let frames_in = frames_in.clone();
            tasks.push(tokio::spawn(async move {
                let mut meters: Vec<JoinHandle<()>> = Vec::new();
                while let Some(ev) = events.recv().await {
                    match ev {
                        RoomEvent::TrackSubscribed {
                            track: RemoteTrack::Audio(track),
                            publication,
                            participant,
                        } => {
                            let deafened = shared.read().call.deafened;
                            publication.set_enabled(!deafened);
                            track.rtc_track().set_enabled(!deafened);
                            bench_line("REMOTE_AUDIO", participant.identity().as_str());
                            meters.push(tokio::spawn(run_meter(
                                track,
                                shared.clone(),
                                frames_in.clone(),
                            )));
                        }
                        RoomEvent::ActiveSpeakersChanged { speakers } => {
                            let ids = speakers.iter().map(|p| p.identity().as_str().to_string()).collect();
                            shared.update(|s| s.call.speaking = ids);
                        }
                        RoomEvent::Disconnected { reason } => {
                            shared.update(|s| {
                                if s.call.phase == CallPhase::Connected {
                                    s.call.phase = CallPhase::Failed(format!("SFU disconnected: {reason:?}"));
                                }
                            });
                            break;
                        }
                        _ => {}
                    }
                }
                for m in meters {
                    m.abort();
                }
            }));
        }

        let mut mic = None;
        if may_speak {
            let source = if real_mic {
                audio.rtc_source()
            } else {
                let native = NativeAudioSource::new(
                    AudioSourceOptions {
                        echo_cancellation: true,
                        noise_suppression: true,
                        auto_gain_control: true,
                    },
                    SAMPLE_RATE,
                    1,
                    100,
                );
                tasks.push(tokio::spawn(run_tone(native.clone())));
                RtcAudioSource::Native(native)
            };
            let track = LocalAudioTrack::create_audio_track("microphone", source);
            let publication = room
                .local_participant()
                .publish_track(
                    LocalTrack::Audio(track),
                    TrackPublishOptions {
                        source: TrackSource::Microphone,
                        ..Default::default()
                    },
                )
                .await
                .map_err(|e| format!("publish microphone: {e}"))?;
            mic = Some(publication);
        }

        Ok(Call {
            room,
            mic,
            tasks,
            _audio: audio,
            frames_in,
        })
    }

    pub fn mic_published(&self) -> bool {
        self.mic.is_some()
    }

    pub fn set_muted(&self, muted: bool) {
        if let Some(p) = &self.mic {
            if muted { p.mute() } else { p.unmute() }
        }
    }

    /// Deafen: ask the SFU to stop forwarding every remote audio track (so
    /// nothing is decoded or played, and the meter can prove it) and disable
    /// playout locally too. New tracks start the same way while deafened.
    pub fn set_deafened(&self, deafened: bool) {
        for p in self.room.remote_participants().values() {
            for publication in p.track_publications().values() {
                if let Some(RemoteTrack::Audio(t)) = publication.track() {
                    publication.set_enabled(!deafened);
                    t.rtc_track().set_enabled(!deafened);
                }
            }
        }
    }

    pub async fn close(self) {
        let _ = self.room.close().await;
    }
}
