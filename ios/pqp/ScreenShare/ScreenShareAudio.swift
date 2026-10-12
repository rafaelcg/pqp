import CoreAudioTypes
import Foundation

/// The shape of one buffer of PCM, as ReplayKit describes it.
///
/// Read from the sample buffer's `AudioStreamBasicDescription` every time and
/// never assumed. ReplayKit's app audio has been seen as 16-bit integer, 44.1
/// kHz stereo, BIG-endian on some devices and little-endian on others, and the
/// format can change mid-broadcast when what is playing changes. A converter
/// that guessed would turn a game's soundtrack into full-scale noise at the far
/// end, which is a worse outcome than sending nothing.
struct ScreenSharePCMFormat: Equatable, Sendable {
    let sampleRate: Double
    let channels: Int
    let bitsPerChannel: Int
    let isFloat: Bool
    let isSignedInteger: Bool
    let isBigEndian: Bool
    let isNonInterleaved: Bool

    init(
        sampleRate: Double,
        channels: Int,
        bitsPerChannel: Int,
        isFloat: Bool = false,
        isSignedInteger: Bool = true,
        isBigEndian: Bool = false,
        isNonInterleaved: Bool = false
    ) {
        self.sampleRate = sampleRate
        self.channels = channels
        self.bitsPerChannel = bitsPerChannel
        self.isFloat = isFloat
        self.isSignedInteger = isSignedInteger
        self.isBigEndian = isBigEndian
        self.isNonInterleaved = isNonInterleaved
    }

    /// Nil for anything that is not linear PCM.
    init?(_ description: AudioStreamBasicDescription) {
        guard description.mFormatID == kAudioFormatLinearPCM else { return nil }
        let flags = description.mFormatFlags
        self.init(
            sampleRate: description.mSampleRate,
            channels: Int(description.mChannelsPerFrame),
            bitsPerChannel: Int(description.mBitsPerChannel),
            isFloat: flags & kAudioFormatFlagIsFloat != 0,
            isSignedInteger: flags & kAudioFormatFlagIsSignedInteger != 0,
            isBigEndian: flags & kAudioFormatFlagIsBigEndian != 0,
            isNonInterleaved: flags & kAudioFormatFlagIsNonInterleaved != 0
        )
    }

    /// The three sample encodings this converter reads. Everything else is
    /// dropped rather than misread.
    var isSupported: Bool {
        guard channels >= 1, sampleRate >= 8_000, sampleRate <= 192_000 else { return false }
        if isFloat { return bitsPerChannel == 32 }
        return isSignedInteger && (bitsPerChannel == 16 || bitsPerChannel == 32)
    }

    var bytesPerSample: Int { bitsPerChannel / 8 }

    /// What leaves the extension: never more than two channels.
    var wireChannels: Int { min(channels, 2) }
}

/// Turns one ReplayKit buffer into the wire's one shape: Int16 little-endian,
/// interleaved, at most two channels, same sample rate.
///
/// Resampling is deliberately NOT done here. The app hands the result to
/// LiveKit's mixer, which converts to the engine's rate with `AVAudioConverter`
/// anyway, and doing it twice would cost the extension (which iOS kills at
/// about 50 MB) a converter of its own for nothing.
///
/// Holds its output buffer across calls: this runs about 43 times a second for
/// a whole broadcast, inside that 50 MB process.
struct ScreenShareAudioConverter: Sendable {
    /// Interleaved output. Valid up to the count the last `convert` returned.
    private(set) var samples: [Int16] = []

    /// Converts `frameCount` frames from `bytes`, and returns how many Int16
    /// samples (frames times wire channels) are now in `samples`. Zero means
    /// the buffer was not usable: an unsupported format, or fewer bytes than
    /// the format says it holds.
    ///
    /// Non-interleaved input is read the way a `CMBlockBuffer` lays it out:
    /// each channel's plane after the previous one, `frameCount` samples each.
    mutating func convert(
        _ bytes: UnsafeRawBufferPointer,
        format: ScreenSharePCMFormat,
        frameCount: Int
    ) -> Int {
        guard format.isSupported, frameCount > 0, let base = bytes.baseAddress else { return 0 }
        let width = format.bytesPerSample
        guard bytes.count >= frameCount * format.channels * width else { return 0 }

        let outChannels = format.wireChannels
        let count = frameCount * outChannels
        if samples.count < count {
            samples = [Int16](repeating: 0, count: count)
        }
        samples.withUnsafeMutableBufferPointer { out in
            for frame in 0..<frameCount {
                for channel in 0..<outChannels {
                    let offset = format.isNonInterleaved
                        ? (channel * frameCount + frame) * width
                        : (frame * format.channels + channel) * width
                    out[frame * outChannels + channel] = Self.sample(
                        at: base.advanced(by: offset), format: format
                    )
                }
            }
        }
        return count
    }

    /// One sample, read byte by byte so neither alignment nor the host's
    /// byte order matters.
    private static func sample(at pointer: UnsafeRawPointer, format: ScreenSharePCMFormat) -> Int16 {
        let width = format.bytesPerSample
        var raw: UInt32 = 0
        for index in 0..<width {
            let byte = UInt32(pointer.load(fromByteOffset: index, as: UInt8.self))
            let shift = format.isBigEndian ? (width - 1 - index) * 8 : index * 8
            raw |= byte << UInt32(shift)
        }
        if format.isFloat {
            let value = Float(bitPattern: raw)
            guard value.isFinite else { return 0 }
            let clamped = max(-1, min(1, value))
            return Int16((clamped * 32_767).rounded())
        }
        if width == 2 {
            return Int16(bitPattern: UInt16(truncatingIfNeeded: raw))
        }
        // 32-bit integer: the top sixteen bits are the sample at Int16 scale.
        return Int16(truncatingIfNeeded: Int32(bitPattern: raw) >> 16)
    }
}

extension ScreenShareAudioHeader {
    /// The header for what `ScreenShareAudioConverter` just produced.
    init(format: ScreenSharePCMFormat, frameCount: Int) {
        self.init(
            sampleRate: Int(format.sampleRate.rounded()),
            channels: format.wireChannels,
            frameCount: frameCount
        )
    }
}
