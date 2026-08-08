import XCTest
@testable import pqp

/// The screen-share bridge's pure logic.
///
/// Everything worth testing about ReplayKit screen sharing that does not need a
/// physical device lives here, and all of it is the kind of rule that fails
/// silently rather than loudly:
///
///  - the **frame header**, which is a byte layout two *processes* have to agree
///    on. Disagree by one field and the reader treats a payload length as a
///    width, allocates nonsense, and shows nothing.
///  - the **downscale math**, whose only hard rule (even dimensions) has no
///    representation in NV12 if broken — an odd width produces a sheared picture,
///    not an error.
///  - the **stale-bridge timeout**, which is the *only* signal iOS gives that a
///    broadcast stopped. Get it wrong and either the far end watches a frozen
///    frame forever, or a share that pauses gets torn down mid-presentation.
final class ScreenShareBridgeTests: XCTestCase {
    // MARK: - Frame header round trip

    func testHeaderRoundTripsThroughItsBytes() {
        for header in [
            ScreenShareFrameHeader(width: 1280, height: 720),
            ScreenShareFrameHeader(width: 640, height: 360, rotation: 90),
            ScreenShareFrameHeader(width: 886, height: 1920, rotation: 180),
            ScreenShareFrameHeader(width: 2, height: 2, rotation: 270),
        ] {
            let decoded = ScreenShareFrameHeader.decode(header.encoded())
            XCTAssertEqual(decoded, header, "\(header) did not survive its own encoding")
        }
    }

    func testHeaderIsExactlyTheAdvertisedSize() {
        // The reader waits for this many bytes before it tries to parse; a
        // mismatch deadlocks the stream rather than failing it.
        XCTAssertEqual(
            ScreenShareFrameHeader(width: 640, height: 360).encoded().count,
            ScreenShareWire.headerSize
        )
    }

    func testHeaderCarriesTheNV12PayloadLength() {
        let header = ScreenShareFrameHeader(width: 640, height: 360)
        // Luma plus half-height interleaved chroma: 1.5 bytes per pixel.
        XCTAssertEqual(header.payloadLength, 640 * 360 * 3 / 2)
        XCTAssertEqual(header.lumaLength + header.chromaLength, header.payloadLength)
    }

    func testTruncatedHeaderDecodesToNothing() {
        let encoded = ScreenShareFrameHeader(width: 640, height: 360).encoded()
        XCTAssertNil(ScreenShareFrameHeader.decode(encoded.dropLast()))
        XCTAssertNil(ScreenShareFrameHeader.decode(Data()))
    }

    func testForeignBytesDecodeToNothing() {
        // A socket left over from another writer, or an older build's format.
        XCTAssertNil(ScreenShareFrameHeader.decode(Data(repeating: 0, count: 20)))
        XCTAssertNil(ScreenShareFrameHeader.decode(Data(repeating: 0xFF, count: 64)))
    }

    func testHeaderWithALengthThatContradictsItsGeometryIsRejected() {
        // The guard that stops a corrupt length from becoming an allocation.
        var bytes = [UInt8](ScreenShareFrameHeader(width: 640, height: 360).encoded())
        bytes[16] = 0xFF
        bytes[17] = 0xFF
        XCTAssertNil(ScreenShareFrameHeader.decode(Data(bytes)))
    }

    func testOddDimensionsAreNotAValidHeader() {
        // Reached only by corruption — the encoder never produces one — but NV12
        // cannot represent it, so it must not be accepted.
        XCTAssertFalse(ScreenShareFrameHeader(width: 641, height: 360).isPlausible)
        XCTAssertFalse(ScreenShareFrameHeader(width: 640, height: 361).isPlausible)
        XCTAssertFalse(ScreenShareFrameHeader(width: 640, height: 360, rotation: 45).isPlausible)
        XCTAssertFalse(ScreenShareFrameHeader(width: 0, height: 0).isPlausible)
    }

    // MARK: - Stream reassembly

    /// A frame with a recognisable payload, so a reassembly bug shows up as
    /// wrong bytes rather than merely the wrong count.
    private func frame(width: Int, height: Int, fill: UInt8) -> (ScreenShareFrame, Data) {
        let header = ScreenShareFrameHeader(width: width, height: height)
        let payload = Data(repeating: fill, count: header.payloadLength)
        var wire = header.encoded()
        wire.append(payload)
        return (ScreenShareFrame(header: header, payload: payload), wire)
    }

    func testOneWholeFrameArrivesAsOneFrame() {
        let (expected, wire) = frame(width: 32, height: 16, fill: 0xAB)
        var parser = ScreenShareFrameParser()
        XCTAssertEqual(parser.append(wire), [expected])
    }

    func testTwoFramesInOneReadBothArrive() {
        // A 64 KB read holds several small frames, and dropping the second is
        // invisible except as a share that runs at half speed.
        let (firstFrame, first) = frame(width: 32, height: 16, fill: 1)
        let (secondFrame, second) = frame(width: 32, height: 16, fill: 2)
        var parser = ScreenShareFrameParser()
        XCTAssertEqual(parser.append(first + second), [firstFrame, secondFrame])
    }

    func testAFrameSplitAcrossReadsIsHeldUntilComplete() {
        // The realistic case: 720p is ~1.4 MB and a socket read is 64 KB, so
        // every real frame arrives in pieces.
        let (expected, wire) = frame(width: 64, height: 32, fill: 0x7F)
        var parser = ScreenShareFrameParser()
        var delivered: [ScreenShareFrame] = []
        for chunk in wire.chunked(into: 7) {
            delivered += parser.append(chunk) ?? []
        }
        XCTAssertEqual(delivered, [expected])
    }

    func testAHeaderSplitAcrossReadsIsNotMisparsed() {
        let (expected, wire) = frame(width: 32, height: 16, fill: 3)
        var parser = ScreenShareFrameParser()
        XCTAssertEqual(parser.append(wire.prefix(9)), [])
        XCTAssertEqual(parser.append(wire.dropFirst(9)), [expected])
    }

    func testGarbageDesynchronisesRatherThanGuessing() {
        var parser = ScreenShareFrameParser()
        XCTAssertNil(parser.append(Data(repeating: 0x5A, count: 40)))
        // And the buffer is clean afterwards, so a reconnect starts fresh.
        let (expected, wire) = frame(width: 32, height: 16, fill: 4)
        XCTAssertEqual(parser.append(wire), [expected])
    }

    // MARK: - Downscale math

    func testLandscapeScreenIsCappedOnItsLongSide() {
        let size = screenShareTargetSize(width: 2560, height: 1600, maxLongSide: 1280)
        XCTAssertEqual(size.width, 1280)
        XCTAssertEqual(size.height, 800)
    }

    func testPortraitScreenIsCappedOnItsLongSide() {
        // An iPhone 15 Pro's capture, which is what the extension actually sees.
        let size = screenShareTargetSize(width: 1179, height: 2556, maxLongSide: 1280)
        XCTAssertEqual(size.height, 1280)
        XCTAssertEqual(size.width, 590)
    }

    func testSmallScreensAreNeverUpscaled() {
        let size = screenShareTargetSize(width: 640, height: 360, maxLongSide: 1280)
        XCTAssertEqual(size.width, 640)
        XCTAssertEqual(size.height, 360)
    }

    func testEveryResultIsEven() {
        // The one invariant NV12 cannot survive without. Odd inputs and odd
        // ratios are exactly where rounding produces one.
        for width in stride(from: 101, through: 3001, by: 97) {
            for height in stride(from: 103, through: 3003, by: 101) {
                let size = screenShareTargetSize(width: width, height: height)
                XCTAssertEqual(size.width % 2, 0, "odd width for \(width)x\(height)")
                XCTAssertEqual(size.height % 2, 0, "odd height for \(width)x\(height)")
                XCTAssertGreaterThanOrEqual(size.width, 2)
                XCTAssertGreaterThanOrEqual(size.height, 2)
                XCTAssertLessThanOrEqual(size.width, max(width, 2))
                XCTAssertLessThanOrEqual(size.height, max(height, 2))
            }
        }
    }

    func testAspectRatioSurvivesTheDownscale() {
        let source = (width: 1179.0, height: 2556.0)
        let size = screenShareTargetSize(width: 1179, height: 2556)
        let sourceRatio = source.width / source.height
        let targetRatio = Double(size.width) / Double(size.height)
        // Within one pixel of rounding on the short side.
        XCTAssertEqual(targetRatio, sourceRatio, accuracy: 0.01)
    }

    func testDegenerateSizesProduceNothingToSend() {
        XCTAssertEqual(screenShareTargetSize(width: 0, height: 100).width, 0)
        XCTAssertEqual(screenShareTargetSize(width: 100, height: 0).height, 0)
        XCTAssertEqual(screenShareTargetSize(width: -4, height: 100).width, 0)
    }

    // MARK: - Frame rate

    func testFirstFrameAlwaysPublishes() {
        // A share that waits a twelfth of a second to show anything looks broken
        // at exactly the moment the user is checking that it worked.
        var clock = ScreenShareFrameClock(frameRate: 12)
        XCTAssertTrue(clock.shouldPublish(at: 1000))
    }

    func testFramesInsideTheIntervalAreDropped() {
        var clock = ScreenShareFrameClock(frameRate: 12)
        XCTAssertTrue(clock.shouldPublish(at: 0))
        XCTAssertFalse(clock.shouldPublish(at: 0.01))
        XCTAssertFalse(clock.shouldPublish(at: 0.08))
        XCTAssertTrue(clock.shouldPublish(at: 1.0 / 12))
        XCTAssertFalse(clock.shouldPublish(at: 1.0 / 12 + 0.01))
    }

    func testSixtyHertzCaptureIsThinnedToTheTargetRate() {
        var clock = ScreenShareFrameClock(frameRate: 12)
        var published = 0
        for frame in 0..<60 {
            if clock.shouldPublish(at: Double(frame) / 60) { published += 1 }
        }
        // A second of 60fps capture must come out as roughly 12 frames, not 60.
        XCTAssertGreaterThanOrEqual(published, 11)
        XCTAssertLessThanOrEqual(published, 13)
    }

    func testAClockThatWentBackwardsPublishesRatherThanStalling() {
        // A new capture session rebases the timebase. Waiting for the old clock
        // to catch up would freeze the share for as long as the jump.
        var clock = ScreenShareFrameClock(frameRate: 12)
        XCTAssertTrue(clock.shouldPublish(at: 10_000))
        XCTAssertTrue(clock.shouldPublish(at: 5))
    }

    // MARK: - Stale bridge

    func testABridgeThatNeverDeliveredIsNotStale() {
        // The picker opened and was dismissed without starting: nothing began,
        // so nothing may be torn down.
        XCTAssertFalse(screenShareIsStale(lastFrameAt: nil, now: 9_999))
    }

    func testARecentFrameIsNotStale() {
        XCTAssertFalse(screenShareIsStale(lastFrameAt: 100, now: 100.5))
        XCTAssertFalse(screenShareIsStale(lastFrameAt: 100, now: 101.9))
    }

    func testSilenceBeyondTheTimeoutIsStale() {
        // The only signal iOS gives when a broadcast is stopped from the
        // status-bar indicator.
        XCTAssertTrue(screenShareIsStale(lastFrameAt: 100, now: 102))
        XCTAssertTrue(screenShareIsStale(lastFrameAt: 100, now: 130))
    }

    func testTheTimeoutIsTheDocumentedTwoSeconds() {
        XCTAssertEqual(ScreenShareWire.staleTimeout, 2)
    }

    // MARK: - Identifiers

    func testWireIdentifiersMatchTheBuild() {
        // These three strings are the whole handshake between two targets, an
        // entitlement and a system picker. A typo in any of them is a share
        // button that silently does nothing.
        XCTAssertEqual(ScreenShareWire.appGroupIdentifier, "group.gg.pqp.app")
        XCTAssertEqual(ScreenShareWire.broadcastExtensionIdentifier, "gg.pqp.app.broadcast")
        // A device's App Group container path plus this name has to fit in a
        // `sockaddr_un`, which is 104 bytes including the terminator.
        XCTAssertLessThanOrEqual(
            "/private/var/mobile/Containers/Shared/AppGroup/"
                .appending(UUID().uuidString)
                .appending("/")
                .appending(ScreenShareWire.socketName)
                .utf8.count,
            ScreenShareSocketServer.maximumPathLength - 1
        )
    }
}

extension Data {
    /// Splits into fixed-size pieces, to stand in for socket reads.
    fileprivate func chunked(into size: Int) -> [Data] {
        stride(from: 0, to: count, by: size).map { start in
            subdata(in: start..<Swift.min(start + size, count))
        }
    }
}
