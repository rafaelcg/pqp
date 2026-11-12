import SwiftUI

/// RECORD A PART. A full-screen studio: pick what you play, check the
/// headphones, count in, play over the band, hear it back with the band, send.
/// It looks like a recorder and not a form: one big button, the band's lanes in
/// view the whole time, a large clock.
///
/// The flow and the wording follow the web's studio (`jam-studio.tsx`), with
/// one deliberate difference: there is no camera in this build.
struct JamStudioView: View {
    @Environment(SessionStore.self) private var session
    @Environment(VoiceModel.self) private var voice
    @Environment(CallModel.self) private var call
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.openURL) private var openURL

    @State private var model: JamRecordModel
    @State private var confirmingLeave = false
    @State private var showingCalibration = false
    @State private var finished = false
    /// Called once, when the studio closes: the song and track that were sent,
    /// or nil.
    let onClose: ((song: JamSongSummary, track: JamTrack)?) -> Void

    init(model: JamRecordModel, onClose: @escaping ((song: JamSongSummary, track: JamTrack)?) -> Void) {
        _model = State(initialValue: model)
        self.onClose = onClose
    }

    private var callActive: Bool { voice.holdsSeat || call.phase.isInRoom }
    private var tint: Color { model.instrument.color }

    var body: some View {
        ZStack {
            background
            VStack(spacing: 0) {
                topBar
                content
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        .preferredColorScheme(.dark)
        .task {
            model.callActive = callActive
            JamRecordModel.sweepOldTakes()
            await model.prepare(session: session)
        }
        .onChange(of: callActive) { _, now in model.callStateChanged(active: now) }
        .onChange(of: model.calibration) { _, state in
            showingCalibration = state != .idle
        }
        .sheet(isPresented: $showingCalibration, onDismiss: { model.dismissCalibration() }) {
            JamCalibrationSheet(model: model)
        }
        .confirmationDialog(leaveTitle, isPresented: $confirmingLeave, titleVisibility: .visible) {
            Button(leaveAction, role: .destructive) { finish(nil) }
            Button(model.leaving == .recording ? "Keep recording" : "Keep the recording", role: .cancel) {}
        } message: {
            Text(model.leaving == .recording
                 ? "What you have recorded so far is lost."
                 : "It has not been sent to the band yet.")
        }
        .confirmationDialog("This recording has no sound", isPresented: $model.confirmingSilent, titleVisibility: .visible) {
            Button("Send anyway") { model.send(confirmedSilent: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The microphone did not pick anything up. Send it anyway?")
        }
        .task(id: model.phase) {
            guard model.phase == .done else { return }
            try? await Task.sleep(for: .seconds(1.3))
            // Closed by hand during the wait: the view's task is cancelled and
            // `finish` has already run.
            guard !Task.isCancelled else { return }
            finish(model.posted)
        }
        .sensoryFeedback(.impact(weight: .heavy), trigger: model.phase == .recording)
        .sensoryFeedback(.success, trigger: model.phase == .done)
        .interactiveDismissDisabled()
    }

    private func finish(_ result: (song: JamSongSummary, track: JamTrack)?) {
        // Once: a second close (the done screen's timer after a tap on X) would
        // resume the song twice.
        guard !finished else { return }
        finished = true
        model.tearDown()
        onClose(result)
    }

    private func requestClose() {
        switch model.leaving {
        case .nothing: finish(model.posted)
        default: confirmingLeave = true
        }
    }

    private var leaveTitle: LocalizedStringKey {
        model.leaving == .recording ? "Stop and discard the recording?" : "Discard this recording?"
    }

    private var leaveAction: LocalizedStringKey { "Discard" }

    // MARK: Chrome

    private var background: some View {
        ZStack {
            Palette.ink
            LinearGradient(
                colors: [tint.opacity(model.phase == .recording ? 0.10 : 0.20), .clear],
                startPoint: .top, endPoint: .center
            )
            if model.phase == .recording || model.phase == .countIn {
                RadialGradient(
                    colors: [Palette.danger.opacity(0.16), .clear], center: .bottom, startRadius: 10, endRadius: 420
                )
            }
        }
        .ignoresSafeArea()
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.6), value: model.phase)
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Button(action: requestClose) {
                Image(systemName: "xmark")
                    .font(JamFont.text(16, .bold))
                    .foregroundStyle(Palette.paper)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Palette.surface.opacity(0.9)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Back"))
            .accessibilityIdentifier("jam.studio.close")
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: model.songTitle.isEmpty ? String(localized: "New song") : model.songTitle)
                    .font(JamFont.text(15, .bold))
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                Text(verbatim: subtitle)
                    .font(JamFont.text(12))
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var subtitle: String {
        if model.isNewSong { return String(localized: "The first track of a new song") }
        let names = model.band.compactMap(\.authorName)
        var seen = Set<String>()
        let unique = names.filter { seen.insert($0).inserted }
        if unique.isEmpty { return String(localized: "The first track of a new song") }
        return String(localized: "On top of \(ListFormatter.localizedString(byJoining: Array(unique.prefix(3))))")
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .preparing:
            ProgressView().tint(Palette.signal).frame(maxHeight: .infinity)
        case .setup: setup
        case .countIn, .recording: recording
        case .building:
            VStack(spacing: 14) {
                ProgressView().tint(Palette.signal)
                Text("Getting your recording ready").font(JamFont.text(15, .semibold)).foregroundStyle(Palette.paperMuted)
            }
            .frame(maxHeight: .infinity)
        case .review: review
        case .sending, .done: sending
        }
    }

    // MARK: Setup

    private var setup: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("What are you playing?")
                        .font(JamFont.title(28)).foregroundStyle(Palette.paper)
                        .accessibilityAddTraits(.isHeader)
                    Text(model.band.isEmpty
                         ? "You start the song. Hit the red button and play it your way. Whoever comes next records on top."
                         : "Put your headphones on and hit the red button. The band plays in your ears and your recording lands in time.")
                        .font(JamFont.text(14)).foregroundStyle(Palette.paperMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, Metrics.hPadding)
                // Above the fold on purpose: "too short", "microphone off" and
                // "leave the call" are the reason the person is looking at this
                // screen again, and at the bottom they sat behind the Record bar.
                noticeView

                JamInstrumentPicker(
                    selection: Binding(get: { model.instrument }, set: { model.instrument = $0 }),
                    addable: model.addable, asked: askedInstruments
                )
                if !model.band.isEmpty { bandCard }
                JamRouteCard(route: model.route, latency: model.latency) { model.askToCalibrate() }
                countInRow
                if model.downloadFailed { retryBand }
            }
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
    }

    private var askedInstruments: [JamInstrument] {
        if case .song(let song) = model.destination, case .missing(let list) = JamNeed.of(song) { return list }
        return []
    }

    private var bandCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("The band")
                    .font(JamFont.text(13, .bold)).foregroundStyle(Palette.paperMuted)
                    .textCase(.uppercase).tracking(1)
                Spacer(minLength: 0)
                if let progress = model.loading {
                    ProgressView().controlSize(.small).tint(Palette.signal)
                    Text("Getting the tracks \(progress.done) of \(progress.total)")
                        .font(JamFont.text(12)).foregroundStyle(Palette.paperMuted)
                } else {
                    Button { model.togglePlay() } label: {
                        Label(model.isPlaying ? "Pause" : "Listen to the band",
                              systemImage: model.isPlaying ? "pause.fill" : "play.fill")
                            .font(JamFont.text(13, .semibold))
                            .foregroundStyle(Palette.paper)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 44)
                            .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 1))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(model.refusal != nil || model.reviewDurationMs <= 0)
                    .accessibilityIdentifier("jam.studio.hearBand")
                }
            }
            .padding(.horizontal, Metrics.hPadding)
            let tl = model.bandTimeline
            JamStudioLanes(
                tracks: model.band, originMs: tl.originMs, spanMs: max(1, tl.durationMs),
                moving: model.isPlaying, position: { model.positionMs }, laneHeight: 38
            )
        }
    }

    private var countInRow: some View {
        Toggle(isOn: $model.countInOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Count in before starting").font(JamFont.text(15, .semibold)).foregroundStyle(Palette.paper)
                Text(model.band.isEmpty
                     ? "Four clicks, then recording starts. It changes nothing in the song."
                     : "Four clicks, then the band comes in. It changes nothing in the song.")
                    .font(JamFont.text(12)).foregroundStyle(Palette.paperMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .tint(Palette.signal)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.surface))
        .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).strokeBorder(Palette.border, lineWidth: 1))
        .padding(.horizontal, Metrics.hPadding)
        .accessibilityIdentifier("jam.studio.countIn")
    }

    private var retryBand: some View {
        Button {
            Task { await model.retryBand() }
        } label: {
            Label("Some tracks did not download. Tap to try again", systemImage: "arrow.clockwise")
                .font(JamFont.text(13, .semibold)).foregroundStyle(Palette.warning)
        }
        .padding(.horizontal, Metrics.hPadding)
    }

    // MARK: Notices

    @ViewBuilder
    private var noticeView: some View {
        if let refusal = model.refusal {
            banner(
                refusal == .inCall
                    ? "Recording needs you to leave the call. Leave the call, then come back here."
                    : "", tone: Palette.warning, id: "jam.studio.callNotice"
            )
        }
        if let notice = model.notice, let text = noticeText(notice) {
            banner(text, tone: noticeIsGood(notice) ? Palette.warning : Palette.danger, id: "jam.studio.notice") {
                if notice == .micDenied {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                    .font(JamFont.text(13, .bold)).foregroundStyle(Palette.paper)
                    .frame(minHeight: 44)
                } else if notice == .buildFailed {
                    Button("Try again") { model.retryBuild() }
                        .font(JamFont.text(13, .bold)).foregroundStyle(Palette.paper)
                        .frame(minHeight: 44)
                }
            }
        }
    }

    private func noticeIsGood(_ notice: JamRecordModel.Notice) -> Bool {
        if case .stopped(_, let kept) = notice { return kept }
        if case .unplayable = notice { return true }
        return false
    }

    private func noticeText(_ notice: JamRecordModel.Notice) -> LocalizedStringKey? {
        switch notice {
        case .micDenied: "The microphone is blocked. Allow it in Settings and try again."
        case .noInput: "No microphone found."
        case .startFailed: "Could not start recording. Try again."
        case .diskFailed: "The phone ran out of space and the recording stopped."
        case .buildFailed: "Could not get your recording ready. Free some space on the phone and try again."
        case .tooShort: "That was too short. Keep playing a little longer."
        case .unplayable: "Some tracks of the band do not play on iPhone yet, so you will not hear them while you record."
        case .stopped(let cause, let kept):
            switch (cause, kept) {
            case (.microphone, true): "The microphone stopped working, so the recording stopped. What you played up to then is kept: listen to it and send it, or record again."
            case (.microphone, false): "The microphone stopped working before anything was recorded. Check it and record again."
            case (.interruption, true): "Something interrupted the recording, like a call. What you played up to then is kept: listen to it and send it, or record again."
            case (.interruption, false): "Something interrupted the recording before anything was recorded. Record again."
            case (.route, true): "The headphones or the audio output changed, so the recording stopped. What you played up to then is kept: listen to it and send it, or record again."
            case (.route, false): "The headphones or the audio output changed before anything was recorded. Check them and record again."
            }
        }
    }

    private func banner(
        _ text: LocalizedStringKey, tone: Color, id: String, @ViewBuilder action: () -> some View = { EmptyView() }
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label {
                Text(text)
                    .font(JamFont.text(13, .semibold)).foregroundStyle(Palette.paper)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(tone)
            }
            action()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(tone.opacity(0.12)))
        .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).strokeBorder(tone.opacity(0.5), lineWidth: 1))
        .padding(.horizontal, Metrics.hPadding)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(id)
    }

    // MARK: Recording

    private var recording: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 4)
            if model.phase == .countIn {
                VStack(spacing: 4) {
                    Text("Get ready")
                        .font(JamFont.text(16, .semibold)).foregroundStyle(Palette.paperMuted)
                    Text(verbatim: model.beat > 0 ? "\(model.beat)" : " ")
                        .font(.system(size: 120, weight: .heavy, design: .rounded).monospacedDigit())
                        .foregroundStyle(Palette.paper)
                        .contentTransition(.numericText())
                        .animation(reduceMotion ? nil : .snappy(duration: 0.18), value: model.beat)
                        .accessibilityIdentifier("jam.studio.beat")
                }
            } else {
                VStack(spacing: 2) {
                    HStack(spacing: 8) {
                        Circle().fill(Palette.danger).frame(width: 10, height: 10)
                        Text("Recording \(model.instrument.name)")
                            .font(JamFont.text(16, .semibold)).foregroundStyle(Palette.paper)
                    }
                    clock
                }
            }
            lanes
            JamLevelMeter(level: model.level, tint: tint)
                .padding(.horizontal, Metrics.hPadding * 2)
            // A first track has no band to play along with or to come in.
            Text(model.phase == .countIn
                 ? (model.band.isEmpty ? "Four clicks, then you play." : "Four clicks, then the band comes in.")
                 : (model.band.isEmpty
                    ? "Hit the square when you are done."
                    : "Play along with the band. Hit the square when you are done."))
                .font(JamFont.text(13)).foregroundStyle(Palette.paperMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Metrics.hPadding * 2)
            Spacer(minLength: 4)
        }
    }

    private var clock: some View {
        let ms = max(0, model.elapsedMs)
        let tenth = Int(ms / 100) % 10
        return HStack(alignment: .firstTextBaseline, spacing: 2) {
            Text(verbatim: JamTime.clock(ms))
                .font(.system(size: 76, weight: .bold, design: .rounded).monospacedDigit())
            Text(verbatim: ".\(tenth)")
                .font(.system(size: 28, weight: .semibold, design: .rounded).monospacedDigit())
                .foregroundStyle(Palette.paperMuted)
        }
        .foregroundStyle(Palette.paper)
        .minimumScaleFactor(0.6)
        .lineLimit(1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Recording \(JamTime.clock(ms))"))
        .accessibilityIdentifier("jam.studio.clock")
    }

    private var lanes: some View {
        let bandTl = model.bandTimeline
        let span = JamStudioTimeline.recordingSpanMs(bandMs: bandTl.durationMs, elapsedMs: model.elapsedMs)
        return ScrollView {
            JamStudioLanes(
                tracks: model.band, originMs: bandTl.originMs, spanMs: span,
                live: .init(instrument: model.instrument, levels: model.levels, elapsedMs: max(0, model.elapsedMs)),
                moving: model.phase == .recording, position: { max(0, model.elapsedMs) }
            )
            .padding(.vertical, 4)
        }
        .scrollIndicators(.hidden)
        .frame(height: min(340, CGFloat(model.band.count + 1) * 50 + 8))
    }

    // MARK: Review

    private var review: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Sounds good?")
                        .font(JamFont.title(28)).foregroundStyle(Palette.paper)
                        .accessibilityAddTraits(.isHeader)
                    Text(model.band.isEmpty
                         ? "Listen back. If you like it, send it to the band."
                         : "Your recording is already playing with the band, in time. If you like it, send it to the band.")
                        .font(JamFont.text(14)).foregroundStyle(Palette.paperMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, Metrics.hPadding)
                noticeView
                if model.take?.isSilent == true {
                    banner("The microphone did not pick anything up. Send it anyway?", tone: Palette.warning, id: "jam.studio.silent")
                }
                let tl = model.timeline
                JamStudioLanes(
                    tracks: model.lanes, originMs: tl.originMs, spanMs: max(1, tl.durationMs),
                    highlightId: JamRecordModel.takeId, moving: model.isPlaying,
                    position: { model.positionMs }, laneHeight: 48
                )
                transport(duration: tl.durationMs)
                nudgeCard
                latencyNote
            }
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
    }

    private func transport(duration: Double) -> some View {
        HStack(spacing: 14) {
            Button { model.togglePlay() } label: {
                Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                    .font(JamFont.text(22, .bold))
                    .foregroundStyle(Palette.inkDeep)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 56, height: 56)
                    .background(Circle().fill(Palette.signal))
            }
            .buttonStyle(JamTilePressStyle(reduceMotion: reduceMotion))
            .accessibilityLabel(Text(model.isPlaying ? "Pause" : "Play"))
            .accessibilityIdentifier("jam.studio.play")
            TimelineView(.animation(minimumInterval: 0.2, paused: !model.isPlaying)) { _ in
                let _ = model.seekRevision
                Text(verbatim: "\(JamTime.clock(model.positionMs)) / \(JamTime.clock(duration))")
                    .font(JamFont.text(15, .medium).monospacedDigit())
                    .foregroundStyle(Palette.paperMuted)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.hPadding)
    }

    private var nudgeCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Adjust the timing")
                    .font(JamFont.text(13, .bold)).foregroundStyle(Palette.paperMuted)
                    .textCase(.uppercase).tracking(1)
                Spacer(minLength: 0)
                if model.edits.isEdited {
                    Button("Back to automatic") { model.resetNudge() }
                        .font(JamFont.text(13, .semibold)).foregroundStyle(Palette.paper)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("jam.studio.nudgeReset")
                }
            }
            // The reset button's 44 pt would push the nudge buttons down under a
            // finger that is holding one the moment the first step appears.
            .frame(minHeight: 44)
            HStack(spacing: 10) {
                JamNudgeButton(title: "Move earlier", symbol: "backward.frame.fill", direction: -1) { model.nudge(by: $0) }
                Text(verbatim: Self.nudgeText(model.edits.nudgeMs))
                    .font(JamFont.text(20, .bold).monospacedDigit())
                    .foregroundStyle(model.edits.isEdited ? Palette.paper : Palette.paperMuted)
                    .frame(minWidth: 84)
                    .accessibilityIdentifier("jam.studio.nudgeValue")
                JamNudgeButton(title: "Move later", symbol: "forward.frame.fill", direction: 1) { model.nudge(by: $0) }
            }
        }
        .padding(.horizontal, Metrics.hPadding)
    }

    static func nudgeText(_ ms: Double) -> String {
        let value = Int(ms)
        if value == 0 { return "0 ms" }
        return "\(value > 0 ? "+" : "\u{2212}")\(abs(value)) ms"
    }

    private var latencyNote: some View {
        let ms = Int((model.take?.clock.roundTripMs ?? model.latency.roundTripMs).rounded())
        let method = model.take?.latencyMethod ?? model.latency.method
        return Text(method == .estimate
                    ? "Estimated delay \(ms) ms. If your part lands out of time, calibrate."
                    : "Delay corrected by \(ms) ms")
            .font(JamFont.text(12)).foregroundStyle(Palette.paperMuted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Metrics.hPadding)
            .accessibilityIdentifier("jam.studio.latencyNote")
    }

    // MARK: Sending

    private var sending: some View {
        VStack(spacing: 18) {
            Spacer()
            if model.phase == .done {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 72)).foregroundStyle(Palette.signal)
                    .symbolEffect(.bounce, value: reduceMotion ? false : model.phase == .done)
                Text(model.posted?.track.inMix == false ? "Sent. Your recording is waiting as another version of the song." : "Sent. Your part is in the song.")
                    .font(JamFont.title(22)).foregroundStyle(Palette.paper)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("jam.studio.done")
            } else if let error = model.sendError {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 48)).foregroundStyle(Palette.warning)
                Text(Self.message(for: error))
                    .font(JamFont.text(16, .semibold)).foregroundStyle(Palette.paper)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Metrics.hPadding * 2)
                    .accessibilityIdentifier("jam.studio.sendError")
                VStack(spacing: 10) {
                    if error == .gone {
                        bigButton("Send as a new song", primary: true, id: "jam.studio.asNew") { model.sendAsNewSong() }
                    } else if !error.isFinal {
                        bigButton("Try again", primary: true, id: "jam.studio.retry") { model.send(confirmedSilent: true) }
                    }
                    bigButton(error == .gone ? "Discard the recording" : "Back to the recording", primary: false, id: "jam.studio.backToReview") {
                        if error == .gone { finish(nil) } else { model.backToReview() }
                    }
                }
                .padding(.horizontal, Metrics.hPadding * 2)
            } else {
                ZStack {
                    Circle().stroke(Palette.surfaceRaised, lineWidth: 8)
                    Circle().trim(from: 0, to: model.progress)
                        .stroke(Palette.signal, style: StrokeStyle(lineWidth: 8, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: model.progress)
                    Text(verbatim: "\(Int(model.progress * 100))%")
                        .font(JamFont.text(22, .bold).monospacedDigit()).foregroundStyle(Palette.paper)
                }
                .frame(width: 120, height: 120)
                Text("Sending to the band")
                    .font(JamFont.text(16, .semibold)).foregroundStyle(Palette.paperMuted)
                    .accessibilityIdentifier("jam.studio.sending")
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    static func message(for error: JamErrorKind) -> LocalizedStringKey {
        switch error {
        case .off: "Recording is paused on this server."
        case .closed: "This song is closed to new recordings."
        case .instrumentNotWanted: "This song is not looking for that instrument."
        case .songFull: "This song has no room for more tracks."
        case .authorTrackLimit: "You already sent too many tracks to this song."
        case .tooLarge: "The file came out too large."
        case .storageOff: "This server cannot store recordings yet."
        case .rateLimited: "Easy, that is a lot at once. Try again in a moment."
        case .network: "No connection. Check your internet and try again."
        case .gone: "Somebody deleted this song. Your recording is safe: send it as a new song, or discard it."
        case .other: "That did not work. Try again."
        }
    }

    // MARK: Bottom bar

    @ViewBuilder
    private var bottomBar: some View {
        switch model.phase {
        case .setup:
            VStack(spacing: 8) {
                JamRecordButton(kind: .record, enabled: model.canRecord) {
                    Task { await model.startRecording() }
                }
                .accessibilityIdentifier("jam.studio.record")
                Text(model.refusal != nil ? "Leave the call to record" : "Record")
                    .font(JamFont.text(13, .semibold)).foregroundStyle(Palette.paperMuted)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Palette.ink.ignoresSafeArea(edges: .bottom))
            .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
        case .countIn:
            barStack { JamRecordButton(kind: .cancel) { model.cancelRecording() }.accessibilityIdentifier("jam.studio.cancel") }
        case .recording:
            barStack { JamRecordButton(kind: .stop) { model.stopRecording() }.accessibilityIdentifier("jam.studio.stop") }
        case .review:
            HStack(spacing: 12) {
                Button { model.recordAgain() } label: {
                    Text("Record again")
                        .font(JamFont.text(16, .bold)).foregroundStyle(Palette.paper)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 1.5))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("jam.studio.again")
                Button { model.send() } label: {
                    Text("Send to the band")
                        .font(JamFont.text(16, .bold)).foregroundStyle(Palette.inkDeep)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background(Capsule().fill(Palette.signal))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("jam.studio.send")
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.vertical, 10)
            .background(Palette.ink.ignoresSafeArea(edges: .bottom))
            .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
        default:
            EmptyView()
        }
    }

    private func barStack<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
    }

    private func bigButton(_ title: LocalizedStringKey, primary: Bool, id: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title)
                .font(JamFont.text(16, .bold))
                .foregroundStyle(primary ? Palette.inkDeep : Palette.paper)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(Capsule().fill(primary ? Palette.signal : .clear))
                .overlay(Capsule().strokeBorder(primary ? .clear : Palette.border, lineWidth: 1.5))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}
