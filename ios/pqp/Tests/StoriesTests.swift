import AVFoundation
import ImageIO
import UIKit
import XCTest
@testable import pqp

/// Stories on iOS: the wire shapes from `packages/shared/src/stories.ts`, the
/// strip's local rules (expiry, seen, when it draws), the viewer's position,
/// pacing, and the composer's refusals.
@MainActor
final class StoriesTests: XCTestCase {
    private let a = "11111111-1111-4111-8111-111111111111"
    private let b = "22222222-2222-4222-8222-222222222222"
    private let server = "33333333-3333-4333-8333-333333333333"

    private func storyJSON(kind: String = "image", sticker: String = "null", extra: String = "") -> String {
        """
        {"id":"\(a)","author":{"id":"\(b)","displayName":"Bia Souza","avatarUrl":null,"handle":null},
         "kind":"\(kind)","caption":"1v4","text":null,"background":null,
         "media":{"url":"https://x.y/a.jpg","posterUrl":null,"contentType":"image/jpeg","width":720,"height":1280,"durationMs":null},
         "sticker":\(sticker),"call":null,
         "publishedAt":"2026-10-12T10:00:00.000Z","expiresAt":"2026-10-13T10:00:00.000Z",
         "audiences":[{"kind":"server","serverId":"\(server)","serverName":"QG do pqp"},{"kind":"friends"}],
         "viewer":{"seen":false,"reaction":"fire","canReply":false,"replyBlockedReason":"dm_closed","canModerate":["\(server)"]},
         "own":null\(extra)}
        """
    }

    // MARK: - Decoding

    func testStoryDecodes() throws {
        let story = try Coding.decoder.decode(Story.self, from: Data(storyJSON().utf8))
        XCTAssertEqual(story.author.firstName, "Bia")
        XCTAssertEqual(story.media?.width, 720)
        XCTAssertEqual(story.audiences, [.server(id: server, name: "QG do pqp"), .friends])
        XCTAssertEqual(story.viewer.reaction, "fire")
        XCTAssertEqual(story.viewer.replyBlockedReason, "dm_closed")
        XCTAssertEqual(story.viewer.canModerate, [server])
        // Absent in an older API: defaulted, like the shared schema.
        XCTAssertEqual(story.viewer.canSaveToBau, [])
        XCTAssertFalse(story.isMine)
    }

    /// Phase 2 adds sticker types; a client that meets one it does not know
    /// draws nothing for it and keeps the story.
    func testAnUnknownStickerIsNoSticker() throws {
        let poll = #"{"type":"poll","question":"?"}"#
        let story = try Coding.decoder.decode(Story.self, from: Data(storyJSON(sticker: poll).utf8))
        XCTAssertNil(story.sticker)
        XCTAssertEqual(story.id, a)
        let call = #"{"type":"call","serverId":"\#(server)","channelId":"\#(a)"}"#
        XCTAssertEqual(try Coding.decoder.decode(Story.self, from: Data(storyJSON(sticker: call).utf8)).sticker?.channelId, a)
    }

    /// With the flag off the strip is `{enabled:false}` and every other
    /// field at its default.
    func testAStripWithTheFlagOffDecodesToNothing() throws {
        let strip = try Coding.decoder.decode(StoryStrip.self, from: Data(#"{"enabled":false}"#.utf8))
        XCTAssertFalse(strip.enabled)
        XCTAssertTrue(strip.items.isEmpty)
        XCTAssertNil(strip.own)
        XCTAssertFalse(StoryRules.showsStrip(strip))
    }

    func testStoriesUpdateFrameDecodes() async throws {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        await client.ingest(Data(#"{"type":"stories-update","scope":"server","serverId":"\#(server)","removedStoryIds":["\#(a)"]}"#.utf8))
        var iterator = stream.makeAsyncIterator()
        let event = await iterator.next()
        guard case .storiesUpdate(let update) = event else {
            return XCTFail("Expected storiesUpdate, got \(String(describing: event))")
        }
        XCTAssertEqual(update, StoriesUpdate(scope: "server", serverId: server, removedStoryIds: [a]))
    }

    /// `serverId` is present exactly when the scope is a server. A frame that
    /// breaks the pairing is not acted on.
    func testAStoriesFrameWithoutItsServerIsDropped() async throws {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        await client.ingest(Data(#"{"type":"stories-update","scope":"server"}"#.utf8))
        await client.ingest(Data(#"{"type":"stories-update","scope":"own"}"#.utf8))
        var iterator = stream.makeAsyncIterator()
        guard case .storiesUpdate(let update) = await iterator.next() else {
            return XCTFail("The own frame should come through")
        }
        XCTAssertEqual(update.scope, "own")
    }

    func testPostStoriesIsBit25() {
        XCTAssertEqual(PermissionBit.postStories, 33_554_432)
    }

    // MARK: - The strip

    private func item(_ id: String, expires: TimeInterval, unseen: Bool = true, ids: [String]? = nil) -> StoryStripItem {
        StoryStripItem(
            author: StoryAuthor(id: id, displayName: id, avatarUrl: nil),
            storyIds: ids ?? [id + "-s"],
            latestAt: Date(timeIntervalSince1970: 0),
            expiresAt: Date(timeIntervalSince1970: expires),
            unseen: unseen,
            hasCall: false
        )
    }

    /// Expiry sends no frame: a ring whose newest story ran out goes locally.
    func testExpiredRingsAreDroppedLocally() {
        let now = Date(timeIntervalSince1970: 1_000)
        let strip = StoryStrip(enabled: true, canPost: true, own: item("me", expires: 900),
                               items: [item("old", expires: 999), item("live", expires: 2_000)], firstRunHint: false)
        let next = StoryRules.dropExpired(strip, now: now)
        XCTAssertNil(next.own)
        XCTAssertEqual(next.items.map(\.id), ["live"])
        XCTAssertEqual(StoryRules.nextExpiry(strip, now: now), Date(timeIntervalSince1970: 2_000))
    }

    /// The strip appears only with a story on the air.
    func testTheStripDrawsOnlyWithSomethingLive() {
        let empty = StoryStrip(enabled: true, canPost: true, own: nil, items: [], firstRunHint: true)
        XCTAssertFalse(StoryRules.showsStrip(empty))
        var withOne = empty
        withOne.items = [item("x", expires: .greatestFiniteMagnitude)]
        XCTAssertTrue(StoryRules.showsStrip(withOne))
        var off = withOne
        off.enabled = false
        XCTAssertFalse(StoryRules.showsStrip(off))
    }

    /// A ring turns seen only when every story in it was watched.
    func testARingTurnsSeenWhenAllItsStoriesWereWatched() {
        let strip = StoryStrip(enabled: true, canPost: false, own: nil, items: [
            item("a", expires: 9_999, ids: ["a1", "a2"]),
            item("b", expires: 9_999, ids: ["b1"]),
        ], firstRunHint: false)
        let next = StoryRules.markingSeen(strip, seenIds: ["a1", "b1"])
        XCTAssertTrue(next.items[0].unseen, "a2 was not watched")
        XCTAssertFalse(next.items[1].unseen)
    }

    // MARK: - The viewer

    func testTapThroughWalksStoriesThenPeopleThenEnds() {
        var playback = StoryPlayback(people: [["a1", "a2"], ["b1"]])
        XCTAssertEqual(playback.currentId, "a1")
        XCTAssertTrue(playback.next())
        XCTAssertEqual(playback.currentId, "a2")
        XCTAssertTrue(playback.next())
        XCTAssertEqual(playback.currentId, "b1")
        XCTAssertFalse(playback.next(), "The end closes the viewer")
    }

    func testTapLeftGoesBackAndStaysAtTheStart() {
        var playback = StoryPlayback(people: [["a1"], ["b1", "b2"]], startPerson: 1)
        XCTAssertEqual(playback.currentId, "b1")
        playback.previous()
        XCTAssertEqual(playback.currentId, "a1")
        playback.previous()
        XCTAssertEqual(playback.currentId, "a1")
    }

    func testSwipeChangesPersonAndRestartsThem() {
        var playback = StoryPlayback(people: [["a1", "a2"], ["b1"], []])
        XCTAssertEqual(playback.people.count, 2, "A person with no stories is not a stop")
        _ = playback.next()
        XCTAssertTrue(playback.nextPerson())
        XCTAssertEqual(playback.currentId, "b1")
        XCTAssertFalse(playback.nextPerson())
        XCTAssertTrue(playback.previousPerson())
        XCTAssertEqual(playback.currentId, "a1")
        XCTAssertEqual(playback.prefetchIds, ["a1", "a2", "b1"])
    }

    /// The shared pacing: photo 5 s, text 5 s + 50 ms a character capped at
    /// 10 s, call 8 s, video its own length.
    func testDisplayTimes() throws {
        XCTAssertEqual(StoryLimits.textDisplayMs("oi"), 5_100)
        XCTAssertEqual(StoryLimits.textDisplayMs(String(repeating: "a", count: 280)), 10_000)
        let photo = try Coding.decoder.decode(Story.self, from: Data(storyJSON().utf8))
        XCTAssertEqual(photo.displayMs, 5_000)
    }

    func testAgeAndTimeLeft() {
        let now = Date(timeIntervalSince1970: 100_000)
        XCTAssertEqual(StoryRules.age(since: now.addingTimeInterval(-12 * 60), now: now), String(localized: "\(12) min"))
        XCTAssertEqual(StoryRules.age(since: now.addingTimeInterval(-2 * 3600), now: now), String(localized: "\(2) h"))
        XCTAssertEqual(StoryRules.left(until: now.addingTimeInterval(21 * 3600 + 120), now: now), String(localized: "\(21) h"))
    }

    func testReplyBlockedLines() {
        XCTAssertNotNil(StoryRules.replyBlockedLine("replies_off", name: "Bia"))
        XCTAssertNotNil(StoryRules.replyBlockedLine("dm_closed", name: "Bia"))
        XCTAssertNil(StoryRules.replyBlockedLine(nil, name: "Bia"))
    }

    func testReactionsAreTheHouseSix() {
        XCTAssertEqual(StoryRules.reactions.map(\.key), ["gg", "fire", "joy", "wow", "skull", "clap"])
        XCTAssertEqual(StoryRules.glyph(for: "gg"), "GG")
    }

    // MARK: - The composer

    /// Refused before anything uploads, with the seconds in the line.
    func testAVideoOverThirtySecondsIsRefused() {
        let line = StoryRules.videoProblem(durationMs: 30_400, byteSize: 1_000)
        XCTAssertEqual(line, String(localized: "This video is \(31) s. The limit is 30 s."))
        XCTAssertNil(StoryRules.videoProblem(durationMs: 30_000, byteSize: 1_000))
        XCTAssertNotNil(StoryRules.videoProblem(durationMs: 10_000, byteSize: StoryLimits.maxBytes + 1))
    }

    /// At most 1440 on the long side, proportions kept, small images untouched.
    func testImagesAreFittedTo1440() {
        XCTAssertEqual(StoryMediaPrep.fittedSize(CGSize(width: 4032, height: 3024), maxEdge: 1440), CGSize(width: 1440, height: 1080))
        XCTAssertEqual(StoryMediaPrep.fittedSize(CGSize(width: 800, height: 600), maxEdge: 1440), CGSize(width: 800, height: 600))
    }

    /// The re-encode drops EXIF, GPS included: the bytes are a fresh JPEG.
    func testTheReencodeCarriesNoLocation() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2000, height: 1000)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 2000, height: 1000))
        }
        let draft = try XCTUnwrap(StoryMediaPrep.image(image))
        XCTAssertEqual(draft.contentType, "image/jpeg")
        XCTAssertEqual(draft.width, 1440)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(draft.data as CFData, nil))
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
        XCTAssertNil(properties?[kCGImagePropertyGPSDictionary as String])
    }

    /// A real clip through the real export: 720p MP4 at most, its length
    /// kept, a poster drawn, and a 31 s one refused before any upload.
    func testVideoPrepExportsAnMp4AndRefusesALongOne() async throws {
        let short = try await makeClip(seconds: 2)
        let draft = try await StoryMediaPrep.video(at: short, maxVideoMs: StoryLimits.maxVideoMs)
        XCTAssertEqual(draft.contentType, "video/mp4")
        XCTAssertLessThanOrEqual(max(draft.width, draft.height), 1280)
        XCTAssertEqual(Double(draft.durationMs ?? 0), 2_000, accuracy: 150)
        XCTAssertGreaterThan(draft.data.count, 0)

        let long = try await makeClip(seconds: 31)
        do {
            _ = try await StoryMediaPrep.video(at: long, maxVideoMs: StoryLimits.maxVideoMs)
            XCTFail("A 31 s video must be refused")
        } catch let failure as StoryMediaPrep.Failure {
            XCTAssertEqual(failure.message, String(localized: "This video is \(31) s. The limit is 30 s."))
        }
    }

    /// A solid-colour H.264 clip, small and fast to write.
    private func makeClip(seconds: Int) async throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("clip-\(UUID().uuidString).mov")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 568,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 568,
        ])
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(nil, 320, 568, kCVPixelFormatType_32ARGB, nil, &buffer)
        let pixels = try XCTUnwrap(buffer)
        // Two frames a second is plenty for a duration check.
        for frame in 0..<(seconds * 2) {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 2))
        }
        input.markAsFinished()
        // The clip lasts exactly `seconds`, whatever the last frame's time.
        writer.endSession(atSourceTime: CMTime(value: CMTimeValue(seconds), timescale: 1))
        await writer.finishWriting()
        return url
    }

    func testTheCreateRequestLeavesOutWhatAKindDoesNotHave() throws {
        let request = CreateStoryRequest(
            kind: "text", text: "bora", background: "night",
            audiences: StoryAudienceTargets(serverIds: [server], friends: false)
        )
        let json = try XCTUnwrap(String(data: try Coding.encoder.encode(request), encoding: .utf8))
        XCTAssertFalse(json.contains("\"requestId\""), "Absent unless the composer made one")
        XCTAssertFalse(json.contains("\"media\""))
        XCTAssertFalse(json.contains("\"caption\""))
        XCTAssertTrue(json.contains("\"background\":\"night\""))
    }

    /// The composer's retry is the same story: the id rides the create.
    func testTheCreateRequestCarriesItsRequestId() throws {
        let request = CreateStoryRequest(
            requestId: a, kind: "text", text: "bora", background: "night",
            audiences: StoryAudienceTargets(serverIds: [], friends: true)
        )
        let json = try XCTUnwrap(String(data: try Coding.encoder.encode(request), encoding: .utf8))
        XCTAssertTrue(json.contains("\"requestId\":\"\(a)\""))
    }

    func testAStoryReportOffersTheMinorReason() {
        XCTAssertEqual(ReportReason.minorSexual.rawValue, "minor_sexual")
    }
}
