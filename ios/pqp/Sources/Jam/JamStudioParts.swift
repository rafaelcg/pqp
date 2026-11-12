import SwiftUI

// THE STUDIO'S PIECES: the big round button, the lanes with a playhead, the
// instrument picker, the nudge buttons, the headphones card and the sheets. The
// screen that arranges them is `JamStudioView`.

extension JamInstrument {
    /// A glyph beside the name. Colour alone does not carry an instrument (the
    /// web's rule, and the reason the colours also differ in lightness).
    var symbol: String {
        switch self {
        case .guitar: "guitars.fill"
        case .bass: "waveform"
        case .drums: "metronome.fill"
        case .vocals: "music.mic"
        case .keys: "pianokeys.inverse"
        case .other: "music.note"
        }
    }
}

// MARK: - The button

/// The one big button of the studio. Red to record, a square to stop: what
/// every recorder looks like, so nobody has to read it.
struct JamRecordButton: View {
    enum Kind { case record, stop, cancel }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let kind: Kind
    var enabled = true
    let action: () -> Void

    @State private var pulse = false

    private var diameter: CGFloat { 88 }

    var body: some View {
        Button {
            Haptics.selection()
            action()
        } label: {
            ZStack {
                Circle()
                    .strokeBorder(Palette.paper.opacity(enabled ? 0.9 : 0.3), lineWidth: 4)
                    .frame(width: diameter, height: diameter)
                    .scaleEffect(kind == .stop && pulse && !reduceMotion ? 1.06 : 1)
                switch kind {
                case .record:
                    Circle().fill(Palette.danger.opacity(enabled ? 1 : 0.35)).frame(width: 68, height: 68)
                case .stop:
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Palette.danger).frame(width: 32, height: 32)
                case .cancel:
                    Image(systemName: "xmark").font(JamFont.text(26, .bold)).foregroundStyle(Palette.paper)
                }
            }
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
        }
        .buttonStyle(JamTilePressStyle(reduceMotion: reduceMotion))
        .disabled(!enabled)
        .onAppear {
            guard kind == .stop, !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulse = true }
        }
        .accessibilityLabel(Text(label))
    }

    private var label: LocalizedStringKey {
        switch kind {
        case .record: "Record"
        case .stop: "Stop"
        case .cancel: "Cancel"
        }
    }
}

// MARK: - Lanes

/// The band's lanes on one shared timeline, a playhead down all of them, and
/// optionally the lane being recorded (growing from the left) or the take (the
/// lane in colour, the band quieter).
struct JamStudioLanes: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    struct Live: Equatable {
        var instrument: JamInstrument
        var levels: [Float]
        var elapsedMs: Double
    }

    let tracks: [JamTrack]
    let originMs: Double
    let spanMs: Double
    var highlightId: String?
    var live: Live?
    var moving = false
    /// Where the playhead is, ms from `originMs`. Read inside the timeline so
    /// the view is not invalidated sixty times a second.
    let position: () -> Double
    var laneHeight: CGFloat = 44

    static let gutter: CGFloat = 84
    private let spacing: CGFloat = 8
    @State private var areaWidth: CGFloat = 0

    var body: some View {
        VStack(spacing: 6) {
            ForEach(tracks) { track in lane(track) }
            if let live { liveLane(live) }
        }
        .padding(.horizontal, Metrics.hPadding)
        .overlay { playhead }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            areaWidth = max(0, width - Metrics.hPadding * 2 - Self.gutter - spacing)
        }
    }

    private func gutter(for instrument: JamInstrument, name: String?, strong: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: instrument.symbol)
                .font(JamFont.text(12, .bold))
                .foregroundStyle(instrument.color)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: instrument.title)
                    .font(JamFont.text(12, .bold))
                    .foregroundStyle(strong ? Palette.paper : Palette.paperSubtle)
                if let name, !name.isEmpty {
                    Text(verbatim: name)
                        .font(JamFont.text(10))
                        .foregroundStyle(Palette.paperMuted)
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.8)
        }
        .frame(width: Self.gutter, alignment: .leading)
    }

    private func lane(_ track: JamTrack) -> some View {
        let isTake = track.id == highlightId
        let span = JamMixRules.fractions(of: track, originMs: originMs, durationMs: spanMs)
        return HStack(spacing: spacing) {
            gutter(for: track.instrument, name: isTake ? String(localized: "You") : track.authorName, strong: isTake)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(isTake ? track.instrument.color.opacity(0.14) : Palette.surface)
                TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !moving)) { _ in
                    let global = spanMs > 0 ? position() / spanMs : 0
                    let local = span.end > span.start ? (global - span.start) / (span.end - span.start) : 0
                    JamWaveform(
                        values: JamPeaks.trackBars(track, bars: 120),
                        color: track.instrument.color.opacity(isTake ? 0.95 : 0.4),
                        playedColor: isTake ? track.instrument.color : track.instrument.color.opacity(0.85),
                        played: moving ? min(1, max(0, local)) : 0
                    )
                    .frame(width: max(0, (span.end - span.start) * areaWidth), height: laneHeight - 12)
                    .offset(x: span.start * areaWidth)
                }
            }
            .frame(height: laneHeight)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: isTake ? "\(String(localized: "You")), \(track.instrument.title)" : JamTrackNaming.spoken(track)))
    }

    private func liveLane(_ live: Live) -> some View {
        let fraction = spanMs > 0 ? min(1, max(0, live.elapsedMs / spanMs)) : 0
        return HStack(spacing: spacing) {
            gutter(for: live.instrument, name: String(localized: "You"), strong: true)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(live.instrument.color.opacity(0.14))
                JamWaveform(
                    values: live.levels.map(Double.init), color: live.instrument.color, barWidth: 3, gap: 2
                )
                .frame(width: max(0, fraction * areaWidth), height: laneHeight - 12)
            }
            .frame(height: laneHeight)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Recording"))
    }

    private var playhead: some View {
        GeometryReader { proxy in
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !moving)) { _ in
                let fraction = spanMs > 0 ? min(1, max(0, position() / spanMs)) : 0
                let x = Metrics.hPadding + Self.gutter + spacing + fraction * areaWidth
                Rectangle()
                    .fill(Palette.paper)
                    .frame(width: 2, height: proxy.size.height)
                    .shadow(color: Palette.paper.opacity(0.5), radius: 4)
                    .offset(x: x - 1)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Level

/// The microphone's level while recording: a thin bar that climbs and falls, in
/// the instrument's colour and red where it clips.
struct JamLevelMeter: View {
    let level: Float
    let tint: Color

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.surfaceRaised)
                Capsule()
                    .fill(level > 0.97 ? Palette.danger : tint)
                    .frame(width: max(6, proxy.size.width * CGFloat(min(1, pow(Double(level), 0.6)))))
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

// MARK: - Instrument picker

struct JamInstrumentPicker: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var selection: JamInstrument
    let addable: [JamInstrument]
    let asked: [JamInstrument]

    private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            ForEach(JamInstrument.allCases, id: \.self) { instrument in
                chip(instrument)
            }
        }
        .padding(.horizontal, Metrics.hPadding)
    }

    private func chip(_ instrument: JamInstrument) -> some View {
        let allowed = addable.contains(instrument)
        let selected = selection == instrument
        return Button {
            guard allowed else { return }
            Haptics.selection()
            withAnimation(.jamQuick(reduceMotion: reduceMotion)) { selection = instrument }
        } label: {
            VStack(spacing: 6) {
                Image(systemName: instrument.symbol)
                    .font(JamFont.text(22, .semibold))
                Text(verbatim: instrument.title)
                    .font(JamFont.text(13, .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if asked.contains(instrument) {
                    Text("asked for")
                        .font(JamFont.text(10, .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
            }
            .foregroundStyle(selected ? Palette.ink : (allowed ? Palette.paper : Palette.paperMuted))
            .frame(maxWidth: .infinity, minHeight: 78)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .fill(selected ? instrument.color : Palette.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .strokeBorder(selected ? .clear : (allowed ? instrument.color.opacity(0.55) : Palette.border), lineWidth: 1.5)
            )
            .opacity(allowed ? 1 : 0.45)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!allowed)
        .accessibilityLabel(Text(verbatim: instrument.title))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("jam.studio.instrument.\(instrument.rawValue)")
    }
}

// MARK: - Nudge

/// A button that steps once on a tap and keeps stepping, faster, while held.
struct JamNudgeButton: View {
    let title: LocalizedStringKey
    let symbol: String
    /// The sign of the step: -1 earlier, +1 later.
    let direction: Double
    let step: (Double) -> Void

    @State private var holding: Task<Void, Never>?
    @State private var pressed = false

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: symbol).font(JamFont.text(20, .bold))
            Text(title).font(JamFont.text(12, .semibold))
        }
        .foregroundStyle(Palette.paper)
        .frame(maxWidth: .infinity, minHeight: 64)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .fill(pressed ? Palette.surfaceRaised : Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .strokeBorder(Palette.border, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard holding == nil else { return }
                    pressed = true
                    Haptics.selection()
                    step(direction * JamTakeEdits.nudgeStepMs)
                    holding = Task {
                        try? await Task.sleep(for: .milliseconds(400))
                        var repeats = 0
                        while !Task.isCancelled {
                            step(direction * JamTakeEdits.holdStep(afterRepeats: repeats))
                            repeats += 1
                            try? await Task.sleep(for: .milliseconds(90))
                        }
                    }
                }
                .onEnded { _ in
                    holding?.cancel()
                    holding = nil
                    pressed = false
                }
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(title))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { step(direction * JamTakeEdits.nudgeStepMs) }
        .accessibilityIdentifier(direction < 0 ? "jam.studio.nudgeEarlier" : "jam.studio.nudgeLater")
    }
}

// MARK: - The route card

struct JamRouteCard: View {
    let route: JamAudioRoute
    let latency: JamLatencyResult
    let onCalibrate: () -> Void

    private var symbol: String {
        switch route.assessment {
        case .speaker: "speaker.wave.2.fill"
        case .wireless: "airpods"
        case .fine: "headphones"
        }
    }

    private var tone: Color {
        switch route.assessment {
        case .fine: Palette.success
        case .speaker, .wireless: Palette.warning
        }
    }

    private var title: LocalizedStringKey {
        switch route.assessment {
        case .fine: "Headphones on"
        case .speaker: "No headphones"
        case .wireless: "Wireless audio"
        }
    }

    private var detail: LocalizedStringKey {
        switch route.assessment {
        case .fine: "The band plays in your ears and your recording lands in time."
        case .speaker: "The band will leak into the microphone. Plug in headphones, or record anyway."
        case .wireless: "Bluetooth headphones add too much delay to record. The recording may land out of time. Wired fixes it."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: symbol)
                    .font(JamFont.text(20, .semibold))
                    .foregroundStyle(tone)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(JamFont.text(15, .bold))
                        .foregroundStyle(Palette.paper)
                    Text(detail)
                        .font(JamFont.text(13))
                        .foregroundStyle(Palette.paperMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: 10) {
                latencyChip
                Spacer(minLength: 0)
                Button(action: onCalibrate) {
                    Text(JamLatencyRules.isMeasured(latency) ? "Calibrate again" : "Calibrate")
                        .font(JamFont.text(13, .semibold))
                        .foregroundStyle(Palette.paper)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 1))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("jam.studio.calibrate")
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.surface))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .strokeBorder(route.assessment == .fine ? Palette.border : Palette.warning.opacity(0.5), lineWidth: 1)
        )
        .padding(.horizontal, Metrics.hPadding)
        .accessibilityElement(children: .contain)
    }

    private var latencyChip: some View {
        let ms = Int(latency.roundTripMs.rounded())
        return HStack(spacing: 6) {
            Image(systemName: JamLatencyRules.isMeasured(latency) ? "checkmark.circle.fill" : "questionmark.circle")
                .foregroundStyle(JamLatencyRules.isMeasured(latency) ? Palette.success : Palette.paperMuted)
            if JamLatencyRules.isMeasured(latency) {
                Text("Headphones set \u{00B7} \(ms) ms")
            } else {
                Text("Estimated delay \(ms) ms")
            }
        }
        .font(JamFont.text(13, .semibold))
        .foregroundStyle(Palette.paper)
        .lineLimit(2)
        .minimumScaleFactor(0.8)
        .accessibilityIdentifier("jam.studio.latencyChip")
    }
}

// MARK: - The calibration sheet

struct JamCalibrationSheet: View {
    let model: JamRecordModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            switch model.calibration {
            case .idle, .asking: asking
            case .measuring(let method): measuring(method)
            case .measured(let result): measured(result)
            case .failed(let method): failed(method)
            }
            Spacer(minLength: 0)
        }
        .padding(Metrics.hPadding + 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.ink.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled({ if case .measuring = model.calibration { return true } else { return false } }())
    }

    private var asking: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Measure your headphones' delay?")
                .font(JamFont.title(22)).foregroundStyle(Palette.paper)
            Text("Sound takes a moment to leave your headphones and come back through the microphone. We measure that delay once and subtract it from your recording, so your part lands in time with nothing to cut. It is remembered for this headset and this microphone.")
                .font(JamFont.text(14)).foregroundStyle(Palette.paperMuted)
                .fixedSize(horizontal: false, vertical: true)
            if model.route.assessment == .wireless {
                Label("Bluetooth headphones add too much delay to record. The recording may land out of time. Wired fixes it.", systemImage: "exclamationmark.triangle.fill")
                    .font(JamFont.text(13, .semibold)).foregroundStyle(Palette.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
            action("Measure now", primary: true, id: "jam.calibrate.loopback") { Task { await model.calibrate(.loopback) } }
            Text("Hold a headphone cup against the microphone, or measure on the speaker, so the microphone hears the clicks.")
                .font(JamFont.text(12)).foregroundStyle(Palette.paperMuted)
                .fixedSize(horizontal: false, vertical: true)
            action("Tap along instead", primary: false, id: "jam.calibrate.tap") { Task { await model.calibrate(.tapAlong) } }
            Text("For wired headphones. Clap or hit a muted string on every click.")
                .font(JamFont.text(12)).foregroundStyle(Palette.paperMuted)
            Button {
                model.dismissCalibration()
                dismiss()
            } label: {
                Text("Not now").font(JamFont.text(14, .semibold)).foregroundStyle(Palette.paperSubtle)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
        }
    }

    private func measuring(_ method: JamCalibrator.Method) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(method == .loopback ? "Measuring. Stay quiet for a few seconds." : "Tap along with every click.")
                .font(JamFont.title(22)).foregroundStyle(Palette.paper)
            TimelineView(.animation(minimumInterval: 1.0 / 20)) { context in
                let total = JamCalibrator.durationSeconds(method) + 0.5
                let elapsed = context.date.timeIntervalSince(model.measuringSince)
                ProgressView(value: min(1, max(0, elapsed / total)))
                    .tint(Palette.signal)
            }
            action("Cancel", primary: false, id: "jam.calibrate.cancel") { model.cancelCalibration() }
        }
    }

    private func measured(_ result: JamLatencyResult) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label {
                Text("Headphones set \u{00B7} \(Int(result.roundTripMs.rounded())) ms")
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.success)
            }
            .font(JamFont.title(22)).foregroundStyle(Palette.paper)
            Text(result.method == .loopback ? "measured with the microphone" : "measured by tapping along")
                .font(JamFont.text(14)).foregroundStyle(Palette.paperMuted)
            if result.confidence == .low {
                Text("The measurements disagree with each other by more than expected.")
                    .font(JamFont.text(13)).foregroundStyle(Palette.warning)
            }
            action("Done", primary: true, id: "jam.calibrate.done") {
                model.dismissCalibration()
                dismiss()
            }
        }
    }

    private func failed(_ method: JamCalibrator.Method) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(method == .loopback
                 ? "Could not measure it properly. Try again closer to the speaker, or skip."
                 : "Could not hear the taps. Tap harder on every click, or skip.")
                .font(JamFont.text(15)).foregroundStyle(Palette.paper)
                .fixedSize(horizontal: false, vertical: true)
            action("Try again", primary: true, id: "jam.calibrate.retry") { Task { await model.calibrate(method) } }
            action("Not now", primary: false, id: "jam.calibrate.skip") {
                model.dismissCalibration()
                dismiss()
            }
        }
    }

    private func action(_ title: LocalizedStringKey, primary: Bool, id: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title)
                .font(JamFont.text(16, .bold))
                .foregroundStyle(primary ? Palette.inkDeep : Palette.paper)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background(Capsule().fill(primary ? Palette.signal : .clear))
                .overlay(Capsule().strokeBorder(primary ? .clear : Palette.border, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}

// MARK: - A new song

/// The start of a song nobody has recorded yet: a name, who may join, and on to
/// the studio. The song is made when the first take is sent, never before, so
/// walking away leaves nothing behind.
struct JamNewSongSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft = JamSongDraft()
    @FocusState private var focus: Field?
    let onStart: (JamSongDraft) -> Void

    private enum Field { case title, artist }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    field("Song name", text: $draft.title, prompt: "e.g. In Bloom", id: "jam.new.title", focus: .title)
                    if draft.cleanTitle.count > JamLimits.titleMax {
                        Text("The name can be \(JamLimits.titleMax) characters at most.")
                            .font(JamFont.text(12)).foregroundStyle(Palette.warning)
                    }
                    field("Artist (leave empty if it is yours)", text: $draft.artist, prompt: "e.g. Nirvana", id: "jam.new.artist", focus: .artist)
                    Text("Who can join")
                        .font(JamFont.text(13, .bold)).foregroundStyle(Palette.paperMuted)
                        .textCase(.uppercase).tracking(1)
                    mode(.open, title: "Anyone", hint: "Anybody on the server records on top")
                    mode(.wanted, title: "Only some instruments", hint: "You pick the ones still missing")
                    if draft.joinMode == .wanted { wantedPicker }
                    mode(.closed, title: "Only me", hint: "Only you record on this song")
                    if let problem = draft.problem, showProblem(problem) {
                        Text(problem == .needTitle ? "Give the song a name." : "Pick at least one instrument.")
                            .font(JamFont.text(13)).foregroundStyle(Palette.warning)
                    }
                    Button {
                        guard draft.problem == nil else { return }
                        dismiss()
                        onStart(draft)
                    } label: {
                        Text("Go to the studio")
                            .font(JamFont.text(16, .bold)).foregroundStyle(Palette.inkDeep)
                            .frame(maxWidth: .infinity, minHeight: 52)
                            .background(Capsule().fill(Palette.signal.opacity(draft.problem == nil ? 1 : 0.4)))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(draft.problem != nil)
                    .accessibilityIdentifier("jam.new.go")
                }
                .padding(Metrics.hPadding)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Palette.ink.ignoresSafeArea())
            .navigationTitle("New song")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.ink, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.tint(Palette.paper) }
            }
        }
        .presentationDetents([.large])
        .onAppear { focus = .title }
    }

    private func showProblem(_ problem: JamSongDraft.Problem) -> Bool {
        problem == .needWanted || !draft.title.isEmpty
    }

    private func field(
        _ title: LocalizedStringKey, text: Binding<String>, prompt: LocalizedStringKey, id: String, focus field: Field
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(JamFont.text(13, .bold)).foregroundStyle(Palette.paperMuted)
            TextField("", text: text, prompt: Text(prompt).foregroundStyle(Palette.paperMuted))
                .focused($focus, equals: field)
                .textInputAutocapitalization(.sentences)
                .font(JamFont.text(17))
                .foregroundStyle(Palette.paper)
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                .background(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.surface))
                .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).strokeBorder(Palette.border, lineWidth: 1))
                .accessibilityIdentifier(id)
        }
    }

    private func mode(_ mode: JamJoinMode, title: LocalizedStringKey, hint: LocalizedStringKey) -> some View {
        let selected = draft.joinMode == mode
        return Button {
            Haptics.selection()
            draft.joinMode = mode
        } label: {
            HStack(spacing: 12) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Palette.signal : Palette.paperMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(JamFont.text(15, .bold)).foregroundStyle(Palette.paper)
                    Text(hint).font(JamFont.text(12)).foregroundStyle(Palette.paperMuted)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.surface))
            .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .strokeBorder(selected ? Palette.signal.opacity(0.7) : Palette.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("jam.new.mode.\(mode.rawValue)")
    }

    private var wantedPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What are you looking for?").font(JamFont.text(13, .bold)).foregroundStyle(Palette.paperMuted)
            FlowLayout(spacing: 8) {
                ForEach(JamInstrument.allCases, id: \.self) { instrument in
                    let on = draft.wantedInstruments.contains(instrument)
                    Button {
                        Haptics.selection()
                        if on { draft.wantedInstruments.removeAll { $0 == instrument } } else { draft.wantedInstruments.append(instrument) }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: instrument.symbol)
                            Text(verbatim: instrument.title)
                        }
                        .font(JamFont.text(13, .bold))
                        .foregroundStyle(on ? Palette.ink : Palette.paper)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .background(Capsule().fill(on ? instrument.color : Palette.surface))
                        .overlay(Capsule().strokeBorder(on ? .clear : instrument.color.opacity(0.55), lineWidth: 1.5))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? [.isSelected] : [])
                }
            }
        }
        .padding(.leading, 6)
    }
}
