import AVFoundation
import UIKit
import XCTest

@testable import pqp

/**
 The two things the watch player gained after a real phone watched a real
 party: a way back into a live window it had fallen out of, and a ladder it can
 tell a viewer about.

 Both halves are pure on purpose. A simulator has no broadcast, `AVPlayer` will
 not starve on demand, and a test that drove a real one would be a test of the
 network. So the decisions live in `WatchLiveEdge` and `WatchLadder`, which
 take numbers and return answers, and the view is left holding only the wiring
 that reads those numbers off `AVPlayerItem`.
 */
final class WatchLivePlayerTests: XCTestCase {
    /// Ten seconds, which is what production actually publishes: five two
    /// second segments, measured repeatedly against both rungs on 2026-09-09.
    private let window = WatchLiveWindow(start: 100, end: 110)
    private let now = Date(timeIntervalSince1970: 1_000_000)

    // MARK: - Falling out of the back of a ten second window

    /// THE FAILURE THIS WAS BUILT FOR. A playhead behind the oldest segment
    /// the playlist still lists names a time nothing can serve. `play()` is
    /// powerless there and only a seek is not, so this must answer on the
    /// first tick rather than after a clock.
    func testAPlayheadBehindTheWindowIsPutBackInsideItAtOnce() {
        var edge = WatchLiveEdge()
        let remedy = edge.tick(
            position: 98, window: window, wantsPlayback: true, isWaiting: true, now: now
        )
        XCTAssertEqual(remedy, .rejoin(104))
    }

    /// On a ten second window, eight seconds back from the edge is only
    /// two seconds from the back. That is the one-frame stall: land, fall
    /// out, seek, one frame. Four seconds of runway from the back wins.
    func testTheTargetLeavesRunwayOnAShortWindow() {
        XCTAssertEqual(WatchLiveEdge.target(in: window), 104)
        XCTAssertNotEqual(WatchLiveEdge.target(in: window), window.end)
        XCTAssertNotEqual(
            WatchLiveEdge.target(in: window), window.end - WatchLiveEdge.liveTargetOffset,
            "end-minus-offset alone sits on the last two seconds of a ten second playlist"
        )
    }

    /// MEASURED FROM THE END, NOT FROM THE START, and this is the case that
    /// proves why. `seekableTimeRanges` is not guaranteed to be only the
    /// current playlist window; where it grows with the session, a target
    /// measured from the front is a seek back to the opening credits.
    func testTheTargetIsMeasuredFromTheEndSoAGrowingRangeStillLandsNearLive() {
        let union = WatchLiveWindow(start: 0, end: 3600)
        XCTAssertEqual(WatchLiveEdge.target(in: union), 3592)
    }

    /// Once the playlist holds half a minute, eight seconds from the edge
    /// already leaves runway, so the offset wins over the floor.
    func testAWideWindowLandsAtTheOffset() {
        let wide = WatchLiveWindow(start: 100, end: 130)
        XCTAssertEqual(WatchLiveEdge.target(in: wide), 122)
    }

    /// The first seconds of a broadcast are a window shorter than the offset.
    /// Seeking six seconds back from a one second window is a seek before the
    /// start of everything that exists.
    func testTheTargetIsClampedInsideAWindowShorterThanTheOffset() {
        let young = WatchLiveWindow(start: 0, end: 1)
        XCTAssertEqual(WatchLiveEdge.target(in: young), 0)
    }

    // MARK: - Drift, which a stall leaves behind even after it ends

    /**
     THE SECOND HALF OF THE REPORT: "it's so choppy it got very delayed".

     `AVPlayer` resumes where it stopped, which is right for a recording and
     wrong for a broadcast: every stall adds its own length to the distance
     behind live and none of it is paid back. Six of them is minutes, and
     minutes behind on a watch party is the chat discussing a scene the viewer
     has not reached.

     The rule is on the distance rather than on the reason, so it pays back a
     stall, a Siri interruption, a lift and a backgrounded app with one
     mechanism.
     */
    func testDriftIsCaughtUpEvenWhenTheWindowItselfIsHealthy() {
        var edge = WatchLiveEdge()
        let union = WatchLiveWindow(start: 0, end: 600)
        // Ten seconds behind is the badge's business, not the player's.
        XCTAssertEqual(
            edge.tick(
                position: 590, window: union, wantsPlayback: true, isWaiting: false, now: now
            ),
            .none
        )
        // Three quarters of a minute is not.
        XCTAssertEqual(
            edge.tick(
                position: 600 - WatchLiveEdge.catchUpAfter,
                window: union,
                wantsPlayback: true,
                isWaiting: false,
                now: now
            ),
            .rejoin(592)
        )
    }

    /// The offer comes long before the insistence. A jump mid sentence is
    /// jarring, so the viewer gets the button first and is only overruled once
    /// being left behind is clearly worse.
    func testTheBadgeOffersLongBeforeThePlayerInsists() {
        XCTAssertLessThan(WatchLiveEdge.behindBy, WatchLiveEdge.catchUpAfter)
        XCTAssertGreaterThan(WatchLiveEdge.catchUpAfter, 30)
    }

    /// MORE BUFFER IS MORE DELAY, which is the thing being complained about.
    /// The landing place is three segments back and must stay in that region;
    /// this is here to make an "increase the buffer" change fail rather than
    /// ship.
    func testTheAnswerToDriftIsNotABiggerBuffer() {
        XCTAssertLessThanOrEqual(
            WatchLiveEdge.liveTargetOffset, 8,
            "the recovery point must stay near the live edge, not further from it"
        )
    }

    func testHowFarBehindIsMeasuredAndNeverNegative() {
        XCTAssertEqual(
            WatchLiveEdge.secondsBehindLive(position: 102, window: window), 8
        )
        XCTAssertEqual(
            WatchLiveEdge.secondsBehindLive(position: 120, window: window), 0,
            "past the edge is a rounding artefact, not time travel"
        )
        XCTAssertEqual(WatchLiveEdge.secondsBehindLive(position: 104, window: nil), 0)
    }

    // MARK: - The delay readout

    /**
     A CONSTANT READ FROM CONFIGURATION IS A LIE THE MOMENT ANYBODY DRIFTS.

     `delaySeconds` off the wire is the pipeline: capture, encode, segment,
     upload, the same for everybody. Showing it alone told a viewer two
     minutes behind that they were ten seconds behind, and they found out from
     the chat spoiling the film.
     */
    func testTheDelayShownIsThePipelinePlusThisViewersOwnDrift() {
        XCTAssertEqual(
            WatchDelay.seconds(pipeline: 10, position: 102, window: window), 18,
            "ten of pipeline plus eight of distance from the live edge"
        )
        XCTAssertEqual(
            WatchDelay.seconds(
                pipeline: 10, position: 480, window: WatchLiveWindow(start: 0, end: 600)
            ),
            130,
            "and it grows with the drift rather than staying at ten"
        )
    }

    /// Before a window exists there is nothing to measure, and the pipeline
    /// figure alone is honest: it is the delay everybody has.
    func testWithNoWindowYetThePipelineFigureStandsAlone() {
        XCTAssertEqual(WatchDelay.seconds(pipeline: 10, position: 0, window: nil), 10)
        XCTAssertNil(WatchDelay.seconds(pipeline: nil, position: 0, window: nil))
        XCTAssertEqual(
            WatchDelay.seconds(pipeline: nil, position: 104, window: window), 6,
            "a broadcast that declared no pipeline delay still reports the drift"
        )
    }

    // MARK: - Patience, and the end of it

    func testAPlayerThatIsPlayingNormallyIsLeftAlone() {
        var edge = WatchLiveEdge()
        for second in 0..<60 {
            let remedy = edge.tick(
                position: 105,
                window: window,
                wantsPlayback: true,
                isWaiting: false,
                now: now.addingTimeInterval(Double(second))
            )
            XCTAssertEqual(remedy, .none, "at second \(second)")
        }
    }

    /// Buffering is not a fault. A player waiting for media DEEP in the
    /// window is doing the right thing and seeking it would make the
    /// buffering worse, so the clock has to run out first. The tip has its
    /// own, shorter, clock — see `testAStarveOnTheLiveTipRejoinsQuickly`.
    func testAShortStarveIsPatienceAndALongOneIsARejoin() {
        var edge = WatchLiveEdge()
        var last = WatchLiveRemedy.none
        // Five seconds behind live: inside the window, not on the tip.
        let deep: Double = 105
        for second in 0...11 {
            last = edge.tick(
                position: deep,
                window: window,
                wantsPlayback: true,
                isWaiting: true,
                now: now.addingTimeInterval(Double(second))
            )
            XCTAssertEqual(last, .none, "at second \(second), still inside the allowance")
        }
        // TWELVE, WRITTEN OUT. The first version of this line built its
        // deadline from `WatchLiveEdge.starvedAfter`, so it moved with the
        // constant: stretching the allowance to ten minutes changed nothing
        // and the whole suite stayed green. A test parameterised by the thing
        // it is meant to pin does not pin it.
        last = edge.tick(
            position: deep, window: window, wantsPlayback: true, isWaiting: true,
            now: now.addingTimeInterval(12)
        )
        XCTAssertEqual(last, .rejoin(104))
    }

    /// THE iOS STALL, on a window wide enough that a seek still leaves
    /// runway. Waiting one second from the live edge is waiting for a
    /// segment that has not been written. Two and a half seconds is one
    /// late segment, then a seek back to the landing place.
    func testAStarveOnTheLiveTipRejoinsQuicklyWhenTheWindowIsWide() {
        let wide = WatchLiveWindow(start: 100, end: 130)
        var edge = WatchLiveEdge()
        XCTAssertEqual(
            edge.tick(
                position: 129, window: wide, wantsPlayback: true, isWaiting: true,
                now: now
            ),
            .none
        )
        XCTAssertEqual(
            edge.tick(
                position: 129, window: wide, wantsPlayback: true, isWaiting: true,
                now: now.addingTimeInterval(2)
            ),
            .none,
            "still inside one late segment"
        )
        XCTAssertEqual(
            edge.tick(
                position: 129, window: wide, wantsPlayback: true, isWaiting: true,
                now: now.addingTimeInterval(2.5)
            ),
            .rejoin(122)
        )
    }

    /// Build 25 on a ten second playlist: tip-starve at 2.5 s, seek to
    /// two seconds from the back, fall out, one frame. The short clock
    /// must not run on a window that cannot honour the landing place.
    func testAStarveOnAShortWindowDoesNotTipSeek() {
        var edge = WatchLiveEdge()
        XCTAssertEqual(
            edge.tick(
                position: 109, window: window, wantsPlayback: true, isWaiting: true,
                now: now
            ),
            .none
        )
        XCTAssertEqual(
            edge.tick(
                position: 109, window: window, wantsPlayback: true, isWaiting: true,
                now: now.addingTimeInterval(2.5)
            ),
            .none,
            "a ten second window is not wide enough for the tip clock"
        )
    }

    /// And the allowance itself has to stay in the range the rule was designed
    /// for: past the ten second window, because the overrun rule answers
    /// inside it, and short of a viewer giving up on a frozen picture.
    func testTheStarveAllowanceStaysPastTheWindowAndInsideAViewersPatience() {
        XCTAssertGreaterThan(
            WatchLiveEdge.starvedAfter, 10,
            "inside the window it would only pre-empt the overrun rule and fight buffering"
        )
        XCTAssertLessThan(
            WatchLiveEdge.starvedAfter, 20,
            "beyond this it is a frozen picture nobody is recovering"
        )
    }

    /// Media arriving resets the patience. Otherwise a player that recovered
    /// on its own would still be seeked a few seconds later, for a starve that
    /// had already ended.
    func testMediaArrivingResetsThePatience() {
        var edge = WatchLiveEdge()
        for second in 0..<10 {
            _ = edge.tick(
                position: 105, window: window, wantsPlayback: true, isWaiting: true,
                now: now.addingTimeInterval(Double(second))
            )
        }
        // One tick of honest playback.
        _ = edge.tick(
            position: 105.5, window: window, wantsPlayback: true, isWaiting: false,
            now: now.addingTimeInterval(10)
        )
        // And the clock starts again from there rather than firing at 12.
        let remedy = edge.tick(
            position: 105.5, window: window, wantsPlayback: true, isWaiting: true,
            now: now.addingTimeInterval(13)
        )
        XCTAssertEqual(remedy, .none)
    }

    // MARK: - Not fighting the viewer

    /// `rate` is the intent, and a viewer who tapped pause on the system
    /// transport bar has set it to zero. A live playlist slides past a paused
    /// playhead within ten seconds, so without this every pause would be
    /// answered by the film starting itself again.
    func testAViewerWhoPausedIsNotDraggedBackIntoTheBroadcast() {
        var edge = WatchLiveEdge()
        for second in 0..<60 {
            let remedy = edge.tick(
                position: 40,
                window: window,
                wantsPlayback: false,
                isWaiting: false,
                now: now.addingTimeInterval(Double(second))
            )
            XCTAssertEqual(remedy, .none, "at second \(second)")
        }
    }

    /// A seek is not instant and the position reads stale for a moment after
    /// it. Without a cooldown one starve produces a burst of seeks and the
    /// picture never settles.
    func testOneStarveProducesOneSeekAndNotABurst() {
        var edge = WatchLiveEdge()
        XCTAssertEqual(
            edge.tick(
                position: 98, window: window, wantsPlayback: true, isWaiting: true, now: now
            ),
            .rejoin(104)
        )
        for second in 1...5 {
            XCTAssertEqual(
                edge.tick(
                    position: 98,
                    window: window,
                    wantsPlayback: true,
                    isWaiting: true,
                    now: now.addingTimeInterval(Double(second))
                ),
                .none,
                "at second \(second), still inside the cooldown"
            )
        }
        XCTAssertEqual(
            edge.tick(
                position: 98,
                window: window,
                wantsPlayback: true,
                isWaiting: true,
                now: now.addingTimeInterval(WatchLiveEdge.cooldown)
            ),
            .rejoin(104)
        )
    }

    /// Before the first segment decodes there is no window to be inside or
    /// outside of, and a `NaN` position is what `currentTime()` answers then.
    func testNothingIsDecidedWithoutAWindowOrAPosition() {
        var edge = WatchLiveEdge()
        XCTAssertEqual(
            edge.tick(
                position: 0, window: nil, wantsPlayback: true, isWaiting: true, now: now
            ),
            .none
        )
        XCTAssertEqual(
            edge.tick(
                position: .nan, window: window, wantsPlayback: true, isWaiting: true, now: now
            ),
            .none
        )
    }

    // MARK: - The badge

    /// The badge is honesty, not recovery. A viewer put three seconds inside a
    /// ten second window is legitimately behind and the player is not going to
    /// correct that for them, so the pill has to stop claiming AO VIVO and
    /// start offering the way back.
    func testBehindLiveIsAboutTheBadgeAndNotTheRemedy() {
        XCTAssertFalse(
            WatchLiveEdge.isBehindLive(position: 102, window: window),
            "the place a rejoin lands is normal viewing and must not read as behind"
        )
        XCTAssertTrue(
            WatchLiveEdge.isBehindLive(
                position: 80, window: WatchLiveWindow(start: 70, end: 110)
            )
        )
        XCTAssertFalse(WatchLiveEdge.isBehindLive(position: 103, window: nil))
    }

    /// The phone and the web have to call the same drift by the same name, or
    /// two people watching one party disagree about whether they are live.
    /// `BEHIND_LIVE_THRESHOLD_SECONDS` in `client/src/lib/hls-live-edge.ts`.
    func testTheBadgeThresholdMatchesTheWebs() {
        XCTAssertEqual(WatchLiveEdge.behindBy, 10)
    }

    // MARK: - Why a second watchdog had to exist at all

    /**
     THE REGRESSION THIS FILE IS REALLY ABOUT.

     `WatchStallWatch` was the only thing watching the picture, and its clock
     runs only while `timeControlStatus == .playing`. A starved player is
     `.waitingToPlayAtSpecifiedRate` and an interrupted one is `.paused`, so
     for the whole of the failure a viewer actually reported, the existing
     watchdog returned false on every single tick and the recovery path it
     guards was unreachable.

     This is pinned rather than described because the tempting repair was to
     widen `WatchStallWatch` instead, and widening it would have made a
     buffering player look like a dead one, which is the mistake its own
     comment warns against.
     */
    func testTheOldWatchdogIsBlindToAStarvedPlayerByConstruction() {
        var stall = WatchStallWatch()
        for second in 0..<120 {
            XCTAssertFalse(
                stall.tick(
                    position: 109,
                    isPlaying: false,
                    now: now.addingTimeInterval(Double(second))
                ),
                "at second \(second)"
            )
        }
    }

    /// Buffering with the viewer still wanting playback is still not a stall.
    /// Widening the clock to every non-playing state is how a slow start
    /// becomes a re-attach loop.
    func testAWaitingPlayerIsStillNotAStallEvenWhenTheViewerWantsPlayback() {
        var stall = WatchStallWatch()
        for second in 0..<120 {
            XCTAssertFalse(
                stall.tick(
                    position: 109,
                    isPlaying: false,
                    wantsPlayback: true,
                    isWaiting: true,
                    now: now.addingTimeInterval(Double(second))
                ),
                "at second \(second)"
            )
        }
    }

    /// THE PAUSE NOBODY ASKED FOR. Rate dropped, the viewer did not tap
    /// pause, the playhead is frozen. `play()` is the first recovery; this
    /// is the fallback when that does not unstick it.
    func testAnUnexpectedPauseWithAFrozenPlayheadIsAStall() {
        var stall = WatchStallWatch()
        XCTAssertFalse(
            stall.tick(
                position: 109, isPlaying: false, wantsPlayback: true, isWaiting: false,
                now: now
            )
        )
        XCTAssertFalse(
            stall.tick(
                position: 109, isPlaying: false, wantsPlayback: true, isWaiting: false,
                now: now.addingTimeInterval(WatchStallWatch.deadAfter - 1)
            )
        )
        XCTAssertTrue(
            stall.tick(
                position: 109, isPlaying: false, wantsPlayback: true, isWaiting: false,
                now: now.addingTimeInterval(WatchStallWatch.deadAfter)
            )
        )
    }

    /// A tap on pause is the one frozen playhead that must not recover.
    func testAViewerWhoPausedDoesNotLookLikeAStall() {
        var stall = WatchStallWatch()
        XCTAssertFalse(
            stall.tick(
                position: 109, isPlaying: false, wantsPlayback: false, isWaiting: false,
                now: now.addingTimeInterval(WatchStallWatch.deadAfter * 3)
            )
        )
    }

    // MARK: - The ladder a broadcast actually publishes

    private let ladder = WatchLadder.from(variants: [
        (size: CGSize(width: 1280, height: 720), peakBitRate: 2_217_200),
        (size: CGSize(width: 1920, height: 1080), peakBitRate: 5_322_200),
    ])

    /// Read from the master playlist, tallest first, because that is the order
    /// a picker reads in.
    func testTheLadderIsWhateverTheMasterAdvertised() {
        XCTAssertEqual(ladder.rungs.map(\.lines), [1080, 720])
        XCTAssertEqual(ladder.rungs.map(\.label), ["1080p", "720p"])
    }

    /// A master can carry two variants at one height. The ceiling that admits
    /// both is the taller bitrate's.
    func testTwoVariantsAtOneHeightCollapseToTheRicherOne() {
        let doubled = WatchLadder.from(variants: [
            (size: CGSize(width: 1280, height: 720), peakBitRate: 900_000),
            (size: CGSize(width: 1280, height: 720), peakBitRate: 2_217_200),
        ])
        XCTAssertEqual(doubled.rungs.count, 1)
        XCTAssertEqual(doubled.rungs.first?.peakBitRate, 2_217_200)
    }

    /// An audio only rendition has no presentation size and is not a rung.
    func testAVariantWithNoPictureIsNotARung() {
        let mixed = WatchLadder.from(variants: [
            (size: .zero, peakBitRate: 64_000),
            (size: CGSize(width: 1280, height: 720), peakBitRate: 2_217_200),
        ])
        XCTAssertEqual(mixed.rungs.map(\.lines), [720])
    }

    /// A gear that opens a menu of one item is worse than no gear.
    func testALadderOfOneIsNotWorthAPicker() {
        XCTAssertTrue(ladder.isWorthOffering)
        XCTAssertFalse(
            WatchLadder.from(variants: [
                (size: CGSize(width: 1280, height: 720), peakBitRate: nil)
            ]).isWorthOffering
        )
        XCTAssertFalse(WatchLadder.empty.isWorthOffering)
    }

    // MARK: - What the choice does to the player

    func testAutoSetsNoCeilingAndAPinSetsTheRungs() {
        let auto = ladder.limits(for: .auto)
        XCTAssertEqual(auto.resolution, .zero)
        XCTAssertEqual(auto.peakBitRate, 0)

        let pinned = ladder.limits(for: WatchQualityChoice(lines: 720))
        XCTAssertEqual(pinned.resolution, CGSize(width: 1280, height: 720))
        XCTAssertEqual(pinned.peakBitRate, 2_217_200)
    }

    /// The pin is remembered across broadcasts and the next broadcast may
    /// publish a different ladder. Substituting the nearest rung would leave
    /// somebody who chose 480p watching 1080p on mobile data and being told
    /// 480p, which is worse than being moved back to Auto.
    func testAPinTheBroadcastDoesNotServeFallsBackToAutoAndNotToTheNearestRung() {
        let stale = WatchQualityChoice(lines: 480)
        XCTAssertFalse(ladder.contains(stale))
        XCTAssertEqual(ladder.limits(for: stale).resolution, .zero)
        XCTAssertTrue(ladder.contains(.auto))
        XCTAssertTrue(ladder.contains(WatchQualityChoice(lines: 1080)))
    }

    // MARK: - The ceiling the pane itself implies

    /// A phone wide strip above a transcript. Nothing was setting a ceiling,
    /// so `AVPlayer` climbed to 1080p on a good link and decoded it to draw
    /// this. The pane's own pixels are the ceiling, and 720p is what they
    /// come to.
    func testAnInlineStripDoesNotEarnA1080pDecode() {
        let inline = CGSize(width: 1170, height: 658)
        let cap = ladder.resolutionCap(surfacePixels: inline, choice: .auto)
        XCTAssertEqual(cap, CGSize(width: 1280, height: 720))
        XCTAssertLessThan(cap.height, 1080)
    }

    /// And fullscreen in landscape earns it back, with the same rule and no
    /// second code path.
    func testFullscreenAllowsTheTallestRungAgain() {
        let fullscreen = CGSize(width: 2556, height: 1179)
        let cap = ladder.resolutionCap(surfacePixels: fullscreen, choice: .auto)
        XCTAssertGreaterThanOrEqual(cap.height, 1080)
    }

    /// A ceiling under every rung on the ladder describes no variant at all.
    /// The point of a ceiling is to choose among rungs, never to rule them all
    /// out, so it stops at the shortest one published.
    func testTheCeilingNeverDropsBelowEveryRungOnTheLadder() {
        let tiny = CGSize(width: 320, height: 180)
        XCTAssertEqual(
            ladder.resolutionCap(surfacePixels: tiny, choice: .auto),
            CGSize(width: 1280, height: 720)
        )
    }

    /// A pin and a pane are both ceilings and the smaller one wins. Choosing
    /// 1080p does not buy a 1080p decode into a phone wide strip.
    func testAPinAndAPaneAreBothCeilingsAndTheSmallerWins() {
        let inline = CGSize(width: 1170, height: 658)
        XCTAssertEqual(
            ladder.resolutionCap(
                surfacePixels: inline, choice: WatchQualityChoice(lines: 1080)
            ),
            CGSize(width: 1280, height: 720)
        )
        let fullscreen = CGSize(width: 2556, height: 1179)
        XCTAssertEqual(
            ladder.resolutionCap(
                surfacePixels: fullscreen, choice: WatchQualityChoice(lines: 720)
            ),
            CGSize(width: 1280, height: 720)
        )
    }

    /// Before the master is parsed there is no ladder to choose within, and a
    /// guessed ceiling would be a guess about a broadcast nobody has read yet.
    func testAnUnparsedMasterSetsNoCeilingAtAll() {
        XCTAssertEqual(
            WatchLadder.empty.resolutionCap(
                surfacePixels: CGSize(width: 1170, height: 658), choice: .auto
            ),
            .zero
        )
    }

    /// A view that has not been laid out reports nothing, and capping to zero
    /// would be capping to nothing at all.
    func testASurfaceWithNoAreaIsNotACeiling() {
        XCTAssertEqual(ladder.resolutionCap(surfacePixels: .zero, choice: .auto), .zero)
    }

    // MARK: - What the control says out loud

    /// AUTO HAS TO NAME THE RUNG. Someone on mobile data who reads
    /// "Automático (720p)" understands what their phone is doing; someone who
    /// reads a gear does not, and that was the actual complaint.
    func testAutoNamesTheRungItSettledOn() {
        XCTAssertTrue(
            WatchQualityLabel.text(choice: .auto, effectiveLines: 720).contains("720p"),
            "Auto must say which rung it settled on"
        )
        XCTAssertFalse(
            WatchQualityLabel.text(choice: .auto, effectiveLines: nil).contains("p)"),
            "and must not invent one before the first frame decodes"
        )
        XCTAssertEqual(
            WatchQualityLabel.text(choice: WatchQualityChoice(lines: 1080), effectiveLines: 720),
            "1080p",
            "a pin states the pin, not whatever the player is currently on"
        )
    }

    // MARK: - Cinema chrome, which hides itself while the film is moving

    func testATapShowsTheBarsAndASecondTapPutsThemAway() {
        var clock = WatchChromeClock()
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertTrue(clock.visible, "a freshly opened player starts with the bars up")
        clock.tap(at: now)
        XCTAssertFalse(clock.visible)
        clock.tap(at: now)
        XCTAssertTrue(clock.visible)
    }

    func testPlayingHidesTheBarsAfterAFewSeconds() {
        var clock = WatchChromeClock()
        let now = Date(timeIntervalSince1970: 1_000_000)
        clock.reveal(at: now)
        clock.tick(playing: true, at: now.addingTimeInterval(WatchChromeClock.hideAfter - 0.1))
        XCTAssertTrue(clock.visible, "still inside the window")
        clock.tick(playing: true, at: now.addingTimeInterval(WatchChromeClock.hideAfter))
        XCTAssertFalse(clock.visible)
    }

    func testAPausedFilmKeepsTheBars() {
        var clock = WatchChromeClock()
        let now = Date(timeIntervalSince1970: 1_000_000)
        clock.reveal(at: now)
        clock.tick(playing: false, at: now.addingTimeInterval(WatchChromeClock.hideAfter + 10))
        XCTAssertTrue(clock.visible, "hiding the play button on a still frame is how you lose it")
    }

    // MARK: - Theater rotation

    /// The app is portrait on a phone. Fullscreen has to be allowed to
    /// follow the device, and leaving it has to put the rest of the app
    /// back. iPad already rotates and is left alone.
    @MainActor
    func testTheaterUnlocksLandscapeAndLeavingLocksThePhoneBack() {
        WatchOrientation.leaveTheater()
        if UIDevice.current.userInterfaceIdiom == .phone {
            XCTAssertEqual(WatchOrientation.allowed, .portrait)
        }
        WatchOrientation.enterTheater()
        XCTAssertTrue(WatchOrientation.allowed.contains(.landscapeLeft))
        XCTAssertTrue(WatchOrientation.allowed.contains(.landscapeRight))
        WatchOrientation.leaveTheater()
        if UIDevice.current.userInterfaceIdiom == .phone {
            XCTAssertEqual(WatchOrientation.allowed, .portrait)
        }
    }

    func testAutoMustNotRewriteCeilingsAfterTheItemHasStarted() {
        XCTAssertFalse(
            WatchQualityRetune.shouldWrite(alreadyPlaying: true, trigger: .variants),
            "the master finishing is what froze build 26 after a few seconds"
        )
        XCTAssertFalse(
            WatchQualityRetune.shouldWrite(alreadyPlaying: true, trigger: .surface)
        )
        XCTAssertTrue(
            WatchQualityRetune.shouldWrite(alreadyPlaying: false, trigger: .variants)
        )
        XCTAssertTrue(
            WatchQualityRetune.shouldWrite(alreadyPlaying: true, trigger: .pin),
            "a person picking a rung is allowed the switch"
        )
        XCTAssertTrue(
            WatchQualityRetune.shouldWrite(alreadyPlaying: true, trigger: .fullscreen)
        )
    }

    func testTheTipAllowanceIsInsideOneLateSegmentNotTheWholeWindow() {
        XCTAssertLessThan(WatchLiveEdge.tipStarveAfter, 4)
        XCTAssertLessThan(WatchLiveEdge.tipBehind, WatchLiveEdge.liveTargetOffset)
        XCTAssertLessThan(WatchLiveEdge.tipStarveAfter, WatchLiveEdge.starvedAfter)
    }
}
