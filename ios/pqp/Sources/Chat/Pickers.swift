import SwiftUI

/// The emoji vocabulary, with a searchable name per entry.
///
/// A hand-built catalog rather than a dependency: this is the common reaction
/// and chat vocabulary, and shipping a full Unicode index would be megabytes to
/// solve a problem nobody has when reacting to a message. The system keyboard
/// still covers everything else in the composer.
///
/// Names exist so the sheet can be searched — "fire", "heart", "cry" — which is
/// the difference between a picker you scan and a picker you use.
enum EmojiCatalog {
    struct Entry: Hashable, Identifiable, Sendable {
        let emoji: String
        /// Space-separated search terms. Matched as prefixes of any word, so
        /// "he" finds "heart" but "art" does not — a substring match on a list
        /// this short returns everything for two letters.
        let name: String

        var id: String { emoji }
    }

    static let groups: [(name: String, entries: [Entry])] = [
        ("Reactions", [
            Entry(emoji: "👍", name: "thumbs up yes ok like"),
            Entry(emoji: "👎", name: "thumbs down no dislike"),
            Entry(emoji: "😂", name: "joy laugh lol funny"),
            Entry(emoji: "🔥", name: "fire lit hot"),
            Entry(emoji: "❤️", name: "heart love red"),
            Entry(emoji: "🎉", name: "party tada celebrate"),
            Entry(emoji: "👀", name: "eyes look watching"),
            Entry(emoji: "🙏", name: "pray please thanks"),
            Entry(emoji: "💯", name: "hundred perfect score"),
            Entry(emoji: "✅", name: "check done yes tick"),
            Entry(emoji: "❌", name: "cross no wrong"),
            Entry(emoji: "🤝", name: "handshake deal agree"),
        ]),
        ("Faces", [
            Entry(emoji: "😀", name: "grin smile happy"),
            Entry(emoji: "😅", name: "sweat nervous laugh"),
            Entry(emoji: "😊", name: "smile blush happy"),
            Entry(emoji: "😍", name: "love hearts eyes"),
            Entry(emoji: "🤔", name: "thinking hmm think"),
            Entry(emoji: "😐", name: "neutral meh flat"),
            Entry(emoji: "😴", name: "sleep tired zzz"),
            Entry(emoji: "😭", name: "cry sob sad"),
            Entry(emoji: "😡", name: "angry mad rage"),
            Entry(emoji: "🤯", name: "mind blown shock"),
            Entry(emoji: "🥳", name: "party face celebrate"),
            Entry(emoji: "😎", name: "cool sunglasses"),
            Entry(emoji: "🙃", name: "upside down irony"),
            Entry(emoji: "😬", name: "grimace awkward yikes"),
            Entry(emoji: "🤷", name: "shrug dunno whatever"),
            Entry(emoji: "🫠", name: "melting melt heat"),
            Entry(emoji: "🥲", name: "tear smile bittersweet"),
            Entry(emoji: "😤", name: "huff triumph steam"),
        ]),
        ("Hands", [
            Entry(emoji: "👋", name: "wave hi bye hello"),
            Entry(emoji: "🤞", name: "fingers crossed luck"),
            Entry(emoji: "✌️", name: "peace victory"),
            Entry(emoji: "🤙", name: "call shaka hang loose"),
            Entry(emoji: "💪", name: "muscle strong flex"),
            Entry(emoji: "🫶", name: "heart hands love"),
            Entry(emoji: "👏", name: "clap applause bravo"),
            Entry(emoji: "🙌", name: "raise hands praise"),
            Entry(emoji: "🤌", name: "pinched italian chef"),
            Entry(emoji: "👌", name: "ok perfect fine"),
            Entry(emoji: "🖖", name: "vulcan spock"),
            Entry(emoji: "🫡", name: "salute yes sir"),
        ]),
        ("Things", [
            Entry(emoji: "🚀", name: "rocket ship launch ship it"),
            Entry(emoji: "⚡", name: "zap lightning fast"),
            Entry(emoji: "🐛", name: "bug insect defect"),
            Entry(emoji: "💡", name: "idea bulb light"),
            Entry(emoji: "📌", name: "pin pushpin"),
            Entry(emoji: "🎯", name: "target bullseye goal"),
            Entry(emoji: "🍕", name: "pizza food"),
            Entry(emoji: "☕", name: "coffee cafe tea"),
            Entry(emoji: "🎧", name: "headphones music audio"),
            Entry(emoji: "🧠", name: "brain smart mind"),
            Entry(emoji: "💀", name: "skull dead dying"),
            Entry(emoji: "🌈", name: "rainbow pride"),
            Entry(emoji: "⭐", name: "star favourite"),
            Entry(emoji: "🔔", name: "bell notification ping"),
            Entry(emoji: "📎", name: "clip attachment paperclip"),
            Entry(emoji: "🧊", name: "ice cube cold"),
        ]),
    ]

    static let all: [Entry] = groups.flatMap(\.entries)

    /// Pure, so the search is testable without a screen. An empty query means
    /// "no filter" rather than "no results" — the grouped grid is what a blank
    /// search field should be showing.
    static func search(_ query: String) -> [Entry] {
        let terms = query
            .lowercased()
            .split(separator: " ")
            .map(String.init)
            .filter { !$0.isEmpty }
        guard !terms.isEmpty else { return all }
        return all.filter { entry in
            // Every term has to match something, so "red heart" narrows rather
            // than widens.
            terms.allSatisfy { term in
                entry.emoji == term
                    || entry.name.split(separator: " ").contains { $0.hasPrefix(term) }
            }
        }
    }
}

/// Emoji and GIFs, in one sheet.
///
/// They used to be two: a smiley in the message menu and a separate "GIF" text
/// button in the composer, which meant two different journeys for "put
/// something expressive in this message" and a composer row cluttered with the
/// rarer of the two. One smiley, two tabs — and the GIF tab only exists when
/// the deployment actually configured a provider, so the tab bar never offers a
/// dead end.
struct ExpressionPicker: View {
    enum Mode {
        /// Opened from the composer: emoji are inserted into the draft and the
        /// sheet stays up, because picking two in a row is normal.
        case compose
        /// Opened from a message's menu: one emoji, then done.
        case reaction
    }

    @Environment(\.dismiss) private var dismiss
    let mode: Mode
    var gifsEnabled = false
    var onEmoji: (String) -> Void
    var onGif: (Gif) -> Void = { _ in }

    @State private var tab = Tab.emoji
    @State private var query = ""

    private enum Tab: String, CaseIterable, Identifiable {
        case emoji, gifs
        var id: String { rawValue }
        var label: LocalizedStringKey {
            switch self {
            case .emoji: "Emoji"
            case .gifs: "GIFs"
            }
        }
    }

    /// GIFs are a compose-time thing: the reaction protocol takes an emoji, so
    /// offering the tab there would be offering something that cannot be sent.
    private var showsGifTab: Bool { mode == .compose && gifsEnabled }

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                VStack(spacing: 10) {
                    if showsGifTab { tabBar }
                    searchField

                    switch tab {
                    case .emoji:
                        EmojiGrid(query: query) { emoji in
                            Haptics.selection()
                            onEmoji(emoji)
                            if mode == .reaction { dismiss() }
                        }
                    case .gifs:
                        GifGrid(query: query) { gif in
                            onGif(gif)
                            dismiss()
                        }
                    }
                }
                .padding(.top, 8)
            }
            .navigationTitle(mode == .reaction ? "React" : "Express yourself")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                        .tint(Palette.paperMuted)
                        .accessibilityIdentifier("picker.done")
                }
            }
        }
        // Medium first: the sheet lands roughly where the keyboard was, so the
        // composer stays visible above it and the transition reads as the
        // keyboard being replaced rather than the screen being taken over.
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var tabBar: some View {
        HStack(spacing: 8) {
            ForEach(Tab.allCases) { candidate in
                Button {
                    withAnimation(Motion.press) {
                        tab = candidate
                        // The two searches are different corpora; carrying a
                        // GIF query into the emoji grid returns nothing and
                        // reads as a broken tab.
                        query = ""
                    }
                } label: {
                    Text(candidate.label)
                        .font(Typography.caption)
                        .foregroundStyle(tab == candidate ? Palette.inkDeep : Palette.paperMuted)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(
                            Capsule().fill(tab == candidate ? Palette.signal : Palette.surface)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("picker.tab.\(candidate.rawValue)")
            }
            Spacer()
        }
        .padding(.horizontal, Metrics.hPadding)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Palette.paperMuted)
            TextField(tab == .emoji ? "Search emoji" : "Search GIFs", text: $query)
                .textFieldStyle(.plain)
                .foregroundStyle(Palette.paper)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("picker.search")
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.paperMuted)
                }
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .pqpSurface(cornerRadius: 20)
        .padding(.horizontal, Metrics.hPadding)
    }
}

/// The emoji half. Grouped while the search is empty, one flat result list once
/// it is not — section headers over three matches are noise.
private struct EmojiGrid: View {
    let query: String
    let onPick: (String) -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 6)

    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        ScrollView {
            if isSearching {
                let results = EmojiCatalog.search(query)
                if results.isEmpty {
                    Text("No emoji match that.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.paperMuted)
                        .padding(.top, 30)
                } else {
                    LazyVGrid(columns: columns, spacing: 8) {
                        ForEach(results) { entry in cell(entry.emoji) }
                    }
                    .padding(.horizontal, Metrics.hPadding)
                }
            } else {
                LazyVStack(alignment: .leading, spacing: 14, pinnedViews: [.sectionHeaders]) {
                    ForEach(EmojiCatalog.groups, id: \.name) { group in
                        Section {
                            LazyVGrid(columns: columns, spacing: 8) {
                                ForEach(group.entries) { entry in cell(entry.emoji) }
                            }
                        } header: {
                            SectionLabel(text: group.name)
                                .padding(.vertical, 4)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Palette.ink)
                        }
                    }
                }
                .padding(.horizontal, Metrics.hPadding)
                .padding(.vertical, 4)
            }
        }
    }

    private func cell(_ emoji: String) -> some View {
        Button {
            onPick(emoji)
        } label: {
            Text(emoji)
                .font(.system(size: 30))
                .frame(maxWidth: .infinity, minHeight: 46)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("emoji.\(emoji)")
    }
}

/// The GIF half.
///
/// Search is debounced because it spends the deployment's third-party quota,
/// which the server budgets tightly — a request per keystroke burns it inside a
/// word.
private struct GifGrid: View {
    @Environment(SessionStore.self) private var session
    let query: String
    let onPick: (Gif) -> Void

    @State private var gifs: [Gif] = []
    @State private var loading = true
    @State private var error: String?
    @State private var task: Task<Void, Never>?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 2)

    var body: some View {
        VStack(spacing: 8) {
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
                        } label: {
                            // The preview is itself a GIF (the server only ever
                            // hands back `.gif` preview URLs), so a static
                            // `AsyncImage` would show one frozen frame here —
                            // exactly the bug this view exists to avoid.
                            AnimatedImageView(
                                url: URL(string: gif.previewUrl),
                                contentMode: .scaleAspectFill
                            )
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
        .task { await load(query) }
        .onChange(of: query) { _, value in schedule(value) }
        .onDisappear { task?.cancel() }
    }

    private func schedule(_ value: String) {
        task?.cancel()
        task = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await load(value)
        }
    }

    private func load(_ value: String) async {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
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
