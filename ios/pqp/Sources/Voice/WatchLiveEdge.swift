import Foundation

/**
 THE WINDOW A LIVE PLAYLIST ACTUALLY OFFERS, AND FALLING OUT OF THE BACK OF IT.

 READ THIS FIRST, BECAUSE IT IS NOT WHAT IT LOOKS LIKE. The stalls a viewer
 reported on 2026-09-09 were a SERVER bug, traced separately and fixed
 separately: a share that outlived its watch party counted as a finished
 session, and the retention sweep deleted the files of a stream still being
 written to, roughly every ten minutes. Both the web and the phone stalled on
 it. Nothing in this file would have prevented that and nothing in this file
 should be tuned against it.

 What this file is for is narrower and still real. The egress writes a live
 playlist holding exactly FIVE two second segments (measured against
 production, both rungs, repeatedly). Ten seconds, total, sliding forward as
 the broadcast runs. `AVPlayer` joins a live playlist three target durations
 from the end (RFC 8216, 6.3.3), so it starts with roughly four seconds of
 runway in front of it and the back edge of the window about five seconds
 behind. Ten seconds is a thin window by any standard, and the consequence of
 a thin window is specific: a player that stops for longer than the window,
 for ANY reason, has the playlist slide past the position it stopped at. The
 playhead then names a time the playlist no longer contains, `play()` cannot
 help because there is nothing there to play, and only a seek back into the
 window is.

 That is what "I need to press play, and it does not necessarily work" is made
 of, whatever caused the original stop. So this is a recovery path, not a
 diagnosis, and it is deliberately additive: `WatchStallWatch` is untouched and
 no threshold in it was relaxed.

 `WatchStallWatch` is blind to this by construction, which is why a second type
 exists rather than a wider first one. Its clock runs only while
 `timeControlStatus == .playing`, which is right for the failure it was written
 for and means it returns false on every single tick of this one: a starved
 player is `.waitingToPlayAtSpecifiedRate` and an interrupted one is `.paused`.

 AND DRIFT IS THE OTHER HALF, reported by the same viewer in the same session:
 "it's so choppy it got very delayed". A stall is not free even once it ends.
 `AVPlayer` resumes where it stopped, because that is the correct thing to do
 with a recording and the wrong thing to do with a broadcast, so every stall
 adds its own length to the distance behind live and none of it is ever paid
 back. Six of them is minutes, and minutes behind on a watch party means the
 chat is discussing a scene the viewer has not reached.

 So there are two remedies here and they are the same seek with different
 triggers. Nothing in this file buffers more: more buffer IS more delay, which
 is the complaint.

 WHERE THE SEEK LANDS, and why it is measured from the END. Three target
 durations back from the live edge is where a client is supposed to join a
 live playlist in the first place (RFC 8216, 6.3.3), which makes it both the
 position `AVPlayer` would have chosen on its own and the position with a
 sensible amount of media in front of it. Measuring from the end rather than
 the front matters because `seekableTimeRanges` is not guaranteed to be only
 the current playlist window: where it is, the two are the same point on a ten
 second window, and where it is a union that grows with the session, a target
 measured from the start would be a seek to the beginning of the film.
 */
struct WatchLiveWindow: Equatable, Sendable {
    /// Oldest position the playlist still offers, in seconds on the item's own
    /// timeline. `AVPlayerItem.seekableTimeRanges.first.start`.
    let start: Double
    /// The live edge. `seekableTimeRanges.last.end`.
    let end: Double

    var span: Double { end - start }
}

/// What the view should do about the picture on this tick.
enum WatchLiveRemedy: Equatable, Sendable {
    /// Leave it alone. Overwhelmingly the answer.
    case none
    /// Seek here and play. Inside the current window by construction.
    case rejoin(Double)
}

struct WatchLiveEdge: Equatable {
    /// How long a player may sit waiting for media before a seek is worth more
    /// than more patience.
    ///
    /// Deliberately just PAST the ten second window rather than inside it. On
    /// a window that really slides, a player starving at the edge falls out of
    /// the back after ten seconds and the overrun rule above answers first, so
    /// a shorter allowance here would only ever pre-empt it and would fight
    /// ordinary buffering to do so. What this covers is everything else: a
    /// `seekableTimeRanges` that does not slide, and a window that has stopped
    /// advancing altogether. Twelve seconds is past the point where `AVPlayer`
    /// has visibly given up and short of a viewer reaching for the button.
    ///
    /// Bounded by a test rather than by this comment, because the first
    /// version of that test read this constant to build its own deadline and
    /// therefore moved with it: stretching this to ten minutes changed nothing
    /// and no test noticed.
    static let starvedAfter: TimeInterval = 12

    /// How far back from the LIVE EDGE to land, in seconds.
    ///
    /// Three two-second segments (6 s). Four segments (8 s) on a ten second
    /// playlist is two seconds from the back: the segment the next playlist
    /// update expires. That is the stall the web player just left
    /// (`HLS_LIVE_SYNC_DURATION_COUNT = 3`). `target(in:)` still honours
    /// `minRunway` so a short window cannot land on the last two seconds.
    static let liveTargetOffset: Double = 6

    /// Jump-to-live and stall recovery, matching web `jumpToLiveTime`:
    /// one 2 s segment behind the edge, not onto it.
    static let jumpOffset: Double = 2

    /// Never land closer to the back of the window than this, in seconds.
    /// Two segments. Combined with `liveTargetOffset` a ten second window
    /// lands six seconds from the edge (four from the back), not eight.
    static let minRunway: Double = 4

    /// The drift a viewer is not asked about.
    ///
    /// The badge offers the way back at ten seconds (`behindBy`), matching the
    /// web. This is the point where offering has stopped being enough: three
    /// quarters of a minute behind is far enough that the chat is spoiling the
    /// film, and a viewer who has not noticed the button is not enjoying being
    /// left there. Deliberately far above the offer, because a jump mid
    /// sentence is jarring and should be rare.
    static let catchUpAfter: Double = 45

    /// Sitting closer than this, in seconds, is sitting on the tip. A player
    /// waiting here is waiting for a segment that has not been written yet.
    /// Only applied when the window is wide enough that a seek to
    /// `liveTargetOffset` still leaves `minRunway` behind the playhead.
    /// On a ten second window the seek would land near the back and this
    /// clock would fire again: one frame, then dead. That was build 25.
    static let tipBehind: Double = 4
    static let tipStarveAfter: TimeInterval = 2.5

    /// A rejoin may not be answered again this soon. A seek is not instant and
    /// the position reads stale for a moment afterwards. Without this, one
    /// starve produces a burst of seeks and the picture never settles.
    static let cooldown: TimeInterval = 6

    /// How far behind the live edge counts as behind, for the badge. Ten
    /// seconds, which is `BEHIND_LIVE_THRESHOLD_SECONDS` on the web, so the
    /// two clients call the same drift by the same name.
    static let behindBy: Double = 10

    private var waitingSince: Date?
    private var rejoinedAt: Date?

    /// - Parameters:
    ///   - position: `player.currentTime().seconds`.
    ///   - window: the item's seekable range, or nil before it has one.
    ///   - wantsPlayback: THE VIEWER'S INTENT, not `player.rate`. Rate
    ///     drops to 0 on a pause nobody asked for (a rung switch, an
    ///     interruption the notification missed, AVPlayer giving up), and
    ///     treating that as a tap on pause is what left build 23 frozen.
    ///     The chrome, the lock screen and Now Playing set this; a seek
    ///     here must never run when it is false.
    ///   - isWaiting: `timeControlStatus == .waitingToPlayAtSpecifiedRate`.
    mutating func tick(
        position: Double,
        window: WatchLiveWindow?,
        wantsPlayback: Bool,
        isWaiting: Bool,
        now: Date
    ) -> WatchLiveRemedy {
        guard wantsPlayback, let window, window.span > 0, position.isFinite else {
            waitingSince = nil
            return .none
        }
        if let rejoinedAt, now.timeIntervalSince(rejoinedAt) < Self.cooldown {
            return .none
        }
        // Fallen out of the back. Unrecoverable without a seek whatever the
        // player says its status is, so this is asked before the clock.
        if position < window.start {
            return rejoin(window, now: now)
        }
        // Drifted far enough that the chat is ahead of the picture. This is
        // the rule that pays a stall back; the one above only catches the case
        // where the playlist window is reported as the window rather than as
        // everything the session has published.
        if Self.secondsBehindLive(position: position, window: window) >= Self.catchUpAfter {
            return rejoin(window, now: now)
        }
        guard isWaiting else {
            waitingSince = nil
            return .none
        }
        guard let since = waitingSince else {
            waitingSince = now
            return .none
        }
        // On a WIDE window, sitting on the tip is waiting for a segment
        // that has not been written yet, and twelve seconds of patience
        // there is a freeze for the whole show. On a short window the
        // same clock is a seek loop: land, wait 2.5 s, seek again, one
        // decoded frame in between. Build 25 did that on a ten second
        // playlist. So the short allowance only runs when a seek to
        // `liveTargetOffset` still leaves `minRunway` of media behind it.
        let behind = Self.secondsBehindLive(position: position, window: window)
        let tipSensitive = window.span >= Self.liveTargetOffset + Self.minRunway
        let allowance =
            tipSensitive && behind < Self.tipBehind
            ? Self.tipStarveAfter : Self.starvedAfter
        guard now.timeIntervalSince(since) >= allowance else { return .none }
        return rejoin(window, now: now)
    }

    private mutating func rejoin(_ window: WatchLiveWindow, now: Date) -> WatchLiveRemedy {
        waitingSince = nil
        rejoinedAt = now
        return .rejoin(Self.target(in: window))
    }

    /// Back from the live edge, but never onto the last two seconds of a
    /// short playlist. A window shorter than `minRunway` has no such
    /// position and lands at the start of everything that exists.
    static func target(in window: WatchLiveWindow) -> Double {
        land(in: window, offset: liveTargetOffset)
    }

    /// Where the Jump to live control (and a stall recover) should land.
    /// One segment behind the edge, matching the web, still honouring
    /// `minRunway` on a short playlist.
    static func jumpTarget(in window: WatchLiveWindow) -> Double {
        land(in: window, offset: jumpOffset)
    }

    private static func land(in window: WatchLiveWindow, offset: Double) -> Double {
        if window.span <= minRunway {
            return window.start
        }
        return max(window.start + minRunway, window.end - offset)
    }

    /// How far behind the playlist's newest segment the picture is. Never
    /// negative: a position past the edge is a rounding artefact, not time
    /// travel.
    static func secondsBehindLive(position: Double, window: WatchLiveWindow?) -> Double {
        guard let window, position.isFinite else { return 0 }
        return max(0, window.end - position)
    }

    /// Whether the badge should offer a way back rather than claim to be live.
    static func isBehindLive(position: Double, window: WatchLiveWindow?) -> Bool {
        guard window != nil, position.isFinite else { return false }
        return secondsBehindLive(position: position, window: window) > behindBy
    }
}

/**
 WHAT THE DELAY READOUT SAYS, AND WHY IT IS NOT THE NUMBER THE SERVER SENT.

 `LiveHlsStream.delaySeconds` is the pipeline: capture, encode, segment,
 upload. It is a property of the broadcast and it is the same for everybody,
 which is exactly why it cannot be the whole answer. A viewer who has drifted
 two minutes behind and is being shown "~10s de atraso" has been told something
 false by their own app, and they find out from the chat spoiling the film.

 So the number is the pipeline PLUS the measured distance from the playlist's
 live edge, and it moves when the viewer's own picture falls behind. Before any
 window exists there is nothing to measure and the pipeline figure stands on
 its own, which is honest: it is the delay everybody has.
 */
enum WatchDelay {
    static func seconds(
        pipeline: Int?, position: Double, window: WatchLiveWindow?
    ) -> Int? {
        guard window != nil, position.isFinite else { return pipeline }
        let behind = WatchLiveEdge.secondsBehindLive(position: position, window: window)
        return (pipeline ?? 0) + Int(behind.rounded())
    }
}
