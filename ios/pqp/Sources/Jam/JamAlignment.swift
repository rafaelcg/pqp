import Foundation

// WHERE EACH STEM STARTS, IN FRAMES. The one place the contract's timeline
// (`jam.ts`, "THE TIMELINE") becomes arithmetic, so the engine and its test
// read the same definition.
//
//   a track plays  audio[trimStart, length - trimEnd]
//   and that slice starts at  offsetMs  on the song timeline
//
// The song's zero is not a thing the server fixes ("the engine decides where it
// zeroes the transport"). This player zeroes it at the EARLIEST start of any
// track in the mix, so position 0 is the first sound anybody makes and a track
// that starts before the song's own zero (a count-in) is not cut off. The
// server's `mixDurationMs` is the same span: latest end minus earliest start.

/// A stem as the engine plays it. Plain numbers, so a plan is testable without
/// a file or an engine.
struct JamStemSpec: Equatable, Sendable {
    let id: String
    let offsetMs: Double
    let trimStartMs: Double
    let trimEndMs: Double
}

/// What to schedule for one stem when the transport starts at some position.
struct JamStemPlan: Equatable, Sendable {
    /// Frames to wait, counted from the moment the transport starts, before the
    /// first sample plays. Zero when the transport starts inside the slice.
    let delayFrames: Int64
    /// The first frame of the stored file to play.
    let startFrame: Int64
    /// How many frames to play from there.
    let frameCount: Int64
}

enum JamAlignment {
    /// Where the transport's zero sits on the song timeline: the earliest start
    /// of any stem. Zero with no stems.
    static func originMs(_ stems: [JamStemSpec]) -> Double {
        stems.map(\.offsetMs).min() ?? 0
    }

    /// The mix length in ms: from the earliest start to the latest end.
    /// `lengthMs` is each stem's stored length, parallel to `stems`.
    static func durationMs(_ stems: [JamStemSpec], lengthsMs: [Double]) -> Double {
        guard !stems.isEmpty, stems.count == lengthsMs.count else { return 0 }
        let origin = originMs(stems)
        var end = origin
        for (stem, length) in zip(stems, lengthsMs) {
            let played = max(0, length - stem.trimStartMs - stem.trimEndMs)
            end = max(end, stem.offsetMs + played)
        }
        return end - origin
    }

    /// Whole frames for a span of milliseconds at `rate`, rounded to nearest.
    /// Exact at 48 kHz (48 frames per ms), under half a frame off at 44.1 kHz.
    static func frames(forMs ms: Double, rate: Double) -> Int64 {
        Int64((ms * rate / 1000).rounded())
    }

    /// The schedule for one stem when playback starts at `positionMs` after the
    /// origin. `fileFrames` is the stored file's true length and `rate` its
    /// sample rate. Nil when the stem has already finished by then (or has
    /// nothing to play).
    static func plan(
        stem: JamStemSpec,
        fileFrames: Int64,
        rate: Double,
        originMs: Double,
        positionMs: Double
    ) -> JamStemPlan? {
        let trimStart = frames(forMs: stem.trimStartMs, rate: rate)
        let trimEnd = frames(forMs: stem.trimEndMs, rate: rate)
        let slice = fileFrames - trimStart - trimEnd
        guard slice > 0 else { return nil }

        // The transport starts at this song time.
        let startAt = originMs + positionMs
        let sliceStart = stem.offsetMs

        if startAt <= sliceStart {
            return JamStemPlan(
                delayFrames: frames(forMs: sliceStart - startAt, rate: rate),
                startFrame: trimStart,
                frameCount: slice
            )
        }
        // Already inside the slice: skip what is behind us.
        let skip = frames(forMs: startAt - sliceStart, rate: rate)
        guard skip < slice else { return nil }
        return JamStemPlan(delayFrames: 0, startFrame: trimStart + skip, frameCount: slice - skip)
    }

    /// Where on the song timeline (relative to the origin) a stem's played
    /// slice sits, for drawing: start and end in ms.
    static func span(of stem: JamStemSpec, lengthMs: Double, originMs: Double) -> (start: Double, end: Double) {
        let played = max(0, lengthMs - stem.trimStartMs - stem.trimEndMs)
        return (stem.offsetMs - originMs, stem.offsetMs - originMs + played)
    }
}
