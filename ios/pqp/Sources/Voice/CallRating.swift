import Foundation
import Observation

/// When to ask how a call went, as pure functions.
///
/// The mirror of `client/src/lib/call-rating.ts`, deliberately: both clients
/// write into the same `call_ratings` table, and a phone that asked twice as
/// often as a browser would quietly skew every average the operator reads.
/// Rule for rule, and the numbers below are the same numbers.
///
/// THREE GATES, and none of them is about the rating itself:
///
/// - The call has to have lasted a minute. Below that the person is rating
///   whether they meant to tap, not whether the call worked.
/// - Somebody else has to have been there. A call of one has no quality.
/// - Not more than once every six hours. An evening of five short calls is one
///   question, and the sixth answer would not say anything the first five did
///   not.
///
/// WHY IT IS A VALUE TYPE AND NOT PART OF THE MODELS. These rules decide
/// whether somebody gets interrupted, which makes them the part worth testing,
/// and `VoiceModel`/`CallModel` cannot be built in a unit test: both open a
/// microphone. Everything here takes its clock as an argument, the models
/// supply the real one, and `CallRatingTests` supplies its own.
enum CallRating {
    /// Below this the person is rating their own tap. Matches
    /// `MIN_DURATION_SECONDS`.
    static let minimumDuration: TimeInterval = 60
    /// Matches `COOLDOWN_MS`.
    static let cooldown: TimeInterval = 6 * 60 * 60
    /// Matches `CALL_RATING_NOTE_MAX_LENGTH`; the server refuses a longer one.
    static let noteMaxLength = 280
    static let scores = [1, 2, 3, 4, 5]
    /// At or below this the number alone does not say what broke, so the note
    /// appears. Above it the score is the whole answer and sends immediately.
    static let noteWantedAtOrBelow = 3
}

/// Which media path carried the call. `livekit` is here for the wire's sake;
/// this app declares `transports: ["mesh"]` on join and refuses a room pinned
/// to anything else, so it does not currently produce one.
enum CallTransport: String, Codable, Sendable {
    case mesh
    case livekit
}

/// A call that is over and worth asking about.
struct RatableCall: Equatable, Sendable {
    let durationSeconds: Int
    /// The most people who were in the room at once, not the count at the end.
    let peerCount: Int
    let transport: CallTransport
    let hadScreenShare: Bool
    /// The voice room. For a DM call that is the conversation id, which is what
    /// the server pins the room to.
    let channelId: String?
}

/// One moment of a live call: the slice the tracker folds in.
struct CallSnapshot: Equatable, Sendable {
    /// Other people, not counting yourself.
    var peerCount: Int
    var usingSfu: Bool
    /// Anybody's screen, yours included.
    var screenSharing: Bool
    var channelId: String?

    init(
        peerCount: Int = 0,
        usingSfu: Bool = false,
        screenSharing: Bool = false,
        channelId: String? = nil
    ) {
        self.peerCount = peerCount
        self.usingSfu = usingSfu
        self.screenSharing = screenSharing
        self.channelId = channelId
    }
}

/// What is accumulated while a call runs, because none of it survives the end.
struct CallProgress: Equatable, Sendable {
    var startedAt: Date
    var maxPeers: Int
    var hadScreenShare: Bool
    var transport: CallTransport
    var channelId: String?
}

/// Watches one call and freezes it when it ends.
///
/// WHY IT ACCUMULATES RATHER THAN READING THE MODEL AT THE END. By the time a
/// call is over every fact worth recording is already gone: the peers are
/// cleared, the transport is forgotten, and whether anybody shared a screen was
/// only true in the middle. There are also three ways out of a call on this
/// platform (the button, the socket dropping, navigating back out of the voice
/// screen) and only one of them goes through a handler anybody remembers to
/// edit, which is why `observe` is driven from `didSet` rather than from the
/// exits.
struct CallRatingTracker: Sendable {
    private(set) var progress: CallProgress?

    /// Fold one moment of a live call into what is known about it.
    ///
    /// Peers are a high-water mark because people leave before somebody hangs
    /// up, and describing a call of five as a call of one would misreport the
    /// thing being rated. The screen-share flag is sticky for the same reason.
    /// Transport is re-read rather than trusted from the join, because a room
    /// can be promoted to the SFU while somebody is sitting in it.
    mutating func observe(_ snapshot: CallSnapshot, now: Date = Date()) {
        guard var current = progress else {
            progress = CallProgress(
                startedAt: now,
                maxPeers: snapshot.peerCount,
                hadScreenShare: snapshot.screenSharing,
                transport: snapshot.usingSfu ? .livekit : .mesh,
                channelId: snapshot.channelId
            )
            return
        }
        current.maxPeers = max(current.maxPeers, snapshot.peerCount)
        current.hadScreenShare = current.hadScreenShare || snapshot.screenSharing
        current.transport = snapshot.usingSfu ? .livekit : .mesh
        progress = current
    }

    /// The call is over: ask, or stay quiet.
    ///
    /// Nil means "do not interrupt", and the caller must not treat it as an
    /// error. Always clears, so a second call to it cannot ask twice about the
    /// same call.
    mutating func finish(now: Date = Date(), lastAskedAt: Date) -> RatableCall? {
        guard let finished = progress else { return nil }
        progress = nil

        let elapsed = now.timeIntervalSince(finished.startedAt)
        guard elapsed >= CallRating.minimumDuration else { return nil }
        guard finished.maxPeers > 0 else { return nil }
        guard now.timeIntervalSince(lastAskedAt) >= CallRating.cooldown else { return nil }

        return RatableCall(
            // Rounded, not truncated, to agree with the web's `Math.round`.
            durationSeconds: Int(elapsed.rounded()),
            peerCount: finished.maxPeers,
            transport: finished.transport,
            hadScreenShare: finished.hadScreenShare,
            channelId: finished.channelId
        )
    }
}

/// Where the "asked at" stamp lives between calls.
///
/// A protocol only so the cooldown can be tested without leaking into the real
/// `UserDefaults` of whatever simulator the suite runs on. The default is the
/// distant past, so a device that has never been asked is asked.
protocol CallRatingClock: Sendable {
    func lastAsked() -> Date
    func recordAsked(_ now: Date)
}

struct DefaultsCallRatingClock: CallRatingClock {
    static let key = "pqp.callRating.askedAt"
    let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func lastAsked() -> Date {
        let seconds = defaults.double(forKey: Self.key)
        // Absent reads as 0, which is 1970 and therefore "never asked". That is
        // the right direction to be wrong in: a device that cannot remember is
        // asked as often as one that can, never more.
        return Date(timeIntervalSince1970: seconds)
    }

    func recordAsked(_ now: Date) {
        defaults.set(now.timeIntervalSince1970, forKey: Self.key)
    }
}

/// The one thing that knows a question is waiting, app-wide.
///
/// Separate from both call models because there are two of them: a voice
/// channel is a place you walk into and a DM call is a thing that happens to
/// you, and they are separate models for that reason. The prompt has to outlive
/// either, since `VoiceView` is pushed on a navigation stack and takes its own
/// state with it when it pops, which is exactly the moment the call ended.
@MainActor
@Observable
final class CallRatingModel {
    /// Non-nil while a question is on screen.
    private(set) var pending: RatableCall?

    @ObservationIgnored private let clock: any CallRatingClock

    init(clock: any CallRatingClock = DefaultsCallRatingClock()) {
        self.clock = clock
    }

    /// THE COOLDOWN IS WRITTEN WHEN THE PROMPT IS SHOWN, not when it is
    /// answered. Anything else quietly punishes the people who dismiss it, by
    /// asking them again after the next call.
    func offer(_ call: RatableCall?, now: Date = Date()) {
        guard let call else { return }
        clock.recordAsked(now)
        pending = call
    }

    /// Ends a call the tracker was watching and asks if the rules allow it.
    func finish(_ tracker: inout CallRatingTracker, now: Date = Date()) {
        offer(tracker.finish(now: now, lastAskedAt: clock.lastAsked()), now: now)
    }

    func dismiss() {
        pending = nil
    }

    #if DEBUG
    /// Puts the question on screen without a call behind it.
    ///
    /// A real one needs two people in a room for over a minute, which no UI
    /// test on one simulator can arrange, and the rules that decide *whether*
    /// to ask are already covered by `CallRatingTests`. What this leaves
    /// testable is everything those cannot see: that the card is reachable from
    /// the root at all, that a score posts, and that the app says thank you.
    /// Same shape and same reason as `-pqp.fakeScreenShare`.
    func offerSyntheticCallIfRequested() {
        guard ProcessInfo.processInfo.arguments.contains("-pqp.fakeCallRating") else {
            return
        }
        guard pending == nil else { return }
        offer(RatableCall(
            durationSeconds: 214,
            peerCount: 2,
            transport: .mesh,
            hadScreenShare: false,
            // No room id: a synthetic call was never in one, and the server's
            // schema takes a uuid or nothing.
            channelId: nil
        ))
    }
    #endif
}
