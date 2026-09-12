import AVFoundation
import AVKit
import SwiftUI
import UIKit
import XCTest
@testable import pqp

/// The watch-party audience path: the two frames that describe a broadcast,
/// the URL a header-less player has to be handed, when that URL may and may
/// not be swapped under a running player, and the seat nobody takes.
final class WatchPartyTests: XCTestCase {

    // MARK: - The wire

    private func firstEvent(from frame: String) async -> RealtimeEvent? {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        let collected = Collected()
        let pump = Task { for await event in stream { await collected.append(event) } }
        await client.ingest(Data(frame.utf8))
        try? await Task.sleep(for: .milliseconds(200))
        pump.cancel()
        return await collected.events.first
    }

    private actor Collected {
        var events: [RealtimeEvent] = []
        func append(_ event: RealtimeEvent) { events.append(event) }
    }

    func testChannelLiveCarriesTheStreamAndTheSeatlessHeadcount() async throws {
        let event = await firstEvent(from: """
        {"type":"channel-live","channelId":"c1","watching":212,
         "stream":{"hlsUrl":"/api/voice/hls-playlist/c1/1757000000000?t=tok",
                   "startedAt":1757000000000,"presenterPeerId":"p1",
                   "delaySeconds":9,"topHeight":720}}
        """)
        guard case .channelLive(let channelId, let stream, let watching) = event else {
            return XCTFail("expected channelLive, got \(String(describing: event))")
        }
        XCTAssertEqual(channelId, "c1")
        XCTAssertEqual(watching, 212)
        XCTAssertEqual(stream?.startedAt, 1_757_000_000_000)
        XCTAssertEqual(stream?.presenterPeerId, "p1")
        XCTAssertEqual(stream?.delaySeconds, 9)
        XCTAssertEqual(stream?.hlsUrl, "/api/voice/hls-playlist/c1/1757000000000?t=tok")
    }

    /// A stop is `stream: null`, and it has to survive as a decoded event
    /// rather than as a frame that failed to parse: the difference is a viewer
    /// told the party ended and a viewer left in front of a frozen frame.
    func testANullStreamIsAStopAndNotADecodeFailure() async throws {
        let event = await firstEvent(from: """
        {"type":"channel-live","channelId":"c1","stream":null,"watching":0}
        """)
        guard case .channelLive(let channelId, let stream, let watching) = event else {
            return XCTFail("expected channelLive, got \(String(describing: event))")
        }
        XCTAssertEqual(channelId, "c1")
        XCTAssertNil(stream)
        XCTAssertEqual(watching, 0)
    }

    /// The room's copy. Same object, no headcount, and it must not be confused
    /// for the channel one: only `channel-live` reaches somebody without a seat.
    func testVoiceStreamDecodesAsTheRoomsOwnFrame() async throws {
        let event = await firstEvent(from: """
        {"type":"voice-stream","channelId":"c9",
         "stream":{"hlsUrl":"https://cdn.example/live.m3u8",
                   "startedAt":42,"presenterPeerId":"p2"}}
        """)
        guard case .voiceStream(let channelId, let stream) = event else {
            return XCTFail("expected voiceStream, got \(String(describing: event))")
        }
        XCTAssertEqual(channelId, "c9")
        XCTAssertEqual(stream?.hlsUrl, "https://cdn.example/live.m3u8")
        XCTAssertNil(stream?.delaySeconds)
    }

    // MARK: - The URL a header-less player is handed

    /**
     THE TOKEN HAS TO SURVIVE THE JOIN.

     `hlsUrl` is API-relative by default and the `?t=` on it is the ENTIRE
     authorisation: the proxy serves a request with no `Authorization` header
     when that token verifies, which is the only way `AVPlayer` can fetch a
     playlist at all. Dropping the query while resolving the path produces a
     URL that looks right, 401s, and shows a black rectangle with no error
     anybody reads.
     */
    func testARelativePathResolvesAgainstTheApiAndKeepsItsToken() {
        let url = liveStreamURL(
            hlsUrl: "/api/voice/hls-playlist/c1/1757000000000?t=abc.def-_",
            apiBaseURL: URL(string: "https://api.pqp.gg")!
        )
        XCTAssertEqual(
            url?.absoluteString,
            "https://api.pqp.gg/api/voice/hls-playlist/c1/1757000000000?t=abc.def-_"
        )
        XCTAssertEqual(
            URLComponents(url: url!, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "t" })?.value,
            "abc.def-_"
        )
    }

    /// The operator can serve playlists straight from a public bucket
    /// (`LIVE_HLS_SIGNED_URLS=false`), and then the URL is already whole.
    func testAnAbsoluteUrlIsUsedAsItStands() {
        let url = liveStreamURL(
            hlsUrl: "https://cdn.example/live/x.m3u8?sig=1",
            apiBaseURL: URL(string: "https://api.pqp.gg")!
        )
        XCTAssertEqual(url?.absoluteString, "https://cdn.example/live/x.m3u8?sig=1")
    }

    func testAnEmptyAddressIsNotAUrl() {
        XCTAssertNil(liveStreamURL(hlsUrl: "  ", apiBaseURL: URL(string: "https://a.b")!))
    }

    // MARK: - When the player may be restarted, and when it may not

    private func stream(_ startedAt: Int, _ token: String) -> LiveHlsStream {
        LiveHlsStream(
            hlsUrl: "/api/voice/hls-playlist/c1/\(startedAt)?t=\(token)",
            startedAt: startedAt, presenterPeerId: "p1",
            delaySeconds: nil, topHeight: nil, topFramerate: nil
        )
    }

    func testNothingPlayingAttachesTheStreamAtOnce() {
        let move = WatchStreamSwap.next(
            attached: nil, latest: stream(1, "a"), failed: false, now: Date()
        )
        XCTAssertEqual(move, .attach(stream(1, "a")))
    }

    /**
     THE ONE THAT MATTERS ON SATURDAY.

     A seatless viewer receives a `channel-live` every thirty seconds for the
     whole party, each carrying a newly minted `?t=`, so `hlsUrl` is a
     different string every time while the picture behind it never changed.
     Treating a changed URL as a reason to re-attach means a new
     `AVPlayerItem` twice a minute: a black frame, a re-buffer and the live
     edge lost, over and over, for the length of a film. It reads as a bad
     connection, so nobody reports it as a bug.
     */
    func testAFreshTokenForTheSameBroadcastDoesNotRestartThePlayer() {
        let attached = AttachedStream(startedAt: 1, attachedAt: Date())
        let move = WatchStreamSwap.next(
            attached: attached,
            latest: stream(1, "a-brand-new-token"),
            failed: false, now: Date().addingTimeInterval(30)
        )
        XCTAssertEqual(move, .keep)
    }

    /// A host who stopped and started again is a different session, and the
    /// playlist we hold ended with `#EXT-X-ENDLIST`. Keeping it is a still frame.
    func testARestartedBroadcastIsAttached() {
        let attached = AttachedStream(startedAt: 1, attachedAt: Date())
        let move = WatchStreamSwap.next(
            attached: attached, latest: stream(2, "a"), failed: false, now: Date()
        )
        XCTAssertEqual(move, .attach(stream(2, "a")))
    }

    func testAStoppedBroadcastDetaches() {
        let attached = AttachedStream(startedAt: 1, attachedAt: Date())
        XCTAssertEqual(
            WatchStreamSwap.next(attached: attached, latest: nil, failed: false, now: Date()),
            .detach
        )
        XCTAssertEqual(
            WatchStreamSwap.next(attached: nil, latest: nil, failed: false, now: Date()),
            .detach
        )
    }

    func testAFailureReattachesToTheFreshestUrl() {
        let attached = AttachedStream(startedAt: 1, attachedAt: Date())
        let move = WatchStreamSwap.next(
            attached: attached, latest: stream(1, "fresher"), failed: true, now: Date()
        )
        XCTAssertEqual(move, .attach(stream(1, "fresher")))
    }

    /**
     A film is longer than the token.

     `HLS_VIEWER_TOKEN_TTL_MS` is one hour, this player refetches the same URL
     for the whole watch, and there is no way to hand a running `AVPlayerItem`
     a new one. So the swap has to happen before the token dies, and the
     renewal has to sit strictly inside the server's TTL rather than on it.
     */
    func testTheTokenIsRenewedBeforeTheServerStopsHonouringIt() {
        let start = Date()
        let attached = AttachedStream(startedAt: 1, attachedAt: start)
        XCTAssertEqual(
            WatchStreamSwap.next(
                attached: attached, latest: stream(1, "x"), failed: false,
                now: start.addingTimeInterval(WatchStreamSwap.renewAfter - 1)
            ),
            .keep, "renewed early, so every viewer re-buffers for nothing"
        )
        XCTAssertEqual(
            WatchStreamSwap.next(
                attached: attached, latest: stream(1, "x"), failed: false,
                now: start.addingTimeInterval(WatchStreamSwap.renewAfter)
            ),
            .attach(stream(1, "x"))
        )
    }

    func testRenewalIsInsideTheServersOneHourTtl() {
        // Mirrors `HLS_VIEWER_TOKEN_TTL_MS` in
        // `server/src/voice/hls-viewer-token.ts`. A renewal at or past the TTL
        // is a dead player halfway through the film.
        XCTAssertLessThan(WatchStreamSwap.renewAfter, 60 * 60)
    }

    // MARK: - A picture that stopped without anybody being told

    func testAPlayerWhoseClockStopsIsEventuallyDeclaredStalled() {
        var watch = WatchStallWatch()
        let start = Date()
        XCTAssertFalse(watch.tick(position: 10, isPlaying: true, now: start))
        XCTAssertFalse(watch.tick(
            position: 10, isPlaying: true,
            now: start.addingTimeInterval(WatchStallWatch.deadAfter - 1)
        ))
        XCTAssertTrue(watch.tick(
            position: 10, isPlaying: true,
            now: start.addingTimeInterval(WatchStallWatch.deadAfter)
        ))
    }

    /// Buffering is slow, not dead, and restarting a player that is filling
    /// its buffer makes the buffering worse.
    func testBufferingIsNotAStall() {
        var watch = WatchStallWatch()
        let start = Date()
        XCTAssertFalse(watch.tick(position: 10, isPlaying: false, now: start))
        XCTAssertFalse(watch.tick(
            position: 10, isPlaying: false,
            now: start.addingTimeInterval(WatchStallWatch.deadAfter * 3)
        ))
    }

    func testTimeMovingResetsTheClock() {
        var watch = WatchStallWatch()
        let start = Date()
        _ = watch.tick(position: 10, isPlaying: true, now: start)
        XCTAssertFalse(watch.tick(
            position: 11, isPlaying: true,
            now: start.addingTimeInterval(WatchStallWatch.deadAfter - 1)
        ))
        XCTAssertFalse(watch.tick(
            position: 11, isPlaying: true,
            now: start.addingTimeInterval(WatchStallWatch.deadAfter + 1)
        ), "the clock restarted when the picture moved, so this is 2 s of stall")
    }

    /// Answered once per stall. A caller that reattaches must not be told
    /// again on the next tick, before the new item has had a chance to decode.
    func testAStallIsAnnouncedOnce() {
        var watch = WatchStallWatch()
        let start = Date()
        _ = watch.tick(position: 10, isPlaying: true, now: start)
        let dead = start.addingTimeInterval(WatchStallWatch.deadAfter)
        XCTAssertTrue(watch.tick(position: 10, isPlaying: true, now: dead))
        XCTAssertFalse(watch.tick(position: 10, isPlaying: true, now: dead.addingTimeInterval(1)))
    }

    // MARK: - Waiting, and having missed it

    @MainActor
    func testNoStreamYetIsNotTheSameSentenceAsItEnded() {
        XCTAssertEqual(WatchModel.phase(stream: nil, sawStream: false), .idle)
        XCTAssertEqual(WatchModel.phase(stream: nil, sawStream: true), .ended)
        XCTAssertEqual(WatchModel.phase(stream: stream(1, "a"), sawStream: false), .live)
        XCTAssertEqual(WatchModel.phase(stream: stream(1, "a"), sawStream: true), .live)
    }

    // MARK: - The seat nobody takes

    private var sources: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Sources")
    }

    /**
     THE AUDIENCE PATH IS SEATLESS, AND THIS IS WHAT SAYS SO.

     The whole economics of a watch party is that a watcher costs one socket in
     a set rather than a participant on the media server. The way that breaks
     is not a wrong answer, it is a plausible-looking `join(...)` added later by
     somebody who reasonably assumed watching a voice channel means being in it,
     and it would not show up until six hundred people arrived at once.

     So the model that watches is pinned to send `watch-live` and to contain no
     join at all. There is no runtime test for this: joining works, and a room
     of one tester cannot tell a seat from a subscription.
     */
    func testTheWatchingModelSubscribesAndNeverTakesASeat() throws {
        let source = try String(
            contentsOf: sources.appending(path: "Voice/WatchModel.swift"), encoding: .utf8
        )
        XCTAssertTrue(
            source.contains("watchLive(channelId:"),
            "the audience path must send `watch-live`"
        )
        for seat in ["joinVoice(", "join-voice-room", "LiveKitVoiceClient", "VoiceClient("] {
            XCTAssertFalse(
                source.contains(seat),
                "a watcher must not \(seat): that is a seat on the media server"
            )
        }
    }

    /// The frame as `watchLiveMessageSchema` declares it. A key spelled
    /// differently is a frame the server drops in silence, which reads exactly
    /// like a viewer count that does not work.
    func testTheWatchLiveFrameMatchesTheSharedSchema() throws {
        let source = try String(
            contentsOf: sources.appending(path: "Core/RealtimeClient.swift"), encoding: .utf8
        )
        XCTAssertTrue(source.contains("\"type\": \"watch-live\", \"channelId\": channelId, \"watching\": watching"))
    }

    /// A seat suppresses the player rather than merely hiding it: somebody in
    /// the call already has the presenter's screen as a WebRTC track with its
    /// own audio, and the HLS of the same broadcast is the same film twice,
    /// eight seconds apart, both audible.
    func testASeatSuppressesThePlayer() throws {
        let source = try String(
            contentsOf: sources.appending(path: "Voice/WatchStageView.swift"), encoding: .utf8
        )
        XCTAssertTrue(source.contains("guard !isSeated else { return }"))
        XCTAssertTrue(source.contains("if seated { tearDown() }"))
    }

    // MARK: - The audio session

    /**
     The player must never take the microphone from a call.

     Tested on the predicate rather than on `AVAudioSession` itself: a
     simulator grants categories a phone would refuse, so the honest version of
     this test passes for the wrong reason on the one machine that runs it.
     */
    func testThePlayerRefusesTheSessionWhileSomebodyHoldsAMicrophone() {
        XCTAssertTrue(WatchAudioSession.wouldInterruptACall(.playAndRecord))
        XCTAssertTrue(WatchAudioSession.wouldInterruptACall(.record))
        XCTAssertFalse(WatchAudioSession.wouldInterruptACall(.playback))
        XCTAssertFalse(WatchAudioSession.wouldInterruptACall(.ambient))
    }

    /// Background audio is a build setting as much as a line of Swift: without
    /// `audio` in `UIBackgroundModes` the policy below is ignored and the
    /// sound stops the moment the phone locks.
    func testTheAppDeclaresBackgroundAudio() throws {
        let modes = Bundle(for: Self.self).infoDictionary?["UIBackgroundModes"] as? [String]
            ?? (Bundle.main.infoDictionary?["UIBackgroundModes"] as? [String])
        XCTAssertEqual(modes?.contains("audio"), true, "background audio is not declared")
    }

    func testThePlayerKeepsPlayingWhenTheAppLeavesTheScreen() throws {
        let source = try String(
            contentsOf: sources.appending(path: "Voice/WatchStageView.swift"), encoding: .utf8
        )
        XCTAssertTrue(
            source.contains("audiovisualBackgroundPlaybackPolicy = .continuesIfPossible"),
            "without this the picture and the sound stop when the phone locks"
        )
    }

    /// THE SYSTEM TRANSPORT BAR IS THE UGLY PLAYER.
    ///
    /// `AVPlayerViewController` draws a scrubber on a live window and a
    /// generic LIVE badge. The picture is an `AVPlayerLayer`; the chrome is
    /// `WatchOverlay`. A later change that hands the rectangle back to the
    /// system player is how this becomes the Videos app again.
    func testThePictureIsAPlayerLayerWithOurChrome() throws {
        let surface = try String(
            contentsOf: sources.appending(path: "Voice/WatchVideoSurface.swift"), encoding: .utf8
        )
        let stage = try String(
            contentsOf: sources.appending(path: "Voice/WatchStageView.swift"), encoding: .utf8
        )
        XCTAssertTrue(surface.contains("AVPlayerLayer"))
        XCTAssertFalse(
            surface.contains("AVPlayerViewController"),
            "the system player is the chrome this replaced"
        )
        XCTAssertTrue(stage.contains("WatchOverlay"))
        XCTAssertFalse(stage.contains("showsPlaybackControls"))
        XCTAssertTrue(
            stage.contains("wantsPlayback: userWantsPlayback"),
            "a seek-to-live must follow the chrome, not player.rate"
        )
        XCTAssertFalse(
            stage.contains("wantsPlayback: player.rate"),
            "rate drops on a pause nobody asked for; treating that as pause left build 23 frozen"
        )
        // A rung switch that rebuilds the player is a one second black frame
        // dressed up as a quality picker. The same write of an unchanged
        // ceiling also pauses the picture, so a no-op must not touch the item.
        XCTAssertTrue(stage.contains("preferredMaximumResolution != resolution"))
        if let apply = stage.range(of: "private func applyQuality(trigger") {
            let rest = stage[apply.lowerBound...]
            if let end = rest.range(of: "\n    private func ") {
                XCTAssertFalse(
                    rest[..<end.lowerBound].contains("attach("),
                    "applyQuality must retune the item, never rebuild the player"
                )
            } else {
                XCTFail("could not bound applyQuality")
            }
        } else {
            XCTFail("applyQuality is gone")
        }
        XCTAssertTrue(
            stage.contains("automaticallyWaitsToMinimizeStalling = true"),
            "waiting off is the one-frame freeze: decode, sit, never recover"
        )
        let theater = try String(
            contentsOf: sources.appending(path: "Voice/WatchTheater.swift"), encoding: .utf8
        )
        XCTAssertTrue(
            theater.contains("WatchOrientation.enterTheater()"),
            "fullscreen has to unlock landscape; the app is portrait everywhere else"
        )
        XCTAssertTrue(
            theater.contains("AVPlayerViewController"),
            "theater is AVKit fullscreen, not a SwiftUI cover over the chat"
        )
        XCTAssertTrue(
            theater.contains("showsPlaybackControls = false"),
            "the system transport bar is the chrome this replaced"
        )
        XCTAssertTrue(
            stage.contains("chromeInsets: isTheater ? chromeInsets"),
            "theater chrome has to clear the island, not sit under it"
        )
        XCTAssertTrue(
            stage.contains("WatchTheaterPresenter"),
            "the cover from the chat inset left the transcript in the layout"
        )
        // `testFullscreenAllowsTheTallestRungAgain` has always passed, and
        // build 28 still wrote a phone-strip ceiling the moment the theater
        // opened: that test feeds `resolutionCap` a fullscreen rectangle
        // nothing in the app ever produced, because `WatchVideoSurface` is
        // removed for the whole of fullscreen and it is the only thing that
        // reports a size. This is the missing half, that the product supplies
        // the number the pure rule is tested with.
        XCTAssertTrue(
            stage.contains("WatchOrientation.screenPixels"),
            "the theater has to say how big it is; nothing else measures it"
        )
        let push = try String(
            contentsOf: sources.appending(path: "Core/PushNotifications.swift"), encoding: .utf8
        )
        XCTAssertTrue(
            push.contains("supportedInterfaceOrientationsFor"),
            "UIKit never asks WatchOrientation unless the app delegate answers"
        )
        XCTAssertTrue(push.contains("WatchOrientation.allowed"))
    }

    /**
     THE ONE-WAY DOOR, AND WHY A TEXT TEST COULD NOT SEE IT.

     Build 28 reached TestFlight with a fullscreen nobody could leave: a still
     frame that answered a pinch and nothing else. Every assertion above was
     green for it, because every one of them reads the source. The defect was
     one `if let` that fell through at runtime, `contentOverlayView` being nil
     until the controller's view is loaded, so the cinema chrome, which is the
     only thing in the theater that can dismiss it (the system transport bar
     is deliberately off), was built and never added to anything.

     So this one runs the code. No window and no presentation are needed for
     the half that failed, which is why `makeTheater` is separate from
     `presentIfNeeded`.
     */
    @MainActor
    func testTheTheaterMountsTheChromeThatIsTheWayBackOut() throws {
        let anchor = WatchTheaterAnchor()
        let controller = anchor.makeTheater(player: AVPlayer(), overlay: Color.clear)
        let host = try XCTUnwrap(anchor.overlayHost, "the theater built no chrome at all")
        XCTAssertTrue(
            host.view.isDescendant(of: controller.view),
            "chrome that is not in the hierarchy is a fullscreen with no exit"
        )
        XCTAssertIdentical(host.parent, controller)
        XCTAssertTrue(
            host.view.isUserInteractionEnabled,
            "the X, play and the quality menu are buttons; they have to take touches"
        )
        XCTAssertFalse(
            controller.showsPlaybackControls,
            "our chrome replaced the system bar, which is why losing it strands somebody"
        )
        XCTAssertFalse(
            controller.allowsPictureInPicturePlayback,
            "PiP lives on the inline layer; two controllers on one player is two owners"
        )
    }

    // MARK: - Telling a watch party apart from a voice channel

    /**
     THE REPORT FROM A REAL PHONE, IN ONE SENTENCE: "watch party shows as a
     regular voice channel".

     It did. `isVoice` is true for both types, which is deliberate and load
     bearing (a party has a roster, a transcript and a room), and until this it
     was the ONLY question the app asked, so the two types were the same type
     everywhere a person could see. This is the predicate that separates them,
     and it is asked by the glyph, the section heading, the seat the toolbar
     offers and the empty stage.
     */
    func testAWatchPartyIsAVoiceRoomAndStillNotAVoiceChannel() {
        let party = ChannelFixture.make(type: "watch_party")
        let voice = ChannelFixture.make(type: "voice")
        let text = ChannelFixture.make(type: "text")

        XCTAssertTrue(party.isVoice, "a party still joins, rosters and transcribes as a room")
        XCTAssertTrue(party.isWatchParty)
        XCTAssertTrue(voice.isVoice)
        XCTAssertFalse(voice.isWatchParty, "an ordinary call must not grow a film poster")
        XCTAssertFalse(text.isWatchParty)
    }

    /// An unknown future type must not become a watch party by accident: the
    /// app decodes `type` as a plain string, so anything at all can arrive.
    func testAnUnknownChannelTypeIsNotAWatchParty() {
        XCTAssertFalse(ChannelFixture.make(type: "forum").isWatchParty)
    }

    /**
     THE GLYPH HAS TO EXIST.

     `Image(systemName:)` for a symbol this OS does not have renders nothing
     and reports nothing, so a wrong name is a channel row with a hole in it
     and no failure anywhere. The web draws a clapperboard for this type and
     `movieclapper.fill` is its SF Symbols equivalent (SF Symbols 5, iOS 17,
     which is this app's floor).
     */
    func testTheWatchPartyGlyphResolvesOnThisOs() {
        XCTAssertNotNil(
            UIImage(systemName: "movieclapper.fill"),
            "the channel row would draw an empty box and say nothing about it"
        )
    }

    /**
     THE CHANNEL LIST DRAWS A PARTY AS A PARTY.

     Source-read rather than rendered, and the honest reason is that a SwiftUI
     body is not inspectable from a unit test in this project. What it can do
     is fail when somebody deletes the branch, which is exactly how the type
     came to be invisible in build 21: nothing anywhere claimed it should look
     different, so nothing noticed that it did not.
     */
    func testTheChannelListGivesAPartyItsOwnGlyphAndItsOwnSection() throws {
        let source = try String(
            contentsOf: sources.appending(path: "Chat/ChannelListView.swift"), encoding: .utf8
        )
        XCTAssertTrue(
            source.contains("if channel.isWatchParty { return \"movieclapper.fill\" }"),
            "a party drawn with the speaker glyph is a party nobody can find"
        )
        XCTAssertTrue(
            source.contains("String(localized: \"Watch party\")"),
            "the section heading is the other half of telling the two apart"
        )
        XCTAssertTrue(
            source.contains("channels.filter(\\.isWatchParty)"),
            "the party section has to be built from the type"
        )
        XCTAssertTrue(
            source.contains("channels.filter { !$0.isWatchParty }"),
            "and filtered out of Voice, or it is listed twice"
        )
    }

    /**
     AN EMPTY WATCH PARTY IS STILL A WATCH PARTY.

     Nothing is streaming most of the week, and `EmptyView()` for that case
     made the channel identical to a voice channel on the screen as well as in
     the list. The card is what a person sees when they arrive early, which on
     the night is most of the audience.

     Both halves are asserted: that the empty case draws something, and that it
     is gated on the type. This view is mounted over EVERY voice channel's
     transcript, so an ungated card would put a film poster on every call in
     the server.
     */
    func testAnEmptyStageSaysWatchPartyAndOnlyInAWatchParty() throws {
        let source = try String(
            contentsOf: sources.appending(path: "Voice/WatchStageView.swift"), encoding: .utf8
        )
        XCTAssertTrue(
            source.contains("case .unknown, .idle:"),
            "waiting and nothing-yet are one card, not two sentences half a second apart"
        )
        XCTAssertTrue(
            source.contains("if channel.isWatchParty {"),
            "an ordinary voice channel must stay inert"
        )
        XCTAssertTrue(
            source.contains("Nobody is streaming yet."),
            "the empty state has to be a sentence, not a blank"
        )
    }

    /**
     THE SEAT NOBODY IS OFFERED, WHICH IS THE OTHER HALF OF THE SEAT NOBODY
     TAKES.

     `WatchModel` never joins, and that has a test above. It did not stop the
     app inviting a seat: the chat toolbar drew a green phone on every channel
     `isVoice` answered yes to, so the single most obvious control on a watch
     party was "become a participant on the media box". Six hundred people
     arriving at once is the design constraint the whole feature is built on
     and it was one tap from being six hundred seats.

     Asserted on the guard rather than on the button: the button is correct and
     stays, for voice channels.
     */
    func testTheChatToolbarDoesNotOfferASeatInAWatchParty() throws {
        let source = try String(
            contentsOf: sources.appending(path: "Chat/ChatView.swift"), encoding: .utf8
        )
        XCTAssertTrue(
            source.contains("if let voiceChannel, !voiceChannel.isWatchParty {"),
            "watching is seatless, and a green phone button is how that stops being true"
        )
        XCTAssertTrue(
            source.contains("WatchHeroPreference"),
            "a live picture is the hero; the nav bar fill has to get out of the way"
        )
    }

    /**
     THE PILL IN THE LIST FOLLOWS THE STREAM, INCLUDING DOWNWARDS.

     A `channel-live` with `stream: null` is a stop. A badge that survives the
     end of the show walks people into an empty room, which is worse than no
     badge at all.
     */
    func testTheListPillIsClearedWhenTheStreamStops() throws {
        let source = try String(
            contentsOf: sources.appending(path: "Chat/ChannelListView.swift"), encoding: .utf8
        )
        XCTAssertTrue(source.contains("case .channelLive(let channelId, let stream, _):"))
        XCTAssertTrue(source.contains("liveChannels.remove(channelId)"))
        XCTAssertTrue(source.contains("liveChannels.insert(channelId)"))
    }
}

private enum ChannelFixture {
    static func make(type: String) -> Channel {
        let json = """
        {"id":"c1","serverId":"s1","kind":"server","name":"sessao-de-sabado",
         "type":"\(type)","position":0,"isPrivate":false,"topic":null,
         "imageUrl":null,"parentId":null}
        """
        // Force-tried: a fixture that cannot decode is a broken test.
        return try! Coding.decoder.decode(Channel.self, from: Data(json.utf8))
    }
}
