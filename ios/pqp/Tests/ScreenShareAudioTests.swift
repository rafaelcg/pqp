import AVFoundation
import CoreAudioTypes
import XCTest
@testable import pqp

/// The sound half of a shared screen, everything about it that does not need a
/// phone: the wire format the extension and the app must agree on, the PCM
/// conversion that has to survive whatever ReplayKit hands over, and the rule
/// for what a mute does while a share's sound rides the microphone track.
///
/// The failure every one of these guards against is silent at the sender and
/// loud at the far end: a byte-order mistake is full-scale noise in somebody's
/// headphones, and a desynchronised stream is a share that freezes.
final class ScreenShareAudioTests: XCTestCase {
    // MARK: - Wire

    func testAudioHeaderRoundTripsThroughItsBytes() {
        for header in [
            ScreenShareAudioHeader(sampleRate: 44_100, channels: 2, frameCount: 1024),
            ScreenShareAudioHeader(sampleRate: 48_000, channels: 1, frameCount: 480),
        ] {
            XCTAssertEqual(header.encoded().count, ScreenShareWire.headerSize)
            XCTAssertEqual(ScreenShareAudioHeader.decode(header.encoded()), header)
        }
    }

    func testAudioAndVideoHeadersAreNotEachOther() {
        let audio = ScreenShareAudioHeader(sampleRate: 44_100, channels: 2, frameCount: 1024)
        let video = ScreenShareFrameHeader(width: 640, height: 360)
        XCTAssertNil(ScreenShareFrameHeader.decode(audio.encoded()))
        XCTAssertNil(ScreenShareAudioHeader.decode(video.encoded()))
    }

    func testImplausibleAudioIsRejected() {
        XCTAssertFalse(ScreenShareAudioHeader(sampleRate: 44_100, channels: 3, frameCount: 10).isPlausible)
        XCTAssertFalse(ScreenShareAudioHeader(sampleRate: 100, channels: 2, frameCount: 10).isPlausible)
        XCTAssertFalse(ScreenShareAudioHeader(sampleRate: 44_100, channels: 2, frameCount: 0).isPlausible)
        XCTAssertFalse(ScreenShareAudioHeader(sampleRate: 44_100, channels: 2, frameCount: 1 << 20).isPlausible)
    }

    func testALengthThatContradictsTheSamplesIsRejected() {
        var bytes = [UInt8](ScreenShareAudioHeader(sampleRate: 44_100, channels: 2, frameCount: 4).encoded())
        bytes[16] = 0xFF
        XCTAssertNil(ScreenShareAudioHeader.decode(Data(bytes)))
    }

    func testAnOlderBuildsHeaderIsRefused() {
        // A broadcast that outlived an app update: refused, so it reconnects,
        // rather than misread.
        var bytes = [UInt8](ScreenShareFrameHeader(width: 640, height: 360).encoded())
        bytes[4] = 1
        bytes[5] = 0
        XCTAssertNil(ScreenShareFrameHeader.decode(Data(bytes)))
    }

    func testPicturesAndSoundInterleaveOnOneStream() {
        let video = ScreenShareFrameHeader(width: 4, height: 2)
        let videoPayload = Data(repeating: 9, count: video.payloadLength)
        let audio = ScreenShareAudioHeader(sampleRate: 48_000, channels: 2, frameCount: 3)
        let audioPayload = Data((0..<audio.payloadLength).map { UInt8($0) })
        let wire = audio.encoded() + audioPayload + video.encoded() + videoPayload
            + audio.encoded() + audioPayload

        var parser = ScreenShareFrameParser()
        var delivered: [ScreenShareMessage] = []
        for chunk in wire.chunked(into: 5) {
            delivered += parser.append(chunk) ?? []
        }
        let sound = ScreenShareMessage.audio(ScreenShareAudioFrame(header: audio, payload: audioPayload))
        XCTAssertEqual(delivered, [
            sound,
            .video(ScreenShareFrame(header: video, payload: videoPayload)),
            sound,
        ])
    }

    // MARK: - PCM conversion

    private func convert(_ bytes: [UInt8], _ format: ScreenSharePCMFormat, frames: Int) -> [Int16] {
        var converter = ScreenShareAudioConverter()
        let count = bytes.withUnsafeBytes { converter.convert($0, format: format, frameCount: frames) }
        return Array(converter.samples.prefix(count))
    }

    func testLittleEndianInt16PassesThrough() {
        let format = ScreenSharePCMFormat(sampleRate: 44_100, channels: 2, bitsPerChannel: 16)
        // 0x0102 = 258 left, 0xFFFE = -2 right.
        XCTAssertEqual(convert([0x02, 0x01, 0xFE, 0xFF], format, frames: 1), [258, -2])
    }

    func testBigEndianInt16IsSwapped() {
        // What ReplayKit's app audio is on some devices. Read as little-endian
        // it would be noise at full scale.
        let format = ScreenSharePCMFormat(
            sampleRate: 44_100, channels: 2, bitsPerChannel: 16, isBigEndian: true
        )
        XCTAssertEqual(convert([0x01, 0x02, 0xFF, 0xFE], format, frames: 1), [258, -2])
    }

    func testFloatIsScaledAndClipped() {
        let format = ScreenSharePCMFormat(
            sampleRate: 48_000, channels: 1, bitsPerChannel: 32,
            isFloat: true, isSignedInteger: false
        )
        var bytes: [UInt8] = []
        for value: Float in [0.5, -1, 2, .nan] {
            withUnsafeBytes(of: value.bitPattern.littleEndian) { bytes += $0 }
        }
        XCTAssertEqual(convert(bytes, format, frames: 4), [16_384, -32_767, 32_767, 0])
    }

    func testInt32KeepsItsTopSixteenBits() {
        let format = ScreenSharePCMFormat(sampleRate: 48_000, channels: 1, bitsPerChannel: 32)
        var bytes: [UInt8] = []
        withUnsafeBytes(of: Int32(0x1234_5678).littleEndian) { bytes += $0 }
        XCTAssertEqual(convert(bytes, format, frames: 1), [0x1234])
    }

    func testNonInterleavedPlanesAreInterleaved() {
        let format = ScreenSharePCMFormat(
            sampleRate: 48_000, channels: 2, bitsPerChannel: 16, isNonInterleaved: true
        )
        // Left plane 1, 2; right plane 3, 4.
        let bytes: [UInt8] = [1, 0, 2, 0, 3, 0, 4, 0]
        XCTAssertEqual(convert(bytes, format, frames: 2), [1, 3, 2, 4])
    }

    func testWiderThanStereoKeepsTheFirstTwoChannels() {
        let format = ScreenSharePCMFormat(sampleRate: 48_000, channels: 4, bitsPerChannel: 16)
        let bytes: [UInt8] = [1, 0, 2, 0, 3, 0, 4, 0]
        XCTAssertEqual(convert(bytes, format, frames: 1), [1, 2])
        XCTAssertEqual(format.wireChannels, 2)
    }

    func testShortOrUnsupportedBuffersProduceNothing() {
        let short = ScreenSharePCMFormat(sampleRate: 44_100, channels: 2, bitsPerChannel: 16)
        XCTAssertEqual(convert([0, 0], short, frames: 1), [])
        let eightBit = ScreenSharePCMFormat(sampleRate: 44_100, channels: 1, bitsPerChannel: 8)
        XCTAssertFalse(eightBit.isSupported)
        XCTAssertEqual(convert([0, 0], eightBit, frames: 2), [])
    }

    func testAFormatIsReadFromItsDescription() {
        let description = AudioStreamBasicDescription(
            mSampleRate: 44_100,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsBigEndian
                | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
            mChannelsPerFrame: 2, mBitsPerChannel: 16, mReserved: 0
        )
        XCTAssertEqual(
            ScreenSharePCMFormat(description),
            ScreenSharePCMFormat(sampleRate: 44_100, channels: 2, bitsPerChannel: 16, isBigEndian: true)
        )
        var compressed = description
        compressed.mFormatID = kAudioFormatMPEG4AAC
        XCTAssertNil(ScreenSharePCMFormat(compressed))
    }

    // MARK: - Into the mixer

    func testTheWiresSamplesBecomeAFloatBufferAtTheirOwnRate() throws {
        let header = ScreenShareAudioHeader(sampleRate: 44_100, channels: 2, frameCount: 2)
        let samples: [Int16] = [16_384, -16_384, 0, 32_767]
        let payload = samples.withUnsafeBytes { Data($0) }
        let buffer = try XCTUnwrap(
            ScreenShareAppAudio.pcmBuffer(for: ScreenShareAudioFrame(header: header, payload: payload))
        )
        XCTAssertEqual(buffer.format.sampleRate, 44_100)
        XCTAssertEqual(buffer.format.channelCount, 2)
        XCTAssertEqual(buffer.frameLength, 2)
        let planes = try XCTUnwrap(buffer.floatChannelData)
        XCTAssertEqual(planes[0][0], 0.5, accuracy: 0.0001)
        XCTAssertEqual(planes[1][0], -0.5, accuracy: 0.0001)
        XCTAssertEqual(planes[0][1], 0, accuracy: 0.0001)
        XCTAssertEqual(planes[1][1], 1, accuracy: 0.001)
    }

    func testTheGateStartsShut() {
        // A mesh call never opens it, so a broadcast's sound has nowhere to go.
        XCTAssertFalse(ScreenShareAppAudio().acceptsAudio)
    }

    // MARK: - What a mute does while a share's sound is live

    func testUnmutedIsTheMicrophoneAsUsual() {
        for live in [false, true] {
            XCTAssertEqual(
                SfuMicrophoneRouting.resolve(muted: false, appAudioLive: live, serverMuted: false),
                SfuMicrophoneRouting(trackEnabled: true, micVolume: 1)
            )
        }
    }

    func testAMuteWithNoShareMutesTheTrack() {
        XCTAssertEqual(
            SfuMicrophoneRouting.resolve(muted: true, appAudioLive: false, serverMuted: false),
            SfuMicrophoneRouting(trackEnabled: false, micVolume: 1)
        )
    }

    func testMutingDuringAShareSilencesTheVoiceAndKeepsTheGame() {
        XCTAssertEqual(
            SfuMicrophoneRouting.resolve(muted: true, appAudioLive: true, serverMuted: false),
            SfuMicrophoneRouting(trackEnabled: true, micVolume: 0)
        )
    }

    func testAModeratorsMuteIsNeverWorkedAround() {
        // Including the moment the roster says so before the model has
        // flipped its own mute: `muted` false must not reopen the track.
        for muted in [false, true] {
            for live in [false, true] {
                XCTAssertEqual(
                    SfuMicrophoneRouting.resolve(muted: muted, appAudioLive: live, serverMuted: true),
                    SfuMicrophoneRouting(trackEnabled: false, micVolume: 1)
                )
            }
        }
    }
}
