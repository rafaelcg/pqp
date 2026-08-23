import SwiftUI

/// "How was that call?", once, after a call that was long enough to have an
/// answer.
///
/// The mirror of `client/src/components/voice/call-rating-prompt.tsx`, down to
/// the sentences, because both write into the same table and a differently
/// worded question is a differently answered one.
///
/// NUMBERS, NOT STARS. Stars are a rating of a thing you chose; a call is
/// something that either worked or did not, and five stars invites a review
/// where five buttons invites a verdict. The labels on the ends do the work
/// that a star's shape does not.
///
/// THE NOTE ONLY APPEARS ON A LOW SCORE, because that is the only place the
/// number leaves a question open. A 5 tells us everything a 5 can tell us; a 2
/// needs to say whether it was the voice, the picture or the joining. Asking
/// everybody for prose would cost the majority a step and buy nothing.
///
/// DISMISSING IS FREE AND FINAL. The close button ends it for this call and the
/// cooldown was written when the card appeared, so nobody can be nagged by
/// getting back into a call.
struct CallRatingPrompt: View {
    let call: RatableCall
    let api: APIClient
    let onDone: () -> Void

    @State private var rating: Int?
    @State private var note = ""
    @State private var sending = false
    @State private var sent = false
    @FocusState private var noteFocused: Bool

    private var wantsNote: Bool {
        guard let rating else { return false }
        return rating <= CallRating.noteWantedAtOrBelow
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if sent {
                Text("Thanks. That helps.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
                    .accessibilityIdentifier("callRating.thanks")
            } else {
                question
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius)
                .fill(Palette.surfaceRaised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius)
                .stroke(Palette.border, lineWidth: 1)
        )
        .padding(.horizontal, Metrics.hPadding)
        // `.contain` FIRST, and it is load-bearing. An identifier put on a
        // container without it is *pushed down onto every descendant*, which
        // overwrites the identifiers on the score buttons and the close button
        // and leaves the suite querying five elements that all answer to
        // "callRating.card". This cost a full red run to find, and the tree dump
        // is the only thing that showed it.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("callRating.card")
        .animation(Motion.standard, value: sent)
        .animation(Motion.standard, value: wantsNote)
    }

    private var question: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                Text("How was that call?")
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                Spacer(minLength: 8)
                Button {
                    onDone()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Palette.paperMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
                .accessibilityIdentifier("callRating.dismiss")
            }

            HStack(spacing: 8) {
                ForEach(CallRating.scores, id: \.self) { score in
                    scoreButton(score)
                }
            }

            HStack {
                Text("Unusable")
                Spacer()
                Text("Perfect")
            }
            .font(Typography.label)
            .foregroundStyle(Palette.paperMuted.opacity(0.8))

            if wantsNote {
                noteField
            }
        }
    }

    private func scoreButton(_ score: Int) -> some View {
        Button {
            pick(score)
        } label: {
            Text("\(score)")
                .font(.system(size: 15, weight: .semibold))
                // Tabular so the row does not shift when the selection moves.
                .monospacedDigit()
                .foregroundStyle(rating == score ? Palette.inkDeep : Palette.paperMuted)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall)
                        .fill(rating == score ? Palette.signal : Color.clear)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall)
                        .stroke(rating == score ? Color.clear : Palette.border, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .disabled(sending)
        .accessibilityLabel("Rate \(score) out of 5")
        .accessibilityAddTraits(rating == score ? [.isSelected] : [])
        .accessibilityIdentifier("callRating.score.\(score)")
    }

    private var noteField: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("What went wrong? (optional)", text: $note, axis: .vertical)
                .font(Typography.callout)
                .foregroundStyle(Palette.paper)
                .focused($noteFocused)
                .lineLimit(1...3)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall)
                        .fill(Palette.surface)
                )
                // The server refuses a longer one, so the field stops rather
                // than letting somebody write past the limit and lose it.
                .onChange(of: note) { _, latest in
                    if latest.count > CallRating.noteMaxLength {
                        note = String(latest.prefix(CallRating.noteMaxLength))
                    }
                }
                .accessibilityIdentifier("callRating.note")

            Button("Send") {
                guard let rating else { return }
                send(rating, note)
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(sending)
            .accessibilityIdentifier("callRating.send")
        }
    }

    private func pick(_ score: Int) {
        rating = score
        // A good score is the whole answer, so it goes immediately and the card
        // gets out of the way. A low one waits for the optional detail.
        if score > CallRating.noteWantedAtOrBelow {
            send(score, "")
        } else {
            noteFocused = true
        }
    }

    private func send(_ score: Int, _ withNote: String) {
        sending = true
        noteFocused = false
        Task {
            // A rating that failed to send is not worth an error message. The
            // person has already answered and moved on, and there is nothing
            // they could do about it: telling them would turn our problem into
            // their interruption.
            try? await api.submitCallRating(call, rating: score, note: withNote)
            sent = true
            sending = false
            try? await Task.sleep(for: .milliseconds(1400))
            onDone()
        }
    }
}
