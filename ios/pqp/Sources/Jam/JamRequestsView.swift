import SwiftUI

// THE STARTER'S ANSWER, AT THE TOP OF THEIR SONG. Parts that people outside the
// song sent wait here for a yes or a no ("N partes esperando tua resposta"):
// above the stage, because finding them was six minutes and 45 actions when they
// sat below it (launch test, round 2, finding N1). Each is heard in place of the
// same instrument with the band (the lane audition), then accepted (it is in the
// mix, and what the public sees now is said, with Undo for eight seconds) or
// declined (confirmed first, no undo: a declined take is deleted).
//
// The twin of the web's `JamPublicRequests` and `JamAnswerNotice`
// (`client/src/components/jam/`), in the web's words.

struct JamRequestsView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let model: JamSongModel
    @State private var declining: JamTrack?

    var body: some View {
        let requests = model.requestTracks
        VStack(alignment: .leading, spacing: 12) {
            if !requests.isEmpty {
                block(requests)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.97).combined(with: .opacity))
            }
            if let answer = model.answer {
                JamAnswerView(model: model, answer: answer)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(.horizontal, Metrics.hPadding)
        .animation(.jam(reduceMotion: reduceMotion), value: requests.map(\.id))
        .animation(.jam(reduceMotion: reduceMotion), value: model.answer)
        .confirmationDialog(
            "Decline this request?",
            isPresented: Binding(get: { declining != nil }, set: { if !$0 { declining = nil } }),
            titleVisibility: .visible
        ) {
            Button("Decline", role: .destructive) {
                if let request = declining { Task { await model.decline(request) } }
                declining = nil
            }
        } message: {
            Text("The recording is deleted. It never joined the song.")
        }
    }

    private func block(_ requests: [JamTrack]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("\(requests.count) parts waiting for your answer")
                .font(JamFont.title(18))
                .foregroundStyle(Palette.paper)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("jam.requests.title")
            Text("People outside sent these parts. They only join the mix when you accept.")
                .font(JamFont.text(13))
                .foregroundStyle(Palette.paperMuted)
                .fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 0) {
                ForEach(Array(requests.enumerated()), id: \.element.id) { index, request in
                    if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
                    row(request)
                }
            }
            .background(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.surfaceRaised))
            if let error = model.requestError {
                // Next to the buttons it came from, on screen and spoken: a
                // refused answer is never only the song's passing banner.
                JamNoticeBar(text: error, tone: .problem, identifier: "jam.requests.error")
                    .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
                    .jamAnnounceNow(error)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous).fill(Palette.surface))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .strokeBorder(Palette.signal, lineWidth: 2)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("jam.requests")
    }

    private func row(_ request: JamTrack) -> some View {
        let hearing = model.isAuditioned(request)
        let busy = model.requestBusy == request.id
        let spoken = JamTrackNaming.spoken(request)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Avatar(name: request.avatarName, seed: request.authorId, size: 34, url: request.authorAvatarUrl)
                    .overlay(Circle().strokeBorder(request.instrument.color, lineWidth: 2))
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: request.instrument.title)
                        .font(JamFont.text(14, .bold))
                        .foregroundStyle(Palette.paper)
                    Text(verbatim: JamBidi.clean(request.displayName))
                        .font(JamFont.text(13, .semibold))
                        .foregroundStyle(Palette.paperMuted)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: spoken))
            // The three actions flow as whole pills under the names, so no label is
            // ever cut mid-word, from the smallest phone to the largest type, in
            // either language.
            FlowLayout(spacing: 8) {
                pill(
                    hearing ? "Stop" : "Listen with the band",
                    systemImage: hearing ? "pause.fill" : "ear.fill",
                    style: .quiet(selected: hearing),
                    id: "jam.requests.listen"
                ) {
                    Haptics.selection()
                    Task { await model.hear(request) }
                }
                .accessibilityValue(Text(hearing ? "Hearing" : ""))
                pill("Accept", systemImage: nil, style: .primary, id: "jam.requests.accept") {
                    Haptics.selection()
                    Task { await model.accept(request) }
                }
                .disabled(busy)
                .accessibilityLabel(Text("Accept \(spoken)"))
                pill("Decline", systemImage: nil, style: .quiet(selected: false), id: "jam.requests.decline") {
                    Haptics.selection()
                    declining = request
                }
                .disabled(busy)
                .accessibilityLabel(Text("Decline \(spoken)"))
            }
            .padding(.leading, 44)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .opacity(busy ? 0.6 : 1)
    }

    private enum PillStyle {
        case primary
        case quiet(selected: Bool)
    }

    private func pill(
        _ title: LocalizedStringKey, systemImage: String?, style: PillStyle, id: String,
        action: @escaping () -> Void
    ) -> some View {
        let primary: Bool = { if case .primary = style { return true } else { return false } }()
        let selected: Bool = { if case .quiet(let selected) = style { return selected } else { return false } }()
        return Button(action: action) {
            HStack(spacing: 6) {
                if let systemImage { Image(systemName: systemImage).font(JamFont.text(12, .bold)) }
                Text(title)
            }
            .font(JamFont.text(13, .bold))
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(primary || selected ? Palette.inkDeep : Palette.paperSubtle)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(Capsule().fill(primary || selected ? Palette.signal : Palette.surface))
            .overlay(Capsule().strokeBorder(primary || selected ? .clear : Palette.border, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}

// MARK: - What the answer did

/// Said where the answer was given: the part is in (what the public sees now,
/// with Undo), back in the queue, or declined. A status for VoiceOver, gone by
/// itself after the same eight seconds the Undo is offered for. One clock for
/// it, keyed on the answer, so a redraw never starts it over.
struct JamAnswerView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let model: JamSongModel
    let answer: JamAnswer

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: answer.kind == .refused ? "xmark" : "checkmark")
                .font(JamFont.text(14, .bold))
                .foregroundStyle(Palette.paperMuted)
                .frame(width: 32, height: 32)
                .background(Circle().fill(Palette.surfaceRaised))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                Text(verbatim: answer.text())
                    .font(JamFont.text(14, .semibold))
                    .foregroundStyle(Palette.paper)
                    .fixedSize(horizontal: false, vertical: true)
                    // VoiceOver reads in logical order: no isolate characters.
                    .accessibilityLabel(Text(verbatim: JamBidi.clean(answer.text())))
                if answer.kind == .accepted {
                    Button {
                        Haptics.selection()
                        Task { await model.undoAccept(answer) }
                    } label: {
                        Label("Undo", systemImage: "arrow.uturn.backward")
                            .font(JamFont.text(13, .bold))
                            .lineLimit(1)
                            .fixedSize()
                            .foregroundStyle(Palette.paperSubtle)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
                            .background(Capsule().fill(Palette.surface))
                            .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 1))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(model.requestBusy != nil)
                    .accessibilityIdentifier("jam.answer.undo")
                }
            }
            Spacer(minLength: 0)
            Button {
                model.clearAnswer()
            } label: {
                Image(systemName: "xmark")
                    .font(JamFont.text(13, .bold))
                    .foregroundStyle(Palette.paperMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Dismiss"))
            .accessibilityIdentifier("jam.answer.dismiss")
        }
        .padding(.leading, 12)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.surface))
        .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).strokeBorder(Palette.border, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.updatesFrequently)
        .accessibilityIdentifier("jam.answer")
        .jamAnnounceNow(JamBidi.clean(answer.text()))
        .task(id: "\(answer.trackId):\(answer.kind)") {
            try? await Task.sleep(for: .seconds(answer.visibleFor))
            guard !Task.isCancelled else { return }
            model.clearAnswer()
        }
    }
}
