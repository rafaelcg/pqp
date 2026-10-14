import UIKit
import XCTest
@testable import pqp

/// What gets fetched ahead of the viewer and the tray, and how: the window
/// (next two across authors, the next author's first), at most two at a time,
/// anything out of the window cancelled, no video on Low Data Mode.
@MainActor
final class StoryPreloaderTests: XCTestCase {
    private func story(
        _ id: String, kind: String = "image", poster: Bool = false,
        layers: String = "[]", avatar: String? = "https://x.y/av-\(1).jpg"
    ) throws -> Story {
        let media = kind == "video"
            ? #"{"url":"https://x.y/\#(id).mp4","posterUrl":\#(poster ? "\"https://x.y/\(id)-poster.jpg\"" : "null"),"contentType":"video/mp4","width":720,"height":1280,"durationMs":8000}"#
            : #"{"url":"https://x.y/\#(id).jpg","posterUrl":null,"contentType":"image/jpeg","width":720,"height":1280,"durationMs":null}"#
        let avatarJSON = avatar.map { "\"\($0)\"" } ?? "null"
        return try Coding.decoder.decode(Story.self, from: Data("""
        {"id":"\(id)","author":{"id":"u-\(id)","displayName":"Bia","avatarUrl":\(avatarJSON)},"kind":"\(kind)","caption":null,"text":null,"background":null,
         "media":\(media),"sticker":null,"call":null,"publishedAt":null,"expiresAt":null,"audiences":[],
         "viewer":{"seen":false,"reaction":null,"canReply":false,"replyBlockedReason":null,"canModerate":[]},"own":null,"layers":\(layers)}
        """.utf8))
    }

    private func url(_ string: String) -> URL { URL(string: string)! }

    // MARK: - The plan

    func testAPhotoIsItsPictureThenItsLayersThenItsAvatar() throws {
        let layers = #"[{"id":"l1","type":"image","x":0.5,"y":0.5,"scale":1,"rotation":0,"shape":"rect","url":"https://x.y/layer.png","width":10,"height":10}]"#
        let items = StoryPreloadPlan.items(for: [try story("a", layers: layers)], lowData: false)
        XCTAssertEqual(items, [
            .image(url("https://x.y/a.jpg")), .image(url("https://x.y/layer.png")), .warm(url("https://x.y/av-1.jpg")),
        ])
    }

    func testAVideoIsItsPosterThenItsPlayer() throws {
        let items = StoryPreloadPlan.items(for: [try story("v", kind: "video", poster: true, avatar: nil)], lowData: false)
        XCTAssertEqual(items, [.image(url("https://x.y/v-poster.jpg")), .video(url("https://x.y/v.mp4"))])
    }

    func testLowDataModeSkipsTheVideoButKeepsThePictures() throws {
        let stories = [try story("v", kind: "video", poster: true, avatar: nil), try story("a", avatar: nil)]
        let items = StoryPreloadPlan.items(for: stories, lowData: true)
        XCTAssertEqual(items, [.image(url("https://x.y/v-poster.jpg")), .image(url("https://x.y/a.jpg"))])
        XCTAssertFalse(items.contains { $0.isVideo })
    }

    /// The story on screen owns its player: the window never starts a second
    /// one for the clip that is playing.
    func testTheWindowLeavesTheCurrentVideoToTheViewer() throws {
        let current = try story("v", kind: "video", poster: true, avatar: nil)
        let next = try story("w", kind: "video", poster: true, avatar: nil)
        let items = StoryPreloadPlan.window(current: current, ahead: [next], lowData: false)
        XCTAssertEqual(items, [
            .image(url("https://x.y/v-poster.jpg")),
            .image(url("https://x.y/w-poster.jpg")), .video(url("https://x.y/w.mp4")),
        ])
    }

    func testTheTrayWarmsTheFirstThreeUnseenRings() throws {
        func ring(_ id: String, unseen: Bool) -> String {
            #"{"author":{"id":"\#(id)","displayName":"P"},"storyIds":["\#(id)-1","\#(id)-2"],"latestAt":"2026-10-14T10:00:00.000Z","expiresAt":"2026-10-15T10:00:00.000Z","unseen":\#(unseen),"hasCall":false}"#
        }
        let json = #"{"enabled":true,"canPost":true,"own":null,"firstRunHint":false,"items":[\#(ring("a", unseen: true)),\#(ring("b", unseen: false)),\#(ring("c", unseen: true)),\#(ring("d", unseen: true))]}"#
        let strip = try Coding.decoder.decode(StoryStrip.self, from: Data(json.utf8))
        // Only the first three rings count; a seen one has nothing new to open.
        XCTAssertEqual(StoryPreloadPlan.trayStoryIds(strip), ["a-1", "c-1"])
    }

    // MARK: - The window of the queue

    func testTheWindowIsTheCurrentThenTheNextTwoAcrossAuthorsThenTheNextAuthorsFirst() {
        var playback = StoryPlayback(people: [["a1", "a2", "a3"], ["b1", "b2"], ["c1"]])
        XCTAssertEqual(playback.windowIds, ["a1", "a2", "a3", "b1"])
        _ = playback.next()
        XCTAssertEqual(playback.windowIds, ["a2", "a3", "b1"], "The next author's first is already one of the next two")
        _ = playback.next()
        XCTAssertEqual(playback.windowIds, ["a3", "b1", "b2", ])
        _ = playback.next()
        XCTAssertEqual(playback.windowIds, ["b1", "b2", "c1"])
        _ = playback.next()
        _ = playback.next()
        XCTAssertEqual(playback.windowIds, ["c1"])
    }

    func testTheWindowWalksForwardWithoutNeedingTheWholeQueue() {
        var playback = StoryPlayback(people: [["a1"], [], ["b1", "b2"], ["c1"]])
        XCTAssertEqual(playback.people.count, 3, "An empty person is not a stop")
        XCTAssertEqual(playback.windowIds, ["a1", "b1", "b2"])
        _ = playback.next()
        XCTAssertEqual(playback.windowIds, ["b1", "b2", "c1"])
        _ = playback.next()
        _ = playback.next()
        XCTAssertEqual(playback.windowIds, ["c1"])
    }

    // MARK: - Running it

    /// A fetch the test lets go of by hand.
    final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var waiting: [URL: CheckedContinuation<Void, Never>] = [:]
        private var opened: Set<URL> = []
        func wait(_ url: URL) async {
            await withCheckedContinuation { continuation in
                lock.lock()
                if opened.contains(url) { lock.unlock(); continuation.resume(); return }
                waiting[url] = continuation
                lock.unlock()
            }
        }
        func open(_ url: URL) {
            lock.lock()
            opened.insert(url)
            let continuation = waiting.removeValue(forKey: url)
            lock.unlock()
            continuation?.resume()
        }
    }

    private func settle() async { try? await Task.sleep(for: .milliseconds(60)) }

    private func preloader(gate: Gate) -> StoryPreloader {
        let preloader = StoryPreloader()
        preloader.imageFetcher = { url in
            await gate.wait(url)
            UIGraphicsBeginImageContext(CGSize(width: 2, height: 2))
            defer { UIGraphicsEndImageContext() }
            UIColor.red.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: 2, height: 2))
            return UIGraphicsGetImageFromCurrentImageContext()
        }
        return preloader
    }

    func testNoMoreThanTwoRunAtOnceAndTheNextStartsWhenOneFinishes() async throws {
        let gate = Gate()
        let loader = preloader(gate: gate)
        let urls = (1...5).map { url("https://x.y/\($0).jpg") }
        loader.setWindow(urls.map { .image($0) })
        await settle()
        XCTAssertEqual(loader.started, urls.prefix(2).map { "img:" + $0.absoluteString })
        gate.open(urls[0])
        await settle()
        XCTAssertEqual(loader.started.count, 3, "One finished, the third took its place")
        XCTAssertNotNil(loader.image(for: urls[0]), "Decoded and kept")
        for u in urls { gate.open(u) }
        await settle()
        XCTAssertEqual(loader.started.count, 5)
        XCTAssertLessThanOrEqual(loader.peakConcurrent, 2)
    }

    func testWhatLeavesTheWindowIsCancelledAndWhatIsDoneIsNotFetchedAgain() async throws {
        let gate = Gate()
        let loader = preloader(gate: gate)
        let a = url("https://x.y/a.jpg"), b = url("https://x.y/b.jpg"), c = url("https://x.y/c.jpg")
        loader.setWindow([.image(a), .image(b)])
        await settle()
        gate.open(a)
        await settle()
        // The viewer moved on: b is out of the window, c is in.
        loader.setWindow([.image(a), .image(c)])
        await settle()
        XCTAssertEqual(loader.cancelled, ["img:" + b.absoluteString])
        XCTAssertEqual(loader.started, ["a", "b", "c"].map { "img:https://x.y/\($0).jpg" }, "a is already decoded and is not fetched twice")
        gate.open(c)
        await settle()
        XCTAssertNotNil(loader.image(for: c))
    }

    /// Low Data Mode filters what runs, not what is wanted: when it goes off
    /// again the videos the window still holds start without the caller asking.
    func testLowDataModeHoldsVideosBackAndLetsThemGoWhenItEnds() async throws {
        let gate = Gate()
        let loader = preloader(gate: gate)
        let video = url("https://x.y/v.mp4")
        let picture = url("https://x.y/p.jpg")
        loader.lowDataOverride = true
        loader.setWindow([.image(picture), .video(video)])
        await settle()
        XCTAssertEqual(loader.started, ["img:" + picture.absoluteString])
        loader.lowDataOverride = false
        loader.replan()
        await settle()
        XCTAssertTrue(loader.started.contains("vid:" + video.absoluteString))
    }

    func testClosingTheViewerCancelsEverything() async throws {
        let gate = Gate()
        let loader = preloader(gate: gate)
        loader.setWindow([.image(url("https://x.y/a.jpg")), .image(url("https://x.y/b.jpg"))])
        await settle()
        loader.clearWindow()
        XCTAssertEqual(loader.cancelled.count, 2)
    }

    /// A view that needs a picture now joins the preload that is already
    /// fetching it instead of fetching it a second time.
    func testAViewJoinsAPreloadInFlight() async throws {
        let gate = Gate()
        let loader = preloader(gate: gate)
        let a = url("https://x.y/a.jpg")
        loader.setWindow([.image(a)])
        await settle()
        let shown = Task { await loader.imageForDisplay(a) }
        await settle()
        gate.open(a)
        let image = await shown.value
        XCTAssertNotNil(image)
        XCTAssertEqual(loader.started.count, 1)
    }

    /// Short-lived means it: what aged out is gone, the cache has a ceiling,
    /// and the next account never sees the last one's.
    func testTheStoryCacheEvictsAndIsBoundedAndForgetsOnAccountChange() throws {
        let loader = StoryPreloader()
        loader.remember([try story("old")])
        XCTAssertNil(loader.cachedStory("old", now: Date().addingTimeInterval(StoryPreloader.storyTTL + 1)))
        XCTAssertNil(loader.cachedStory("old"), "An expired entry is dropped when it is found out, not kept")

        for index in 0..<(StoryPreloader.storyCap + 10) {
            loader.remember([try story("s\(index)")])
        }
        let kept = (0..<(StoryPreloader.storyCap + 10)).filter { loader.cachedStory("s\($0)") != nil }.count
        XCTAssertEqual(kept, StoryPreloader.storyCap)
        XCTAssertNotNil(loader.cachedStory("s\(StoryPreloader.storyCap + 9)"), "The newest stay")

        loader.reset()
        XCTAssertNil(loader.cachedStory("s\(StoryPreloader.storyCap + 9)"))
    }

    func testStoriesTheTrayReadAreKeptBrieflyForTheViewer() throws {
        let loader = StoryPreloader()
        let one = try story("a")
        loader.remember([one])
        XCTAssertEqual(loader.cachedStory("a")?.id, "a")
        XCTAssertNil(loader.cachedStory("a", now: Date().addingTimeInterval(StoryPreloader.storyTTL + 1)), "A story's roster and reaction move")
        XCTAssertNil(loader.cachedStory("zzz"))
    }
}
