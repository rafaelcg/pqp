import Foundation

// WHERE EACH STEM STARTS, IN FRAMES. The one place a track's numbers become
// arithmetic, so the engine, the video, the lanes and their tests read the
// same definition.
//
//   buffer sample j of a stem sounds at song time  offsetMs + j / rate
//   and only samples in  [trimStartMs, durationMs - trimEndMs)  are heard
//
// `offsetMs` is the song time of the stored file's FIRST sample, and a trim
// hides audio without moving it. That is what the web recorder writes and what
// the web player plays (`planSegment` in `client/src/lib/jam/timeline.ts`, and
// `docs/JAM_ENGINE.md`, "Mapping onto the server's track"), and every track
// that exists was recorded there. A take recorded with a one-bar count-in at
// 120 BPM is uploaded with `offsetMs` about -2023 and `trimStartMs` about 2023:
// the count-in stays in the file, hidden, and the first heard sample is song
// time 0.
//
// The header of `packages/shared/src/jam.ts` words it differently ("offsetMs:
// where the FIRST PLAYED sample sits"), and this file used to follow that
// wording, which put every stem `trimStartMs` early: a track recorded with a
// count-in two seconds ahead of one recorded without, and any head trim made
// in the web editor moving the audio by the length trimmed. The bytes in the
// bucket were written by the web, so the web's reading is the one that plays
// them in time (`JamWebTakeAlignmentTests` measures it on files made by the
// web's own encoder).
//
// The song's zero is not a thing the server fixes. This player zeroes the
// transport at the EARLIEST HEARD sample of any track in the mix, so position 0
// is the first sound anybody makes.

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
    /// Song time of the first heard sample of a stem: its file's first sample,
    /// plus what the head trim hides.
    static func heardStartMs(_ stem: JamStemSpec) -> Double {
        stem.offsetMs + max(0, stem.trimStartMs)
    }

    /// Song time just past the last heard sample, for a stored file of
    /// `lengthMs`.
    static func heardEndMs(_ stem: JamStemSpec, lengthMs: Double) -> Double {
        stem.offsetMs + lengthMs - max(0, stem.trimEndMs)
    }

    /// Where the transport's zero sits on the song timeline: the earliest heard
    /// sample of any stem. Zero with no stems.
    static func originMs(_ stems: [JamStemSpec]) -> Double {
        stems.map(heardStartMs).min() ?? 0
    }

    /// The mix length in ms: from the earliest heard sample to the latest.
    /// `lengthsMs` is each stem's stored length, parallel to `stems`.
    static func durationMs(_ stems: [JamStemSpec], lengthsMs: [Double]) -> Double {
        guard !stems.isEmpty, stems.count == lengthsMs.count else { return 0 }
        let origin = originMs(stems)
        var end = origin
        for (stem, length) in zip(stems, lengthsMs) where heardEndMs(stem, lengthMs: length) > heardStartMs(stem) {
            end = max(end, heardEndMs(stem, lengthMs: length))
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
    ///
    /// The web's invariant, ported: stored frame `j` sounds
    /// `round((offsetMs - startAt) * rate) + j` frames after the transport
    /// starts, so a stem is placed by ONE rounding of its offset and the trims
    /// only decide which frames are heard.
    static func plan(
        stem: JamStemSpec,
        fileFrames: Int64,
        rate: Double,
        originMs: Double,
        positionMs: Double
    ) -> JamStemPlan? {
        let firstHeard = frames(forMs: max(0, stem.trimStartMs), rate: rate)
        let endHeard = fileFrames - frames(forMs: max(0, stem.trimEndMs), rate: rate)
        guard endHeard > firstHeard else { return nil }

        // Where the file's frame 0 falls, in frames after the transport starts
        // (negative: it would have started already).
        let zero = frames(forMs: stem.offsetMs - (originMs + positionMs), rate: rate)
        let delay = max(0, zero + firstHeard)
        let start = delay - zero
        guard start < endHeard else { return nil }
        return JamStemPlan(delayFrames: delay, startFrame: start, frameCount: endHeard - start)
    }

    /// File time in ms of a stem's video at song time `songMs`, clamped into
    /// the heard slice. A take recorded with a camera is cut so its audio's
    /// frame 0 is the video's first frame, so the video's file time is the
    /// audio's: `songMs - offsetMs` (the web's `attachVideo` does the same).
    static func fileMs(
        atSongMs songMs: Double, offsetMs: Double, trimStartMs: Double, trimEndMs: Double, durationMs: Double
    ) -> Double {
        let from = max(0, trimStartMs)
        let to = max(from, durationMs - max(0, trimEndMs))
        return min(to, max(from, songMs - offsetMs))
    }
}
