import AVFoundation
import XCTest
@testable import pqp

/// ADJUSTING A TAKE. The rules are the web's (`client/src/lib/jam-take-edit.ts`
/// and `jam-clip.ts`), and every expected number below was produced by RUNNING
/// those two files on the same inputs (a take with `offsetMs -137, trimStartMs
/// 637, trimEndMs 1000, durationMs 62023`, the web's own worked example), not
/// computed here from the Swift. What this pins is that a take adjusted on a
/// phone and the same take adjusted on the web ask the server for the same
/// numbers, and that the engine hears them.
final class JamTakeEditRulesTests: XCTestCase {
    private func track(
        offset: Double = -137, trimStart: Double = 637, trimEnd: Double = 1000, duration: Double = 62_023, gain: Double = 1
    ) -> JamTrack {
        JamTrack(
            id: "t1", songId: "s1", authorId: "u1", offsetMs: offset, trimStartMs: trimStart,
            trimEndMs: trimEnd, durationMs: duration, gain: gain
        )
    }

    // MARK: Ranges and rounding (the web's `withTrimStart` and friends)

    func testTrimsStayInsideTheRecordingAndLeaveHalfASecondToHear() {
        let t = track()
        let source = JamClipSource(track: t)
        let base = JamClipEdits(track: t)
        // The head may not go past what leaves 500 ms to hear: 62023 - 1000 - 500.
        XCTAssertEqual(base.withTrimStart(70_000, source: source).trimStartMs, 60_523)
        // A posted track does not know the count-in the recorder hid, so a cut may go back to 0.
        XCTAssertEqual(base.withTrimStart(-50, source: source).trimStartMs, 0)
        XCTAssertEqual(base.withTrimStart(1234.5, source: source).trimStartMs, 1235)
        XCTAssertEqual(base.withTrimEnd(90_000, source: source).trimEndMs, 60_886)
        XCTAssertEqual(base.withTrimEnd(-3, source: source).trimEndMs, 0)
    }

    func testAHiddenHeadTheRecorderOwnsIsNeverRevealed() {
        // A take still in the studio: its count-in (2023 ms) is the recorder's, not the person's.
        let source = JamClipSource(baseOffsetMs: -2023, durationMs: 62_023, minTrimStartMs: 2023)
        let edits = JamClipEdits(trimStartMs: 2023, trimEndMs: 0, nudgeMs: 0, gain: 1)
        XCTAssertEqual(edits.withTrimStart(0, source: source).trimStartMs, 2023)
    }

    func testANudgeIsWholeMillisecondsWithinHalfASecondAndRoundsLikeJavaScript() {
        let base = JamClipEdits(track: track())
        XCTAssertEqual(base.withNudge(900).nudgeMs, 500)
        XCTAssertEqual(base.withNudge(-900).nudgeMs, -500)
        // Math.round(0.5) is 1 and Math.round(-0.5) is -0; Swift's rounded() says 1 and -1.
        XCTAssertEqual(base.withNudge(0.5).nudgeMs, 1)
        XCTAssertEqual(base.withNudge(-0.5).nudgeMs, 0)
        XCTAssertEqual(jsRound(-12.5), -12)
        XCTAssertEqual(jsRound(12.5), 13)
        XCTAssertEqual(jsRound(-0.4), 0)
    }

    func testGainRunsZeroToTwo() {
        let base = JamClipEdits(track: track())
        XCTAssertEqual(base.withGain(3).gain, 2)
        XCTAssertEqual(base.withGain(-1).gain, 0)
        XCTAssertEqual(base.withGain(1.25).gain, 1.25)
    }

    func testTheTrimsCannotLeaveNothingToPlayWhateverOrderTheyAreMovedIn() {
        let t = track(trimStart: 0, trimEnd: 0, duration: 3000)
        let source = JamClipSource(track: t)
        var edits = JamClipEdits(track: t)
        edits = edits.withTrimStart(2000, source: source)
        edits = edits.withTrimEnd(2000, source: source)
        XCTAssertGreaterThanOrEqual(edits.audibleMs(durationMs: 3000), JamClipEdits.minAudibleMs)
        edits = edits.withTrimStart(2900, source: source)
        XCTAssertGreaterThanOrEqual(edits.audibleMs(durationMs: 3000), JamClipEdits.minAudibleMs)
        // The server refuses `trimStartMs + trimEndMs >= durationMs` (422 jam_trim_invalid).
        XCTAssertLessThan(edits.trimStartMs + edits.trimEndMs, 3000)
    }

    // MARK: The request

    func testThePatchHoldsOnlyWhatChangedWithTheWebsRounding() {
        let t = track()
        let source = JamClipSource(track: t)
        var edits = JamClipEdits(track: t)
        edits = edits.withTrimStart(900.4, source: source)
        edits = edits.withTrimEnd(1500.6, source: source)
        edits = edits.withNudge(12)
        edits = edits.withGain(1.2349)
        let patch = edits.patch(for: t)
        // The web's `patchFor` on the same take: offset -137 + 12, whole-ms trims, gain to 2 decimals.
        XCTAssertEqual(patch.offsetMs, -125)
        XCTAssertEqual(patch.trimStartMs, 900)
        XCTAssertEqual(patch.trimEndMs, 1501)
        XCTAssertEqual(patch.gain, 1.23)
        XCTAssertNil(patch.inMix)
    }

    func testNothingChangedIsAnEmptyPatchAndHalfAPercentIsNotAChange() {
        let t = track()
        let base = JamClipEdits(track: t)
        XCTAssertTrue(base.patch(for: t).isEmpty)
        XCTAssertTrue(base.withGain(1.004).patch(for: t).isEmpty)
        XCTAssertEqual(base.withGain(1.006).patch(for: t).gain, 1.01)
        // A negative half of a millisecond is 0 on the web, so it is not a nudge.
        XCTAssertTrue(base.withNudge(-0.5).patch(for: track(offset: 0)).isEmpty)
        XCTAssertFalse(base.isEdited(from: t))
        XCTAssertTrue(base.withNudge(10).isEdited(from: t))
    }

    func testTheBodyOnTheWireCarriesOnlyTheChangedFields() throws {
        let t = track()
        let patch = JamClipEdits(track: t).withNudge(-40).withGain(0.5).patch(for: t)
        let json = try JSONSerialization.jsonObject(with: Coding.encoder.encode(patch)) as? [String: Any]
        XCTAssertEqual(Set(json?.keys.map { $0 } ?? []), ["offsetMs", "gain"])
        XCTAssertEqual(json?["offsetMs"] as? Double, -177)
        XCTAssertEqual(json?["gain"] as? Double, 0.5)
        // The mix switch is the same body with one other field, and nothing else.
        let mix = try JSONSerialization.jsonObject(with: Coding.encoder.encode(JamTrackPatchBody(inMix: true))) as? [String: Any]
        XCTAssertEqual(Set(mix?.keys.map { $0 } ?? []), ["inMix"])
    }

    func testPlacedIsTheTakesOwnNumbersWithTheEditsLaidOn() {
        let t = track()
        let placed = JamClipEdits(track: t).withNudge(25).withGain(1.5).placed(t)
        XCTAssertEqual(placed, JamTrackPlacement(offsetMs: -112, trimStartMs: 637, trimEndMs: 1000, gain: 1.5))
    }

    // MARK: Steps

    func testATapIsTenMillisecondsAndAHoldSpeedsUpAtTheWebsThresholds() {
        XCTAssertEqual(JamClipEdits.nudgeStep(heldMs: 0), 10)
        XCTAssertEqual(JamClipEdits.nudgeStep(heldMs: 599), 10)
        XCTAssertEqual(JamClipEdits.nudgeStep(heldMs: 600), 50)
        XCTAssertEqual(JamClipEdits.nudgeStep(heldMs: 1499), 50)
        XCTAssertEqual(JamClipEdits.nudgeStep(heldMs: 1500), 100)
        XCTAssertEqual(JamClipEdits.holdDelayMs, 400)
        XCTAssertEqual(JamClipEdits.repeatMs, 90)
    }

    // MARK: The clip, as the web draws it

    func testSpanReachAndWindowsAreTheWebsNumbers() {
        let t = track()
        let source = JamClipSource(track: t)
        var edits = JamClipEdits(track: t)
        edits = edits.withTrimStart(900.4, source: source).withTrimEnd(1500.6, source: source).withNudge(12).withGain(1.2349)
        let span = JamClipMath.span(source, edits)
        XCTAssertEqual(span.startMs, 775)
        XCTAssertEqual(span.endMs, 60_397)
        let reach = JamClipMath.reach(source, nudgeMs: 12)
        XCTAssertEqual(reach.startMs, -125)
        XCTAssertEqual(reach.endMs, 61_898)
        XCTAssertEqual(JamClipMath.window(source, edits, zoom: .whole), JamClipWindow(startMs: -1037, endMs: 62_786))
        XCTAssertEqual(JamClipMath.window(source, edits, zoom: .close), JamClipWindow(startMs: -225, endMs: 2775))
    }

    func testVolumeAndTimingWords() {
        XCTAssertEqual(JamClipMath.level(ofGain: 0), 0.3, accuracy: 1e-9)
        XCTAssertEqual(JamClipMath.level(ofGain: 0.5), 0.65, accuracy: 1e-9)
        XCTAssertEqual(JamClipMath.level(ofGain: 1), 1, accuracy: 1e-9)
        XCTAssertEqual(JamClipMath.level(ofGain: 2), 1.12, accuracy: 1e-9)
        XCTAssertEqual(JamClipMath.level(ofGain: 5), 1.12, accuracy: 1e-9)
        XCTAssertNil(JamClipMath.volumeDelta(1))
        XCTAssertEqual(JamClipMath.volumeDelta(1.2), "+20%")
        XCTAssertEqual(JamClipMath.volumeDelta(0.25), "-75%")
        XCTAssertEqual(JamClipMath.volumeDelta(2), "+100%")
        XCTAssertEqual(JamClipMath.volumeDelta(0), "-100%")
        XCTAssertNil(JamClipMath.volumeDelta(1.004))
        XCTAssertEqual([0, 0.4, -0.5, 12.5, -12.5, 1000.2].map(JamClipMath.signedMs), ["0 ms", "0 ms", "0 ms", "+13 ms", "-12 ms", "+1000 ms"])
    }

    func testTheTakesBarsAndTheBandEnvelopeAreTheWebsNumbers() {
        let peaks = [0.1, 0.9, 0.3, 0.3, 0.6, 0.05, 0.2, 0.8, 1, 0.4]
        let hidden = JamClipSource(baseOffsetMs: 0, durationMs: 1000, minTrimStartMs: 200)
        XCTAssertEqual(JamClipMath.bars(peaks: peaks, source: hidden, count: 4), [0.3, 0.6, 0.8, 1], accuracy: 1e-9)
        let whole = JamClipSource(baseOffsetMs: 0, durationMs: 1000, minTrimStartMs: 0)
        XCTAssertEqual(JamClipMath.bars(peaks: peaks, source: whole, count: 7), [0.1, 0.9, 0.3, 0.6, 0.2, 0.8, 1], accuracy: 1e-9)
        XCTAssertEqual(JamClipMath.bars(peaks: [], source: whole, count: 3), [0.3, 0.3, 0.3])

        let lanes = [
            JamClipMath.BandLane(JamTrack(id: "a", songId: "s", authorId: "u", offsetMs: 0, trimStartMs: 100, trimEndMs: 50, durationMs: 1000, peaks: peaks)),
            JamClipMath.BandLane(JamTrack(id: "b", songId: "s", authorId: "u", offsetMs: 300, durationMs: 800, peaks: [0.5, 0.25, 0.25, 0.5])),
        ]
        XCTAssertEqual(
            JamClipMath.bandEnvelope(lanes, window: JamClipWindow(startMs: -200, endMs: 1400), count: 9),
            [0, 0.9, 1, 1, 0.5, 1, 1, 1, 0], accuracy: 1e-9
        )
    }

    // MARK: A draft that follows the stored take

    func testAFrameThatMovesTheStoredTakeStartsTheDraftOverFromIt() {
        let t = track()
        var draft = JamAdjustDraft(track: t)
        draft.set(draft.edits.withNudge(30))
        XCTAssertTrue(draft.isDirty(for: t))
        // The same account moved the take somewhere else: its numbers are the truth now.
        let moved = track(offset: -100)
        XCTAssertTrue(draft.reconcile(with: moved, saving: false))
        XCTAssertEqual(draft.edits, JamClipEdits(track: moved))
        XCTAssertFalse(draft.isDirty(for: moved))
    }

    func testAFrameThatMovesNothingTheDraftCanChangeLeavesTheEditsAlone() {
        let t = track()
        var draft = JamAdjustDraft(track: t)
        draft.set(draft.edits.withNudge(30).withGain(1.5))
        // A vote or a label changed the track and nothing the draft can edit.
        var voted = t
        voted.voteCount = 9
        voted.label = "take 2"
        XCTAssertFalse(draft.reconcile(with: voted, saving: false))
        XCTAssertEqual(draft.edits.nudgeMs, 30)
        XCTAssertEqual(draft.edits.gain, 1.5)
    }

    func testWhileASaveIsOutTheDraftIsNotThrownAwayAndAFailedSaveKeepsTheEdits() {
        let t = track()
        var draft = JamAdjustDraft(track: t)
        draft.set(draft.edits.withNudge(30))
        // The echo of this very save arrives before the answer.
        let saved = track(offset: -107)
        XCTAssertFalse(draft.reconcile(with: saved, saving: true))
        XCTAssertEqual(draft.edits.nudgeMs, 30)
        // A save that FAILED leaves the stored take as it was: nothing to follow, the edits stay for another try.
        XCTAssertFalse(draft.reconcile(with: t, saving: false))
        XCTAssertEqual(draft.edits.nudgeMs, 30)
        XCTAssertTrue(draft.isDirty(for: t))
    }

    // MARK: Who may

    func testOnlyATakesAuthorAdjustsItAndOnlyWhileTheFlagIsOn() {
        let mine = track()
        let theirs = JamTrack(id: "t2", songId: "s1", authorId: "u2")
        XCTAssertTrue(JamPermissions.canAdjustTrack(mine, viewerId: "u1", enabled: true))
        XCTAssertFalse(JamPermissions.canAdjustTrack(theirs, viewerId: "u1", enabled: true), "not even the song's author or a moderator")
        XCTAssertFalse(JamPermissions.canAdjustTrack(mine, viewerId: "u1", enabled: false), "jam_channels off")
        XCTAssertFalse(JamPermissions.canAdjustTrack(mine, viewerId: nil, enabled: true))
    }
}

private func XCTAssertEqual(_ a: [Double], _ b: [Double], accuracy: Double, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(a.count, b.count, "length", file: file, line: line)
    for (x, y) in zip(a, b) { XCTAssertEqual(x, y, accuracy: accuracy, "\(a) vs \(b)", file: file, line: line) }
}

// MARK: - Press and hold

@MainActor
final class JamHoldRepeaterTests: XCTestCase {
    func testATapIsExactlyOneStepEvenThoughReleasingCancelsTheDelay() async throws {
        let repeater = JamHoldRepeater()
        var steps: [Double] = []
        repeater.begin(direction: 1, delayMs: 150, repeatMs: 30) { steps.append($0) }
        XCTAssertEqual(steps, [10], "a press steps at once")
        try await Task.sleep(for: .milliseconds(40))
        repeater.end()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(steps, [10], "released during the delay: nothing more, however long it is left")
        XCTAssertFalse(repeater.isHolding)
    }

    /// The boundary: the delay finishes (the sleep RETURNS, it is not cancelled) at the very
    /// moment the finger lifts. A sleeper that releases just before it returns is exactly that.
    func testAReleaseAtTheBoundaryOfTheDelayStepsNoMore() async throws {
        let repeater = JamHoldRepeater()
        var steps: [Double] = []
        repeater.begin(
            direction: 1, delayMs: 50, repeatMs: 30,
            sleep: { _ in repeater.end() },   // returns normally, after the release
            step: { steps.append($0) }
        )
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(steps, [10], "only the press itself")

        // And the same at the boundary of a REPEAT: one repeat, released as its sleep returns.
        var more: [Double] = []
        var sleeps = 0
        let second = JamHoldRepeater()
        second.begin(
            direction: 1, delayMs: 10, repeatMs: 10,
            sleep: { _ in
                sleeps += 1
                if sleeps == 2 { second.end() }   // the sleep after the first repeat
            },
            step: { more.append($0) }
        )
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(more.count, 2, "the press and the one repeat that was already due, none after the release")
    }

    func testAHoldRepeatsAfterTheDelayAndStopsTheMomentItEnds() async throws {
        let repeater = JamHoldRepeater()
        var steps: [Double] = []
        repeater.begin(direction: -1, delayMs: 60, repeatMs: 30) { steps.append($0) }
        try await Task.sleep(for: .milliseconds(260))
        repeater.end()
        let atRelease = steps.count
        XCTAssertGreaterThanOrEqual(atRelease, 4, "the first press and several repeats")
        XCTAssertTrue(steps.allSatisfy { $0 < 0 }, "in the direction of the button")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(steps.count, atRelease, "nothing after the release")
    }
}

// MARK: - The engine hears it

/// `JamEngine.place` moves a stem without reopening its file. Rendered offline
/// (no hardware, no clock), so the frame each click lands on is exact.
@MainActor
final class JamEnginePlaceTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("jam-place-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: directory) }

    private func writeStem(_ name: String, length: Int, spikes: [(Int, Float)]) throws -> URL {
        let url = directory.appendingPathComponent(name + ".wav")
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(length))!
        buffer.frameLength = AVAudioFrameCount(length)
        let data = buffer.floatChannelData![0]
        for i in 0..<length { data[i] = 0 }
        for (frame, amplitude) in spikes { data[frame] = amplitude }
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false,
        ]
        let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        try file.write(from: buffer)
        return url
    }

    private func spikes(_ render: [Float]) -> [Int] { render.indices.filter { abs(render[$0]) > 0.02 } }

    func testPlacingAStemMovesItsFirstSampleAndTheTrimsHideWithoutMoving() throws {
        let band = try writeStem("band", length: 48_000, spikes: [(0, 0.9)])
        let take = try writeStem("take", length: 48_000, spikes: [(0, 0.5), (4_800, 0.6), (47_000, 0.7)])
        let engine = JamEngine()
        let base = JamEngine.Stem(id: "band", url: band, offsetMs: 0, trimStartMs: 0, trimEndMs: 0)
        engine.load([base, .init(id: "take", url: take, offsetMs: 0, trimStartMs: 0, trimEndMs: 0)])
        XCTAssertEqual(spikes(try engine.renderOffline(fromPositionMs: 0, frameCount: 60_000)), [0, 4_800, 47_000])

        // Moved 100 ms later: every click of the take sits 4800 frames later, the band stays.
        let later = JamEngine.Stem(id: "take", url: take, offsetMs: 100, trimStartMs: 0, trimEndMs: 0)
        XCTAssertTrue(engine.place(later))
        XCTAssertTrue(engine.holds([base, later]))
        XCTAssertEqual(spikes(try engine.renderOffline(fromPositionMs: 0, frameCount: 60_000)), [0, 4_800, 9_600, 51_800])

        // Cut 50 ms off the head and 50 ms off the tail: the first and last clicks are hidden, and
        // the middle one has not moved (a trim hides audio and never moves it).
        let cut = JamEngine.Stem(id: "take", url: take, offsetMs: 100, trimStartMs: 50, trimEndMs: 50)
        XCTAssertTrue(engine.place(cut))
        XCTAssertEqual(spikes(try engine.renderOffline(fromPositionMs: 0, frameCount: 60_000)), [0, 9_600])
        XCTAssertFalse(engine.holds([base, later]))
    }

    func testSeveralStemsArePlacedInOneCallAndTheMixIsRecomputedOnce() throws {
        let a = try writeStem("a", length: 48_000, spikes: [(0, 0.9)])
        let b = try writeStem("b", length: 48_000, spikes: [(0, 0.6)])
        let engine = JamEngine()
        let sa = JamEngine.Stem(id: "a", url: a, offsetMs: 0, trimStartMs: 0, trimEndMs: 0)
        let sb = JamEngine.Stem(id: "b", url: b, offsetMs: 0, trimStartMs: 0, trimEndMs: 0)
        engine.load([sa, sb])
        let moved = [
            JamEngine.Stem(id: "a", url: a, offsetMs: 50, trimStartMs: 0, trimEndMs: 0),
            JamEngine.Stem(id: "b", url: b, offsetMs: 100, trimStartMs: 0, trimEndMs: 0),
            JamEngine.Stem(id: "ghost", url: a, offsetMs: 5, trimStartMs: 0, trimEndMs: 0),
        ]
        XCTAssertEqual(engine.place(moved), 2, "the stem that is not loaded is not placed")
        XCTAssertEqual(engine.originMs, 50)
        XCTAssertEqual(spikes(try engine.renderOffline(fromPositionMs: 0, frameCount: 20_000)), [0, 2_400])
    }

    func testAStemMovedEarlierThanTheBandMovesTheTransportsZeroToItsFirstHeardSample() throws {
        let band = try writeStem("band", length: 48_000, spikes: [(0, 0.9)])
        let take = try writeStem("take", length: 24_000, spikes: [(0, 0.5)])
        let engine = JamEngine()
        engine.load([
            .init(id: "band", url: band, offsetMs: 0, trimStartMs: 0, trimEndMs: 0),
            .init(id: "take", url: take, offsetMs: 0, trimStartMs: 0, trimEndMs: 0),
        ])
        XCTAssertEqual(engine.originMs, 0)
        engine.place(.init(id: "take", url: take, offsetMs: -250, trimStartMs: 0, trimEndMs: 0))
        // The mix now starts where the take does; the song's moment is the model's to keep.
        XCTAssertEqual(engine.originMs, -250)
        XCTAssertEqual(engine.durationMs, 1250, accuracy: 0.01)
        XCTAssertEqual(spikes(try engine.renderOffline(fromPositionMs: 0, frameCount: 60_000)), [0, 12_000])
    }

    func testAnUnknownStemOrAnotherFileIsNotPlaced() throws {
        let a = try writeStem("a", length: 4_800, spikes: [(0, 0.9)])
        let b = try writeStem("b", length: 4_800, spikes: [(0, 0.9)])
        let engine = JamEngine()
        engine.load([.init(id: "a", url: a, offsetMs: 0, trimStartMs: 0, trimEndMs: 0)])
        XCTAssertFalse(engine.place(.init(id: "nope", url: a, offsetMs: 5, trimStartMs: 0, trimEndMs: 0)))
        XCTAssertFalse(engine.place(.init(id: "a", url: b, offsetMs: 5, trimStartMs: 0, trimEndMs: 0)), "another file needs `load`")
    }
}
