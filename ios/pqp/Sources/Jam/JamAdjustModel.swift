import Foundation
import Observation

/// ADJUSTING ONE POSTED TAKE: the order of things behind the sheet.
///
/// The rules are `JamTakeEditRules` (the web's, number for number); what this
/// adds is the side that has to be right on a phone:
///
///  - every change is HEARD at once (`JamSongModel.preview`: the volume now, the
///    place within a frame of the drag), and NOTHING is sent until Save;
///  - Save sends only what changed (`JamClipEdits.patch`), and the answer is
///    applied to the song the way its live frame is;
///  - a live frame that MOVES the stored take (the same account changed it on
///    the web, or this phone's own save echoing back) starts the draft over from
///    the stored numbers, unless a save is out, and a frame that moves nothing
///    the draft can change (a vote, a label) leaves the person's edits alone
///    (`JamAdjustDraft.reconcile`);
///  - a refusal is said in words, and a permission one reads the song's
///    permissions again, because the sheet was offered on stale ones.
@MainActor
@Observable
final class JamAdjustModel {
    let song: JamSongModel
    let trackId: String

    private(set) var draft: JamAdjustDraft
    var zoom: JamClipMath.Zoom = .whole
    private(set) var saving = false
    private(set) var failure: JamEditFailure?
    /// Bumped by a save that landed, for the one small confirmation.
    private(set) var savedRevision = 0
    /// The edits were thrown away because the same account changed this take
    /// somewhere else: said in one line until the person moves anything again.
    private(set) var updatedElsewhere = false

    init(song: JamSongModel, track: JamTrack) {
        self.song = song
        trackId = track.id
        draft = JamAdjustDraft(track: track)
    }

    /// The take as stored (nil once somebody deleted it: the sheet closes).
    var track: JamTrack? { song.tracks.first { $0.id == trackId } }
    var edits: JamClipEdits { draft.edits }
    var source: JamClipSource? { track.map(JamClipSource.init(track:)) }

    var patch: JamTrackPatchBody { track.map { draft.patch(for: $0) } ?? JamTrackPatchBody() }
    var isDirty: Bool { !patch.isEmpty }

    /// The other in-mix lanes, drawn behind the take.
    var band: [JamClipMath.BandLane] {
        song.tracks.filter { $0.inMix && $0.id != trackId }.map(JamClipMath.BandLane.init)
    }

    // MARK: - Hearing it

    func hear(_ next: JamClipEdits) {
        // While a save is out the draft is what it is sending: a later drag would
        // be in the draft only, and the answer closes the sheet over it.
        guard let track, !saving else { return }
        draft.set(next)
        failure = nil
        updatedElsewhere = false
        song.preview(track, edits: next)
    }

    func trimStart(_ ms: Double) {
        guard let source else { return }
        hear(edits.withTrimStart(ms, source: source))
    }

    func trimEnd(_ ms: Double) {
        guard let source else { return }
        hear(edits.withTrimEnd(ms, source: source))
    }

    func nudge(to ms: Double) { hear(edits.withNudge(ms)) }
    func nudge(by deltaMs: Double) { hear(edits.withNudge(edits.nudgeMs + deltaMs)) }
    func gain(_ value: Double) { hear(edits.withGain(value)) }

    /// Everything back to what is stored.
    func reset() {
        guard let track, !saving else { return }
        draft.reset(to: track)
        failure = nil
        song.clearPreview(trackId: trackId)
    }

    // MARK: - Following the song

    /// Called when the stored take changed under the sheet (a live frame, or
    /// this sheet's own save). See the rule at the top.
    func reconcile() {
        guard let track else { return }
        if draft.reconcile(with: track, saving: saving) {
            song.clearPreview(trackId: trackId)
            updatedElsewhere = true
            failure = nil
        }
    }

    // MARK: - Sending it

    /// True when it landed (the sheet then closes).
    func save() async -> Bool {
        guard let track, !saving else { return false }
        let body = draft.patch(for: track)
        guard !body.isEmpty else { return false }
        saving = true
        failure = nil
        defer { saving = false }
        do {
            try await song.saveAdjustment(track, patch: body)
            // Its own answer is the stored take now: the draft starts from it quietly,
            // so the echo is not read as "changed on another device".
            if let stored = self.track { draft.reset(to: stored) }
            savedRevision += 1
            return true
        } catch {
            if error.isCancellation { return false }
            failure = JamEditFailure.of(error)
            if failure?.isDenied == true { await song.refreshPermissions() }
            // The flag went off under an open song: its affordances are read again.
            if failure == .kind(.off) { await song.refreshConfig() }
            return false
        }
    }
}
