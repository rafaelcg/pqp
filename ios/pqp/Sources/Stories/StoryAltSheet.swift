import SwiftUI

/// "Describe the photo": the words a screen reader says for the picture, the
/// story's own (the photo or video the story sits on) or one placed on it. It
/// is the phone's version of the web composer's `AltTextSheet`. Saving an empty
/// box clears it; nothing here is required, a story posts the same with none.
struct StoryAltSheet: View {
    enum Kind {
        case base
        case photo

        var title: String {
            switch self {
            case .base: String(localized: "Describe the picture")
            case .photo: String(localized: "Describe the photo")
            }
        }
    }

    let kind: Kind
    let initial: String
    let onSave: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @FocusState private var focused: Bool

    init(kind: Kind, initial: String, onSave: @escaping (String) -> Void) {
        self.kind = kind
        self.initial = initial
        self.onSave = onSave
        _text = State(initialValue: StoryAltText.capped(initial))
    }

    private var left: Int { StoryAltText.remaining(text) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: kind.title)
                .font(Typography.title(18))
                .foregroundStyle(Palette.paper)
                .accessibilityAddTraits(.isHeader)
            Text("For people who use a screen reader. Say what is in it.")
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
            TextField("A dog running on the beach", text: $text, axis: .vertical)
                .lineLimit(3...5)
                .focused($focused)
                .font(Typography.body)
                .foregroundStyle(Palette.paper)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.surfaceRaised))
                .onChange(of: text) { _, value in
                    // A description is one sentence, not a paragraph, and never
                    // longer than the contract takes.
                    let flat = value.replacingOccurrences(of: "\n", with: " ")
                    let capped = StoryAltText.capped(flat)
                    if capped != value { text = capped }
                }
                .onSubmit(save)
                .submitLabel(.done)
                .accessibilityIdentifier("alt.input")
            HStack {
                Text("Characters left: \(left)")
                    .font(Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(left <= 20 ? Palette.paper : Palette.paperMuted)
                    .accessibilityIdentifier("alt.left")
                Spacer()
                Button(action: save) {
                    Text("Save")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(Palette.inkDeep)
                        .padding(.horizontal, 20)
                        .frame(minHeight: 44)
                        .background(Capsule().fill(Palette.signal))
                }
                .accessibilityIdentifier("alt.save")
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 22)
        .padding(.bottom, 12)
        .frame(maxHeight: .infinity, alignment: .top)
        .task { focused = true }
    }

    private func save() {
        onSave(text)
        dismiss()
    }
}
