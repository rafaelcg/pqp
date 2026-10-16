import SwiftUI

/// What the card needs from the conversation it sits in, passed through the
/// environment so `MessageRow` (which many screens build) does not grow a
/// parameter per feature.
struct VoiceNoteContext {
    /// The note to continue with after `note` ends.
    var next: @MainActor (VoicePlayable) -> VoicePlayable? = { _ in nil }
    /// Ask for the message again: an Opus note is waiting on its AAC copy.
    var refresh: @MainActor () -> Void = {}
    /// Ask for a transcript of a note somebody else sent.
    var requestTranscript: @MainActor (Message, String) async -> VoiceTranscriptRequest = { _, _ in .failed }

    static let empty = VoiceNoteContext()
}

private struct VoiceNoteContextKey: EnvironmentKey {
    static let defaultValue = VoiceNoteContext.empty
}

extension EnvironmentValues {
    var voiceNoteContext: VoiceNoteContext {
        get { self[VoiceNoteContextKey.self] }
        set { self[VoiceNoteContextKey.self] = newValue }
    }
}

/// A voice note in the transcript: play, a waveform, the length, a speed pill
/// and, until you have heard it, a dot.
///
/// It sits inside the ordinary message row (name, time, reactions all stay), the
/// way the mocks have it, and is one card per note.
struct VoiceNoteCard: View {
    @Environment(VoiceNotePlayer.self) private var player
    @Environment(SessionStore.self) private var session
    @Environment(\.voiceNoteContext) private var context

    let message: Message
    let attachment: Attachment

    /// "Transcrever" in flight, or what became of it.
    @State private var transcriptRequest: VoiceTranscriptRequest = .idle
    @State private var transcriptExpanded = false

    private var transcriptLine: VoiceTranscriptLine {
        VoiceTranscriptLine.resolve(
            transcript: voice.transcript, shows: session.preferences.showsTranscripts,
            isMine: isMine, request: transcriptRequest
        )
    }

    private var voice: VoiceNote { attachment.voice ?? VoiceNote(durationMs: 0) }
    private var playable: VoicePlayable? { VoicePlayable(message: message, attachment: attachment) }
    private var isMine: Bool { message.authorId == session.currentUser?.id }
    private var isCurrent: Bool { player.isCurrent(attachment.id) }
    private var isPending: Bool { VoiceNotePlaybackSource.choose(for: attachment) == .pending }
    private var failed: Bool { player.failedId == attachment.id }
    /// The dot is for notes from other people that you have not played.
    private var showsUnplayedDot: Bool {
        !isMine && voice.isUnplayedForMe && !player.isListened(attachment)
    }
    /// "Ouviu" needs no conversation check of its own: the server sends
    /// `listenedBy` only on the author's copy, and only in a conversation small
    /// enough to show receipts (at most 10 people), so its presence IS the rule.
    private var showsHeardReceipt: Bool {
        isMine && voice.heardByAnyone
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                playButton

                VStack(alignment: .leading, spacing: 3) {
                    if isPending {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.mini).tint(Palette.paperMuted)
                            Text("Processing audio…")
                                .font(Typography.caption)
                                .foregroundStyle(Palette.paperMuted)
                        }
                        .frame(height: 26)
                    } else {
                        VoiceWaveformView(
                            peaks: VoiceWaveform.decode(voice.waveform),
                            progress: isCurrent ? player.progress : 0,
                            onSeek: isCurrent ? { player.seek(toFraction: $0) } : nil
                        )
                        .frame(height: 26)
                    }
                    if failed {
                        Text("Could not play this voice message.")
                            .font(Typography.caption)
                            .foregroundStyle(Palette.danger)
                    }
                }

                trailing
            }
            .padding(.vertical, 7)
            .padding(.leading, 7)
            .padding(.trailing, 10)
            .frame(maxWidth: 270, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .fill(Palette.surfaceRaised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .strokeBorder(Palette.border, lineWidth: 1)
            )

            if showsHeardReceipt {
                HStack(spacing: 3) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 9, weight: .bold))
                    Text("Heard")
                        .font(Typography.caption)
                }
                .foregroundStyle(Palette.signalDim)
                .accessibilityIdentifier("voice.heard")
            }

            transcriptView
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice.card")
    }

    // MARK: The transcript

    /// What goes under the card: the text (two lines, "ver mais" when there is
    /// more), a quiet "transcrevendo" while one is on its way, or a small
    /// "Transcrever" in a note that has none. See `VoiceTranscriptLine`.
    @ViewBuilder
    private var transcriptView: some View {
        switch transcriptLine {
        case .none:
            EmptyView()
        case .text(let text):
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: text)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperSubtle)
                    .lineLimit(transcriptExpanded ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("voice.transcript.text")
                if VoiceTranscriptLine.isLong(text) {
                    Button(transcriptExpanded ? "Show less" : "Show more") {
                        withAnimation(Motion.standard) { transcriptExpanded.toggle() }
                    }
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .buttonStyle(.plain)
                    .frame(minHeight: 28, alignment: .leading)
                    .accessibilityIdentifier("voice.transcript.more")
                }
            }
            .frame(maxWidth: 270, alignment: .leading)
            .padding(.top, 2)
        case .pending:
            Text("Transcribing…")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
                .accessibilityIdentifier("voice.transcript.pending")
        case .noSpeech:
            Text("No speech in this message")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
        case .failed:
            Text("Could not transcribe this message")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
        case .request(let state):
            HStack(spacing: 8) {
                Button {
                    guard transcriptRequest != .asking else { return }
                    transcriptRequest = .asking
                    Task {
                        transcriptRequest = await context.requestTranscript(message, attachment.id)
                    }
                } label: {
                    Text("Transcribe")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Palette.paperSubtle)
                        .underline()
                        .frame(minHeight: 28)
                }
                .buttonStyle(.plain)
                .disabled(state == .asking)
                .accessibilityIdentifier("voice.transcript.request")
                if state == .slow {
                    Text("Easy, try again in a moment")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                } else if state == .failed {
                    Text("That did not work. Try again.")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                }
            }
        }
    }

    // MARK: Pieces

    private var playButton: some View {
        Button {
            if isPending {
                context.refresh()
            } else if let playable {
                player.toggle(playable, next: { context.next($0) }, refresh: { context.refresh() })
            }
        } label: {
            ZStack {
                Circle().fill(isPending ? Palette.border : Palette.signal)
                if isCurrent && player.isLoading && player.isPlaying {
                    ProgressView().controlSize(.small).tint(Palette.inkDeep)
                } else {
                    Image(systemName: isCurrent && player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(isPending ? Palette.paperMuted : Palette.inkDeep)
                        // A play glyph is optically left-heavy; nudge it into the
                        // middle of the disc.
                        .offset(x: isCurrent && player.isPlaying ? 0 : 1)
                }
            }
            .frame(width: 34, height: 34)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("voice.play")
        .accessibilityLabel(
            isPending
                ? Text("Processing audio…")
                : (isCurrent && player.isPlaying ? Text("Pause voice message") : Text("Play voice message"))
        )
        .accessibilityValue(Text(formatNoteDuration(milliseconds: voice.durationMs)))
    }

    private var trailing: some View {
        HStack(spacing: 6) {
            if isCurrent && !isPending {
                Button {
                    player.cycleRate()
                } label: {
                    Text(Self.rateLabel(player.rate))
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Palette.paper)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Palette.border))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("voice.rate")
                .accessibilityLabel(Text("Playback speed"))
                .accessibilityValue(Text(Self.rateLabel(player.rate)))
            }

            Text(timeLabel)
                .font(.system(size: 11).monospacedDigit())
                .foregroundStyle(Palette.paperSubtle)
                .accessibilityIdentifier("voice.time")

            if showsUnplayedDot {
                Circle()
                    .fill(Palette.signal)
                    .frame(width: 8, height: 8)
                    .accessibilityIdentifier("voice.unplayed")
                    .accessibilityLabel(Text("Not played yet"))
            }
        }
    }

    /// Elapsed while it is the current note, the full length otherwise.
    private var timeLabel: String {
        guard isCurrent else { return formatNoteDuration(milliseconds: voice.durationMs) }
        let seconds = player.elapsedMs / 1000
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    static func rateLabel(_ rate: Float) -> String {
        rate == rate.rounded() ? "\(Int(rate))x" : String(format: "%.1fx", rate)
    }
}

/// The bars. Drawn in a `Canvas`, so a long list of notes costs one draw call
/// each rather than 40 views each.
struct VoiceWaveformView: View {
    let peaks: [Float]
    var progress: Double = 0
    /// Present only on the note that is playing: dragging scrubs it.
    var onSeek: ((Double) -> Void)?

    private static let barWidth: CGFloat = 3
    private static let gap: CGFloat = 2

    var body: some View {
        GeometryReader { geometry in
            let count = max(8, Int((geometry.size.width + Self.gap) / (Self.barWidth + Self.gap)))
            let bars = VoiceWaveform.bars(from: peaks, count: count)
            Canvas { context, size in
                let played = Int((Double(count) * progress).rounded(.down))
                for (index, level) in bars.enumerated() {
                    // A floor of 3 pt keeps silence visible as a dotted line
                    // rather than a gap.
                    let height = max(3, CGFloat(level) * size.height)
                    let x = CGFloat(index) * (Self.barWidth + Self.gap)
                    let rect = CGRect(x: x, y: (size.height - height) / 2, width: Self.barWidth, height: height)
                    context.fill(
                        Path(roundedRect: rect, cornerRadius: 1.5),
                        with: .color(index < played ? Palette.signal : Palette.paperMuted.opacity(0.55))
                    )
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard let onSeek, geometry.size.width > 0 else { return }
                        onSeek(Double(value.location.x / geometry.size.width))
                    },
                including: onSeek == nil ? .none : .all
            )
        }
        .accessibilityHidden(true)
    }
}
