import Foundation

// ADJUSTING A POSTED TAKE, PURE. The web's `jam-take-edit.ts` and `jam-clip.ts`
// (`client/src/lib/`), restated number for number: the same ranges, the same
// steps and the same rounding, so a take adjusted here and the same take
// adjusted there ask the server for the same thing.
//
// THE TIMELINE, as everywhere on this client (`JamAlignment`, PR #1595):
// `offsetMs` is the song time of the stored file's FIRST sample, a trim HIDES
// audio and never moves it, and the heard slice is
// `offsetMs + trimStartMs ... offsetMs + durationMs - trimEndMs`. So:
//
//  - moving a take earlier or later ("the nudge") changes `offsetMs`;
//  - cutting the start or the end changes a trim and moves nothing;
//  - the gain is a plain multiplier, 0 (silent) to 2 (+6 dB).
//
// Everything is in song milliseconds.

/// JavaScript's `Math.round`: halves go UP (toward +infinity), where Swift's
/// `rounded()` sends them away from zero. They differ only for a negative half
/// (-0.5 is 0 on the web and -1 in Swift), which is exactly where a nudge of
/// +/- 5 ms steps could land, so the web's rule is the one used.
func jsRound(_ value: Double) -> Double { (value + 0.5).rounded(.down) }

/// The take as it sits on the song before any edit: where its first sample is,
/// how long the whole recording is, and how much of its head may never be
/// shown again. A posted track does not know the head the recorder hid (the
/// count-in), so its minimum is 0 and a cut may go all the way back: the person
/// is listening while they move it.
struct JamClipSource: Equatable, Sendable {
    var baseOffsetMs: Double
    var durationMs: Double
    var minTrimStartMs: Double = 0

    init(track: JamTrack) {
        baseOffsetMs = track.offsetMs
        durationMs = track.durationMs
    }

    init(baseOffsetMs: Double, durationMs: Double, minTrimStartMs: Double = 0) {
        self.baseOffsetMs = baseOffsetMs
        self.durationMs = durationMs
        self.minTrimStartMs = minTrimStartMs
    }
}

/// What the person has changed, in the editor's own terms.
struct JamClipEdits: Equatable, Sendable {
    var trimStartMs: Double
    var trimEndMs: Double
    /// Added to `offsetMs`: how much the whole take moved.
    var nudgeMs: Double
    var gain: Double

    /// Shortest stretch of a take that may stay audible.
    static let minAudibleMs = 500.0
    /// How far a nudge may go either way.
    static let nudgeLimitMs = 500.0
    static let gainMax = JamLimits.gainMax

    /// A posted track as it is stored (`editsFromTrack`).
    init(track: JamTrack) {
        trimStartMs = track.trimStartMs
        trimEndMs = track.trimEndMs
        nudgeMs = 0
        gain = track.gain
    }

    init(trimStartMs: Double, trimEndMs: Double, nudgeMs: Double, gain: Double) {
        self.trimStartMs = trimStartMs
        self.trimEndMs = trimEndMs
        self.nudgeMs = nudgeMs
        self.gain = gain
    }

    /// Move the start trim, keeping it past the recorded head and leaving
    /// something to hear (`withTrimStart`).
    func withTrimStart(_ ms: Double, source: JamClipSource) -> JamClipEdits {
        var next = self
        let most = source.durationMs - trimEndMs - Self.minAudibleMs
        next.trimStartMs = jsRound(min(max(ms, source.minTrimStartMs), max(source.minTrimStartMs, most)))
        return next
    }

    /// Move the end trim (ms hidden at the tail), leaving something to hear
    /// (`withTrimEnd`).
    func withTrimEnd(_ ms: Double, source: JamClipSource) -> JamClipEdits {
        var next = self
        let most = source.durationMs - trimStartMs - Self.minAudibleMs
        next.trimEndMs = jsRound(min(max(ms, 0), max(0, most)))
        return next
    }

    func withNudge(_ ms: Double) -> JamClipEdits {
        var next = self
        next.nudgeMs = jsRound(min(max(ms, -Self.nudgeLimitMs), Self.nudgeLimitMs))
        return next
    }

    func withGain(_ gain: Double) -> JamClipEdits {
        var next = self
        next.gain = min(max(gain, 0), Self.gainMax)
        return next
    }

    /// How long the take is heard for with these trims.
    func audibleMs(durationMs: Double) -> Double { max(0, durationMs - trimStartMs - trimEndMs) }

    /// The numbers the engine plays and the server stores: the take's own with
    /// the edits laid on (`placed`).
    func placed(_ track: JamTrack) -> JamTrackPlacement {
        JamTrackPlacement(
            offsetMs: track.offsetMs + nudgeMs, trimStartMs: trimStartMs,
            trimEndMs: trimEndMs, gain: gain
        )
    }

    /// The `PATCH /api/jam-tracks/:id` body for what changed, and only that.
    /// Empty when nothing did (`patchFor`): the offset and the trims are whole
    /// milliseconds, a gain is two decimals and a difference under half a percent
    /// is not a change.
    func patch(for track: JamTrack) -> JamTrackPatchBody {
        var patch = JamTrackPatchBody()
        let offset = jsRound(track.offsetMs + nudgeMs)
        if offset != jsRound(track.offsetMs) { patch.offsetMs = offset }
        if jsRound(trimStartMs) != jsRound(track.trimStartMs) { patch.trimStartMs = jsRound(trimStartMs) }
        if jsRound(trimEndMs) != jsRound(track.trimEndMs) { patch.trimEndMs = jsRound(trimEndMs) }
        if abs(gain - track.gain) > 0.005 { patch.gain = jsRound(gain * 100) / 100 }
        return patch
    }

    func isEdited(from track: JamTrack) -> Bool { !patch(for: track).isEmpty }

    /// How far one press of "earlier" / "later" goes: a tap is 10 ms, and
    /// HOLDING the button repeats and speeds up (10, then 50, then 100 ms a
    /// step), because on a phone nobody taps thirty times (`nudgeStepFor`).
    static func nudgeStep(heldMs: Double) -> Double {
        heldMs >= 1500 ? 100 : heldMs >= 600 ? 50 : 10
    }

    /// A hold waits this long before it repeats, so a tap stays one step.
    static let holdDelayMs = 400.0
    static let repeatMs = 90.0

    /// What a handle moves per press for VoiceOver and a keyboard: an end moves
    /// 50 ms (500 with big), the middle 10 ms (50 with big).
    static let handleStepMs = 50.0
    static let bodyStepMs = 10.0
}

/// The numbers the engine needs for a take that is being adjusted.
struct JamTrackPlacement: Equatable, Sendable {
    var offsetMs: Double
    var trimStartMs: Double
    var trimEndMs: Double
    var gain: Double
}

/// `updateJamTrackSchema` for the fields a take's author owns, and `inMix`
/// (the song's author or a moderator). Only what changed is sent: every field
/// is optional and a nil one is not in the body.
struct JamTrackPatchBody: Encodable, Equatable, Sendable {
    var offsetMs: Double?
    var trimStartMs: Double?
    var trimEndMs: Double?
    var gain: Double?
    var inMix: Bool?

    var isEmpty: Bool { offsetMs == nil && trimStartMs == nil && trimEndMs == nil && gain == nil && inMix == nil }
}

// MARK: - The clip, as the editor draws it

struct JamClipWindow: Equatable, Sendable {
    var startMs: Double
    var endMs: Double

    var lengthMs: Double { max(1, endMs - startMs) }
}

enum JamClipMath {
    enum Zoom: String, CaseIterable, Sendable {
        case whole, close
    }

    /// Room left on each side of the clip, so a handle is never on the edge.
    static let padMs = 400.0

    /// The take's audible stretch on the song, with the edits laid on.
    static func span(_ source: JamClipSource, _ edits: JamClipEdits) -> JamClipWindow {
        let offset = source.baseOffsetMs + edits.nudgeMs
        return JamClipWindow(startMs: offset + edits.trimStartMs, endMs: offset + source.durationMs - edits.trimEndMs)
    }

    /// The part of the buffer that can be shown at all (everything but the
    /// hidden head).
    static func reach(_ source: JamClipSource, nudgeMs: Double) -> JamClipWindow {
        let offset = source.baseOffsetMs + nudgeMs
        return JamClipWindow(startMs: offset + source.minTrimStartMs, endMs: offset + source.durationMs)
    }

    /// The stretch the editor draws. Whole: the take's full reach at any nudge,
    /// so the frame never moves while the clip is dragged. Close: three seconds
    /// around where the take starts, where lining up is decided.
    static func window(_ source: JamClipSource, _ edits: JamClipEdits, zoom: Zoom) -> JamClipWindow {
        switch zoom {
        case .close:
            let start = span(source, edits).startMs
            return JamClipWindow(startMs: start - 1000, endMs: start + 2000)
        case .whole:
            return JamClipWindow(
                startMs: source.baseOffsetMs + source.minTrimStartMs - JamClipEdits.nudgeLimitMs - padMs,
                endMs: source.baseOffsetMs + source.durationMs + JamClipEdits.nudgeLimitMs + padMs
            )
        }
    }

    /// 0...1 across the window, clamped.
    static func fraction(_ window: JamClipWindow, _ ms: Double) -> Double {
        min(1, max(0, (ms - window.startMs) / window.lengthMs))
    }

    /// Milliseconds per point for a window drawn `width` points wide.
    static func msPerPoint(_ window: JamClipWindow, width: Double) -> Double {
        (window.endMs - window.startMs) / max(1, width)
    }

    /// One lane of the band behind the take.
    struct BandLane: Equatable, Sendable {
        var peaks: [Double]
        var offsetMs: Double
        var trimStartMs: Double
        var trimEndMs: Double
        var durationMs: Double

        init(_ track: JamTrack) {
            peaks = track.peaks
            offsetMs = track.offsetMs
            trimStartMs = track.trimStartMs
            trimEndMs = track.trimEndMs
            durationMs = track.durationMs
        }
    }

    /// The band behind the take: `count` heights in 0...1 across the window,
    /// each the loudest moment of any in-mix lane in that slice (silence where
    /// nobody plays). Loudness is per lane, so a quiet bass still shows under a
    /// loud drum (`bandEnvelope`).
    static func bandEnvelope(_ lanes: [BandLane], window: JamClipWindow, count: Int) -> [Double] {
        guard count > 0 else { return [] }
        var out = [Double](repeating: 0, count: count)
        let slice = (window.endMs - window.startMs) / Double(count)
        for lane in lanes where !lane.peaks.isEmpty && lane.durationMs > 0 {
            let loudest = lane.peaks.max().flatMap { $0 > 0 ? $0 : nil } ?? 1
            let audibleFrom = lane.offsetMs + lane.trimStartMs
            let audibleTo = lane.offsetMs + lane.durationMs - lane.trimEndMs
            let n = Double(lane.peaks.count)
            for i in 0..<count {
                let a = max(window.startMs + Double(i) * slice, audibleFrom)
                let b = min(window.startMs + Double(i + 1) * slice, audibleTo)
                if b <= a { continue }
                let from = Int((((a - lane.offsetMs) / lane.durationMs) * n).rounded(.down))
                let to = max(from + 1, Int((((b - lane.offsetMs) / lane.durationMs) * n).rounded(.up)))
                var peak = 0.0
                for j in max(0, from)..<max(max(0, from), min(lane.peaks.count, to)) {
                    peak = max(peak, lane.peaks[j])
                }
                out[i] = max(out[i], peak / loudest)
            }
        }
        return out
    }

    /// The take's own bars, `count` of them across the buffer from the hidden
    /// head to the end (what the clip draws, handles and all), scaled so the
    /// loudest is 1 (`clipBars`).
    static func bars(peaks: [Double], source: JamClipSource, count: Int) -> [Double] {
        guard count > 0 else { return [] }
        if peaks.isEmpty { return [Double](repeating: 0.3, count: count) }
        let from = Int(((source.minTrimStartMs / max(1, source.durationMs)) * Double(peaks.count)).rounded(.down))
        let usable = Array(peaks[min(from, peaks.count - 1)...])
        var out: [Double] = []
        out.reserveCapacity(count)
        for i in 0..<count {
            let a = i * usable.count / count
            let b = max(a + 1, (i + 1) * usable.count / count)
            var peak = 0.0
            var j = a
            while j < b && j < usable.count {
                peak = max(peak, usable[j])
                j += 1
            }
            out.append(peak)
        }
        let loudest = out.max() ?? 0
        return loudest > 0 ? out.map { $0 / loudest } : out
    }

    /// How tall a take's waveform is drawn for its volume, as a share of the
    /// lane: a quiet take is visibly shorter and a silent one is still a line
    /// (`levelOfGain`).
    static func level(ofGain gain: Double) -> Double {
        min(1.12, 0.3 + 0.7 * max(0, gain.isFinite ? gain : 1))
    }

    /// "+20%", "-75%"; nil at the take's own level (100%) (`volumeDelta`).
    static func volumeDelta(_ gain: Double) -> String? {
        let percent = Int(jsRound(gain * 100)) - 100
        return percent == 0 ? nil : "\(percent > 0 ? "+" : "-")\(abs(percent))%"
    }

    /// "+20 ms", "-5 ms", "0 ms" (`signedMs`).
    static func signedMs(_ ms: Double) -> String {
        let rounded = Int(jsRound(ms))
        return rounded == 0 ? "0 ms" : "\(rounded > 0 ? "+" : "-")\(abs(rounded)) ms"
    }
}

// MARK: - A draft that follows the stored take

/// The stored numbers a draft was started from. Two values are equal when none
/// of the numbers an edit can change moved: a vote or a label arriving is not a
/// movement.
struct JamStoredTake: Equatable, Sendable {
    var id: String
    var offsetMs: Double
    var trimStartMs: Double
    var trimEndMs: Double
    var gain: Double

    init(_ track: JamTrack) {
        id = track.id
        offsetMs = track.offsetMs
        trimStartMs = track.trimStartMs
        trimEndMs = track.trimEndMs
        gain = track.gain
    }
}

/// The edits being made to one take, and how they answer a live frame.
///
/// THE RULE (`TrackAdjust` on the web). When the stored numbers MOVE (a save of
/// this very draft landed, or the same account changed the take somewhere
/// else), the draft starts over from them. It does not while a save is out, and
/// it does not when nothing it can change moved, so a vote, a label or an echo
/// of a save that failed leaves the person's edits exactly as they were for
/// another try.
struct JamAdjustDraft: Equatable, Sendable {
    private(set) var edits: JamClipEdits
    private(set) var base: JamStoredTake

    init(track: JamTrack) {
        edits = JamClipEdits(track: track)
        base = JamStoredTake(track)
    }

    mutating func set(_ next: JamClipEdits) { edits = next }

    /// Start over from the stored take.
    mutating func reset(to track: JamTrack) {
        edits = JamClipEdits(track: track)
        base = JamStoredTake(track)
    }

    /// Follow the stored take. True when the draft was thrown away for it.
    @discardableResult
    mutating func reconcile(with track: JamTrack, saving: Bool) -> Bool {
        let stored = JamStoredTake(track)
        guard !saving, stored != base else { return false }
        reset(to: track)
        return true
    }

    func patch(for track: JamTrack) -> JamTrackPatchBody { edits.patch(for: track) }
    func isDirty(for track: JamTrack) -> Bool { !patch(for: track).isEmpty }
}
