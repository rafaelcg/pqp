import SwiftUI

/// Emoji picker for reactions.
///
/// A hand-built grid rather than a dependency: the set below is the common
/// reaction vocabulary, and shipping a full Unicode index would be megabytes to
/// solve a problem nobody has when reacting to a message. The system keyboard
/// covers everything else in the composer.
struct EmojiPicker: View {
    @Environment(\.dismiss) private var dismiss
    let onPick: (String) -> Void

    private let groups: [(String, [String])] = [
        ("Reactions", ["👍", "👎", "😂", "🔥", "❤️", "🎉", "👀", "🙏", "💯", "✅", "❌", "🤝"]),
        ("Faces", ["😀", "😅", "😊", "😍", "🤔", "😐", "😴", "😭", "😡", "🤯", "🥳", "😎",
                   "🙃", "😬", "🤷", "🫠", "🥲", "😤"]),
        ("Hands", ["👋", "🤞", "✌️", "🤙", "💪", "🫶", "👏", "🙌", "🤌", "👌", "🖖", "🫡"]),
        ("Things", ["🚀", "⚡", "🐛", "💡", "📌", "🎯", "🍕", "☕", "🎧", "🧠", "💀", "🌈",
                    "⭐", "🔔", "📎", "🧊"]),
    ]

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 6)

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14, pinnedViews: [.sectionHeaders]) {
                        ForEach(groups, id: \.0) { group in
                            Section {
                                LazyVGrid(columns: columns, spacing: 8) {
                                    ForEach(group.1, id: \.self) { emoji in
                                        Button {
                                            onPick(emoji)
                                            dismiss()
                                        } label: {
                                            Text(emoji)
                                                .font(.system(size: 30))
                                                .frame(maxWidth: .infinity, minHeight: 46)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            } header: {
                                SectionLabel(text: group.0)
                                    .padding(.vertical, 4)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Palette.ink)
                            }
                        }
                    }
                    .padding(.horizontal, Metrics.hPadding)
                    .padding(.vertical, 8)
                }
            }
            .navigationTitle("React")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.tint(Palette.paperMuted)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// GIF picker.
///
/// Off entirely unless the deployment configured a GIF provider, the same as
/// attachments — the button is hidden rather than failing on tap.
struct GifPicker: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let onPick: (Gif) -> Void

    @State private var query = ""
    @State private var gifs: [Gif] = []
    @State private var loading = true
    @State private var error: String?
    @State private var task: Task<Void, Never>?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 2)

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                VStack(spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(Palette.paperMuted)
                        TextField("Search GIFs", text: $query)
                            .textFieldStyle(.plain)
                            .foregroundStyle(Palette.paper)
                            .autocorrectionDisabled()
                            .onChange(of: query) { _, value in schedule(value) }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .pqpSurface(cornerRadius: 20)
                    .padding(.horizontal, Metrics.hPadding)

                    if loading {
                        ProgressView().tint(Palette.signal).padding(.top, 30)
                    } else if let error {
                        Text(error)
                            .font(Typography.callout)
                            .foregroundStyle(Palette.danger)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }

                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 6) {
                            ForEach(gifs) { gif in
                                Button {
                                    onPick(gif)
                                    dismiss()
                                } label: {
                                    AsyncImage(url: URL(string: gif.previewUrl)) { image in
                                        image.resizable().scaledToFill()
                                    } placeholder: {
                                        Rectangle().fill(Palette.surface)
                                    }
                                    .frame(height: 110)
                                    .clipped()
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, Metrics.hPadding)
                    }

                    Spacer(minLength: 0)
                }
                .padding(.top, 8)
            }
            .navigationTitle("GIFs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.tint(Palette.paperMuted)
                }
            }
            .task { await loadTrending() }
        }
        .presentationDetents([.medium, .large])
    }

    private func loadTrending() async {
        loading = true
        do {
            gifs = try await session.api.trendingGifs()
            error = nil
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        loading = false
    }

    /// Debounced: GIF search spends the deployment's third-party quota, so the
    /// server budgets it tightly and a request per keystroke burns it.
    private func schedule(_ value: String) {
        task?.cancel()
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        task = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            loading = true
            do {
                gifs = trimmed.isEmpty
                    ? try await session.api.trendingGifs()
                    : try await session.api.searchGifs(query: trimmed)
                error = nil
            } catch {
                self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
            loading = false
        }
    }
}

/// A link unfurl, as the server resolved it.
///
/// The accent bar on the leading edge is the same device the web client uses,
/// so a link looks like the same object on both.
struct EmbedCard: View {
    let embed: Embed

    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(Palette.signal)
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 4) {
                if let siteName = embed.siteName {
                    Text(siteName)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                }
                if let title = embed.title {
                    Text(title)
                        .font(Typography.bodyMedium)
                        .foregroundStyle(Palette.signal)
                        .lineLimit(2)
                }
                if let description = embed.description {
                    Text(description)
                        .font(Typography.callout)
                        .foregroundStyle(Palette.paperMuted)
                        .lineLimit(3)
                }
                if let imageUrl = embed.imageUrl, let url = URL(string: imageUrl) {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFit()
                    } placeholder: {
                        EmptyView()
                    }
                    .frame(maxWidth: 240, maxHeight: 160)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .padding(.top, 2)
                }
            }
            .padding(10)

            Spacer(minLength: 0)
        }
        .background(Palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
        .frame(maxWidth: 300, alignment: .leading)
        .onTapGesture {
            if let url = URL(string: embed.url) { UIApplication.shared.open(url) }
        }
    }
}
