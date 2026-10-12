import SwiftUI

/// Who saw your story, newest first, with each one's reaction and whether
/// they replied. The author only; nobody else ever sees this list.
struct StoryViewersSheet: View {
    @Environment(SessionStore.self) private var session
    let story: Story
    /// Delete, handed back to the viewer, which owns the confirmation.
    let onAction: (StoryViewer.PendingAction) -> Void

    @State private var rows: [StoryViewerRow] = []
    @State private var cursor: String?
    @State private var viewCount = 0
    @State private var reactionCount = 0
    @State private var loaded = false
    @State private var loadingMore = false
    @State private var handlerKey = "story-viewers-" + UUID().uuidString

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Seen by \(viewCount)")
                    .font(Typography.title(19))
                    .foregroundStyle(Palette.paper)
                Text("\(reactionCount) reactions · gone in \(StoryRules.left(until: story.expiresAt))")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }
            HStack(spacing: 8) {
                Button(role: .destructive) { onAction(.delete(story)) } label: {
                    Label("Delete", systemImage: "trash")
                        .font(Typography.caption.weight(.semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(Capsule().strokeBorder(Palette.danger.opacity(0.6)))
                }
                .tint(Palette.danger)
            }
            SectionLabel(text: String(localized: "Who saw it"))

            if loaded && rows.isEmpty {
                Text("Nobody has seen it yet")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
                    .padding(.top, 8)
            }
            ScrollView {
                LazyVStack(spacing: 4) {
                    ForEach(rows) { row in
                        HStack(spacing: 12) {
                            Avatar(name: row.user.displayName, seed: row.user.id, size: 40, url: row.user.avatarUrl)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(verbatim: row.user.displayName)
                                    .font(Typography.bodyMedium)
                                    .foregroundStyle(Palette.paper)
                                Text(verbatim: line(for: row))
                                    .font(Typography.caption)
                                    .foregroundStyle(Palette.paperMuted)
                            }
                            Spacer()
                            if let reaction = row.reaction {
                                Text(verbatim: StoryRules.glyph(for: reaction))
                                    .font(.system(size: reaction == "gg" ? 11 : 20, weight: .heavy))
                                    .foregroundStyle(reaction == "gg" ? Palette.inkDeep : Palette.paper)
                                    .padding(.horizontal, reaction == "gg" ? 6 : 0)
                                    .padding(.vertical, reaction == "gg" ? 3 : 0)
                                    .background(Capsule().fill(reaction == "gg" ? Palette.signal : .clear))
                            } else if row.replied {
                                Image(systemName: "bubble.left")
                                    .foregroundStyle(Palette.signal)
                            }
                        }
                        .padding(.vertical, 6)
                        .onAppear {
                            if row.id == rows.last?.id { Task { await loadMore() } }
                        }
                    }
                }
            }
        }
        .padding(Metrics.hPadding)
        .padding(.top, 8)
        .task { await reload() }
        // New views arrive as `stories-update` with `scope: own`, at most one
        // per 10 s: the open sheet refreshes on it.
        .onAppear {
            session.eventHandlers[handlerKey] = { event in
                guard case .storiesUpdate(let update) = event, update.scope == "own" else { return }
                Task { await reload() }
            }
        }
        .onDisappear { session.eventHandlers.removeValue(forKey: handlerKey) }
        .accessibilityIdentifier("story.viewersSheet")
    }

    private func line(for row: StoryViewerRow) -> String {
        let ago = String(localized: "\(StoryRules.age(since: row.viewedAt)) ago")
        return row.replied ? String(localized: "\(ago) · replied") : ago
    }

    private func reload() async {
        guard let page = try? await session.api.storyViewers(id: story.id) else {
            loaded = true
            return
        }
        rows = page.viewers
        cursor = page.nextCursor
        viewCount = page.viewCount
        reactionCount = page.reactionCount
        loaded = true
    }

    private func loadMore() async {
        guard let cursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        guard let page = try? await session.api.storyViewers(id: story.id, cursor: cursor) else { return }
        rows += page.viewers.filter { row in !rows.contains { $0.id == row.id } }
        self.cursor = page.nextCursor
    }
}
