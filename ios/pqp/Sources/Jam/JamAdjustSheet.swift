import SwiftUI

// ADJUSTING A TAKE: the web's clip editor (`jam-clip-editor.tsx`) on a phone.
// The take is a clip on the song's one timeline with the band's waveform drawn
// behind it, so lining it up is SEEN and not guessed: drag an end to cut it,
// drag the middle to move it in time, or hold "Earlier" / "Later" (a tap is
// 10 ms and holding speeds up), and one volume. Every change is heard at once
// and nothing is sent until Save. Every handle is also an adjustable element
// for VoiceOver, and every target is 44 pt.

struct JamAdjustSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let song: JamSongModel
    @State private var model: JamAdjustModel
    @State private var grabbing = false

    init(song: JamSongModel, track: JamTrack) {
        self.song = song
        _model = State(initialValue: JamAdjustModel(song: song, track: track))
    }

    private var track: JamTrack? { model.track }
    /// The numbers an edit can change, as stored: when they move under the
    /// sheet (a live frame, this sheet's own save) the draft follows them.
    private var storedKey: JamStoredTake? { track.map(JamStoredTake.init) }

    var body: some View {
        NavigationStack {
            Group {
                if let track, let source = model.source {
                    content(track: track, source: source)
                } else {
                    // Somebody deleted the take under the sheet.
                    EmptyState(
                        icon: "trash", title: "This recording is gone",
                        message: "Somebody took it down while you were adjusting it.",
                        actionTitle: "Close", action: { dismiss() }
                    )
                }
            }
            .background(Palette.ink.ignoresSafeArea())
            .navigationTitle("Adjust")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.ink, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        Haptics.selection()
                        if model.isDirty { model.reset() }
                        dismiss()
                    } label: {
                        model.isDirty ? Text("Back to saved") : Text("Close")
                    }
                    .tint(Palette.paper)
                    .disabled(model.saving)
                    .accessibilityIdentifier("jam.adjust.close")
                }
                ToolbarItem(placement: .confirmationAction) { saveButton }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Palette.ink)
        // A swipe down would throw the edits away without a word; the button says it.
        .interactiveDismissDisabled(model.isDirty || model.saving)
        .onChange(of: storedKey) { _, _ in model.reconcile() }
        .onDisappear { song.endAdjust() }
    }

    // MARK: Content

    private func content(track: JamTrack, source: JamClipSource) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header(track)
                zoomAndLegend(track)
                JamClipEditorView(
                    track: track, source: source, edits: model.edits, band: model.band, zoom: model.zoom,
                    song: song, grabbing: $grabbing,
                    onTrimStart: { model.trimStart($0) },
                    onTrimEnd: { model.trimEnd($0) },
                    onNudge: { model.nudge(to: $0) }
                )
                timingCard(track)
                volumeCard(track)
                if let failure = model.failure { failureRow(failure) }
                if model.isDirty { resetRow }
                Color.clear.frame(height: 4)
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.top, 8)
            .padding(.bottom, 12)
            .animation(.jam(reduceMotion: reduceMotion), value: model.isDirty)
            .animation(.jam(reduceMotion: reduceMotion), value: model.failure)
        }
        .scrollDisabled(grabbing)
        .safeAreaInset(edge: .bottom, spacing: 0) { transport }
        // Nothing is edited while a save is out (the model refuses too).
        .disabled(model.saving)
    }

    private func header(_ track: JamTrack) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Circle().fill(track.instrument.color).frame(width: 10, height: 10).accessibilityHidden(true)
                Text("Adjusting your \(track.instrument.name) recording")
                    .font(JamFont.text(17, .bold))
                    .foregroundStyle(Palette.paper)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            Text("Nothing changes for everyone until you press Save.")
                .font(JamFont.text(13))
                .foregroundStyle(Palette.paperMuted)
                .fixedSize(horizontal: false, vertical: true)
            Text("Drag the ends to trim. Drag the middle to move it.")
                .font(JamFont.text(13))
                .foregroundStyle(Palette.paperSubtle)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
        }
    }

    private func zoomAndLegend(_ track: JamTrack) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                zoomChip(.whole, title: "Whole song")
                zoomChip(.close, title: "Just the start")
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("How much to show"))
            FlowLayout(spacing: 12) {
                legend(color: Palette.paperMuted, width: 16, "the band")
                legend(color: track.instrument.color, width: 16, "your recording")
                legend(color: Palette.signal, width: 2, "start")
            }
            .accessibilityHidden(true)
        }
    }

    private func zoomChip(_ zoom: JamClipMath.Zoom, title: LocalizedStringKey) -> some View {
        let selected = model.zoom == zoom
        return Button {
            Haptics.selection()
            withAnimation(.jamQuick(reduceMotion: reduceMotion)) { model.zoom = zoom }
        } label: {
            Text(title)
                .font(JamFont.text(14, selected ? .bold : .semibold))
                .foregroundStyle(selected ? Palette.ink : Palette.paperSubtle)
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .background(Capsule().fill(selected ? Palette.paper : .clear))
                .overlay(Capsule().strokeBorder(selected ? .clear : Palette.border, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("jam.adjust.zoom.\(zoom.rawValue)")
    }

    private func legend(color: Color, width: CGFloat, _ title: LocalizedStringKey) -> some View {
        HStack(spacing: 6) {
            Capsule().fill(color).frame(width: width, height: width > 4 ? 8 : 12)
            Text(title).font(JamFont.text(12)).foregroundStyle(Palette.paperMuted)
        }
    }

    // MARK: Timing

    private func timingCard(_ track: JamTrack) -> some View {
        let nudge = model.edits.nudgeMs
        return VStack(alignment: .leading, spacing: 10) {
            Text("Line it up")
                .font(JamFont.text(13, .bold)).foregroundStyle(Palette.paper)
                .accessibilityAddTraits(.isHeader)
            Text(verbatim: Self.nudgeWords(nudge))
                .font(JamFont.text(20, .bold).monospacedDigit())
                .foregroundStyle(nudge == 0 ? Palette.paperMuted : Palette.paper)
                .frame(maxWidth: .infinity)
                .contentTransition(.numericText())
                .accessibilityLabel(Text("Move the recording in time"))
                .accessibilityValue(Text(verbatim: Self.nudgeWords(nudge)))
                .accessibilityIdentifier("jam.adjust.nudgeValue")
            HStack(spacing: 10) {
                JamHoldStepButton(title: "Move earlier", symbol: "chevron.left", direction: -1, id: "jam.adjust.earlier") {
                    model.nudge(by: $0)
                }
                JamHoldStepButton(title: "Move later", symbol: "chevron.right", direction: 1, id: "jam.adjust.later") {
                    model.nudge(by: $0)
                }
            }
            Text("Hold a button to go faster.")
                .font(JamFont.text(12)).foregroundStyle(Palette.paperMuted)
        }
        .padding(14)
        .jamAdjustCard()
    }

    /// "Right on time", "40 ms later", "40 ms earlier" (`jam.clip.*`).
    static func nudgeWords(_ nudgeMs: Double) -> String {
        let ms = Int(jsRound(abs(nudgeMs)))
        if nudgeMs == 0 { return String(localized: "Right on time") }
        return nudgeMs > 0 ? String(localized: "\(ms) ms later") : String(localized: "\(ms) ms earlier")
    }

    // MARK: Volume

    private func volumeCard(_ track: JamTrack) -> some View {
        let percent = jsRound(model.edits.gain * 100)
        return VStack(alignment: .leading, spacing: 10) {
            Label("Everybody hears it like this", systemImage: "speaker.wave.2.fill")
                .font(JamFont.text(13, .bold)).foregroundStyle(Palette.paper)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 12) {
                Slider(
                    value: Binding(get: { percent }, set: { model.gain($0 / 100) }),
                    in: 0...(JamClipEdits.gainMax * 100), step: 1
                )
                .tint(track.instrument.color)
                .frame(minHeight: 44)
                .accessibilityLabel(Text("Volume"))
                .accessibilityValue(Text(verbatim: "\(Int(percent))%"))
                .accessibilityIdentifier("jam.adjust.volume")
                Text(verbatim: JamClipMath.volumeDelta(model.edits.gain) ?? String(localized: "normal"))
                    .font(JamFont.text(13, .semibold).monospacedDigit())
                    .foregroundStyle(Palette.paperMuted)
                    .frame(minWidth: 52, alignment: .trailing)
                    .accessibilityHidden(true)
            }
        }
        .padding(14)
        .jamAdjustCard()
    }

    // MARK: Failure, reset, save

    private func failureRow(_ failure: JamEditFailure) -> some View {
        Text(Self.message(for: failure))
            .font(JamFont.text(13, .semibold))
            .foregroundStyle(Palette.paper)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous).fill(Palette.surfaceRaised))
            .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous).strokeBorder(Palette.danger, lineWidth: 1))
            .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("jam.adjust.error")
    }

    static func message(for failure: JamEditFailure) -> LocalizedStringKey {
        switch failure {
        case .denied: "You cannot adjust this recording."
        case .invalid: "That did not work. Try again."
        case .kind(let kind): JamEditCopy.message(for: kind)
        }
    }

    private var resetRow: some View {
        HStack {
            Spacer(minLength: 0)
            Button {
                Haptics.selection()
                model.reset()
            } label: {
                Label("Reset", systemImage: "arrow.counterclockwise")
                    .font(JamFont.text(13, .semibold))
                    .foregroundStyle(Palette.paper)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.saving)
            .accessibilityIdentifier("jam.adjust.reset")
        }
        .transition(.opacity)
    }

    private var saveButton: some View {
        Button {
            Task { if await model.save() { dismiss() } }
        } label: {
            ZStack {
                if model.saving {
                    ProgressView().controlSize(.small).tint(Palette.inkDeep)
                } else {
                    Text("Save")
                        .font(JamFont.text(15, .bold))
                        .foregroundStyle(model.isDirty ? Palette.inkDeep : Palette.paperMuted)
                }
            }
            .padding(.horizontal, 16)
            .frame(minWidth: 64, minHeight: 36)
            .background(Capsule().fill(model.isDirty || model.saving ? Palette.signal : Palette.surfaceRaised))
        }
        .buttonStyle(.plain)
        .disabled(!model.isDirty || model.saving)
        .animation(.jamQuick(reduceMotion: reduceMotion), value: model.isDirty)
        .accessibilityLabel(Text("Save"))
        .accessibilityIdentifier("jam.adjust.save")
    }

    // MARK: Transport

    /// The song's own transport is under the sheet; this one plays and pauses
    /// the same engine, so a change is heard without leaving the sheet.
    private var transport: some View {
        HStack(spacing: 14) {
            Button {
                song.togglePlay()
            } label: {
                Image(systemName: song.isPlaying ? "pause.fill" : "play.fill")
                    .font(JamFont.text(20, .bold))
                    .foregroundStyle(Palette.inkDeep)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 52, height: 52)
                    .background(Circle().fill(Palette.signal))
            }
            .buttonStyle(JamTilePressStyle(reduceMotion: reduceMotion))
            .accessibilityLabel(Text(song.isPlaying ? "Pause" : "Play"))
            .accessibilityIdentifier("jam.adjust.play")
            JamClock(model: song)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 10)
        .background(Palette.surface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
    }
}

private extension View {
    /// The card the song screen and the studio use for a group of controls.
    func jamAdjustCard() -> some View {
        self
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.surface))
            .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).strokeBorder(Palette.border, lineWidth: 1))
    }
}

// MARK: - Copy for a refusal

enum JamEditCopy {
    /// The web's `jam.error.*` lines for what a write can answer.
    static func message(for kind: JamErrorKind) -> LocalizedStringKey {
        switch kind {
        case .off: "Recording is paused on this server."
        case .closed: "This song is closed to new recordings."
        case .instrumentNotWanted: "This song is not looking for that instrument."
        case .songFull: "This song has no room for more tracks."
        case .authorTrackLimit: "You already sent too many tracks to this song."
        case .tooLarge: "The file came out too large."
        case .storageOff: "This server cannot store recordings yet."
        case .rateLimited: "Easy, that is a lot at once. Try again in a moment."
        case .network: "No connection. Check your internet and try again."
        case .gone: "That song is gone."
        case .other: "That did not work. Try again."
        }
    }
}

// MARK: - Hold to step

/// "Earlier" / "Later": a tap is one step of 10 ms and HOLDING repeats, faster
/// the longer it is held (`JamClipEdits.nudgeStep`), because on a phone nobody
/// taps thirty times. The step is reported as a signed delta, and the receiver
/// reads its own current value, so a hold never works from a stale number.
struct JamHoldStepButton: View {
    let title: LocalizedStringKey
    let symbol: String
    /// -1 earlier, +1 later.
    let direction: Double
    let id: String
    let step: (Double) -> Void

    @State private var holding: Task<Void, Never>?
    @State private var pressed = false

    var body: some View {
        HStack(spacing: 4) {
            if direction < 0 { Image(systemName: symbol).font(JamFont.text(14, .bold)) }
            Text(title).font(JamFont.text(13, .bold))
            if direction > 0 { Image(systemName: symbol).font(JamFont.text(14, .bold)) }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .foregroundStyle(Palette.paper)
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, minHeight: 48)
        .background(Capsule().fill(pressed ? Palette.border : Palette.surfaceRaised))
        .contentShape(Capsule())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard holding == nil else { return }
                    pressed = true
                    Haptics.selection()
                    step(direction * JamClipEdits.nudgeStep(heldMs: 0))
                    holding = Task {
                        try? await Task.sleep(for: .milliseconds(Int(JamClipEdits.holdDelayMs)))
                        var held = JamClipEdits.holdDelayMs
                        while !Task.isCancelled {
                            step(direction * JamClipEdits.nudgeStep(heldMs: held))
                            held += JamClipEdits.repeatMs
                            try? await Task.sleep(for: .milliseconds(Int(JamClipEdits.repeatMs)))
                        }
                    }
                }
                .onEnded { _ in
                    holding?.cancel()
                    holding = nil
                    pressed = false
                }
        )
        .onDisappear { holding?.cancel(); holding = nil }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(title))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { step(direction * JamClipEdits.nudgeStep(heldMs: 0)) }
        .accessibilityIdentifier(id)
    }
}
