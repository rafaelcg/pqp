@preconcurrency import AVFoundation
import Foundation
import LiveKit

/// The sound of a shared screen (a game, a video, whatever is playing), on its
/// way from the broadcast extension into a LiveKit room.
///
/// ### Where it goes, and why only there
///
/// LiveKit's audio engine has a mixer in front of the microphone
/// (`AudioManager.shared.mixer`), and `capture(appAudio:)` is its door for
/// exactly this: app audio is mixed into what the microphone track sends. The
/// mesh path is Google's WebRTC build, whose only equivalent is replacing the
/// whole audio device (`RTCAudioDevice`), capture and playout and voice
/// processing included, for every call. That is not a trade worth making blind
/// on a path that cannot be exercised in the simulator, so on mesh the share
/// stays picture only and this gate is simply never opened.
///
/// ### Why a process-wide gate
///
/// Buffers arrive on the socket's queue, about 43 a second, and are handed
/// straight to the mixer, which is thread safe. Asking the room (an actor) or
/// the share controller (the main actor) about every one of them would add a
/// hop per buffer for an answer that changes twice per share. So the room opens
/// the gate when its share starts and closes it when the share stops or the
/// room goes; only one call is ever live on a phone.
final class ScreenShareAppAudio: @unchecked Sendable {
    static let shared = ScreenShareAppAudio()

    private let lock = NSLock()
    private var isOpen = false

    /// Opened by the LiveKit room for the life of its share.
    func setOpen(_ open: Bool) {
        lock.withLock { isOpen = open }
    }

    var acceptsAudio: Bool { lock.withLock { isOpen } }

    /// One buffer from the extension. Dropped unless a LiveKit share is live.
    func deliver(_ frame: ScreenShareAudioFrame) {
        guard acceptsAudio, let buffer = Self.pcmBuffer(for: frame) else { return }
        AudioManager.shared.mixer.capture(appAudio: buffer)
    }

    /// The wire's Int16 interleaved samples as the standard deinterleaved
    /// Float32 buffer an `AVAudioPlayerNode` takes. The sample rate is left as
    /// it arrived: the mixer converts to the engine's own rate itself, with a
    /// converter it caches per input format.
    static func pcmBuffer(for frame: ScreenShareAudioFrame) -> AVAudioPCMBuffer? {
        let header = frame.header
        guard header.isPlausible, frame.payload.count >= header.payloadLength,
              let format = AVAudioFormat(
                  standardFormatWithSampleRate: Double(header.sampleRate),
                  channels: AVAudioChannelCount(header.channels)
              ),
              let buffer = AVAudioPCMBuffer(
                  pcmFormat: format, frameCapacity: AVAudioFrameCount(header.frameCount)
              ),
              let planes = buffer.floatChannelData else { return nil }
        buffer.frameLength = AVAudioFrameCount(header.frameCount)
        let channels = header.channels
        frame.payload.withUnsafeBytes { raw in
            for index in 0..<header.frameCount {
                for channel in 0..<channels {
                    let offset = (index * channels + channel) * 2
                    let low = UInt16(raw[offset])
                    let high = UInt16(raw[offset + 1])
                    let sample = Int16(bitPattern: low | high << 8)
                    planes[channel][index] = Float(sample) / 32_768
                }
            }
        }
        return buffer
    }
}

/// What the microphone track and the mixer's microphone input should be doing.
///
/// A share's sound rides the microphone track (see `ScreenShareAppAudio`), so a
/// plain mute would silence the game too, and somebody streaming a match who
/// mutes to cough would take the whole soundtrack away from the room without
/// knowing it. So while a share's sound is live and the mute is the person's
/// own, the track stays on and the MICROPHONE is what goes to zero, in the
/// mixer, before anything reaches the encoder.
///
/// A moderator's mute is different and is never worked around: the server
/// muted the track at the SFU, and turning it back on here would undo that.
struct SfuMicrophoneRouting: Equatable, Sendable {
    let trackEnabled: Bool
    /// The mixer's microphone volume, 0 or 1.
    let micVolume: Float

    static func resolve(muted: Bool, appAudioLive: Bool, serverMuted: Bool) -> SfuMicrophoneRouting {
        // First, and whatever the local flag says: the roster's moderator mute
        // can land before the model has flipped its own `isMuted`, and that
        // window must not turn a track the SFU just muted back on.
        if serverMuted { return SfuMicrophoneRouting(trackEnabled: false, micVolume: 1) }
        if !muted { return SfuMicrophoneRouting(trackEnabled: true, micVolume: 1) }
        if appAudioLive {
            return SfuMicrophoneRouting(trackEnabled: true, micVolume: 0)
        }
        return SfuMicrophoneRouting(trackEnabled: false, micVolume: 1)
    }
}
