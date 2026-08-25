import SwiftUI

/// Threads, on a phone.
///
/// The web client shows a thread as a panel *beside* the channel, which is why
/// the protocol has a second live slot (`thread-join`). A 390pt screen has room
/// for one conversation, so here a thread is pushed as a full `ChatView` — and
/// that works with no new machinery at all, because a thread IS a channel:
/// `join-channel` accepts a thread id, its access check answers with the
/// parent's answer, and messages, reactions, pins and reports all key off the
/// same channel id they always did.

/// The affordance on an origin message: name, reply count, freshness, archived
/// state, one tap to open. Content-free by design — the chip is fed by
/// `thread-update` and history hydration, neither of which ever carries a
/// thread message body into the parent channel.
struct ThreadChip: View {
    let thread: ThreadSummary
    var onOpen: () -> Void = {}

    /// Recomputed locally rather than trusting the flag: the summary may have
    /// been sitting on screen for a while, and a chip that says "active" for a
    /// thread that crossed the line an hour ago is a small lie with no upside.
    private var archived: Bool {
        thread.archived || ThreadRules.isArchived(thread.lastActivityAt)
    }

    private var replies: String {
        switch thread.replyCount {
        case 0: String(localized: "No replies yet")
        case 1: String(localized: "1 reply")
        default: String(localized: "\(thread.replyCount) replies")
        }
    }

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 6) {
                Image(systemName: archived ? "archivebox" : "bubble.left.and.text.bubble.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(archived ? Palette.paperMuted : Palette.signal)

                Text(thread.name)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.signal)
                    .lineLimit(1)

                Text(replies)
                    .font(Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Palette.paperMuted)

                if archived {
                    Text("ARCHIVED")
                        .font(.system(size: 9, weight: .bold))
                        .tracking(0.6)
                        .foregroundStyle(Palette.paperMuted)
                } else if thread.replyCount > 0 {
                    Text(thread.lastActivityAt, format: .relative(presentation: .numeric))
                        .font(.system(size: 10))
                        .foregroundStyle(Palette.paperMuted)
                        .lineLimit(1)
                }

                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Palette.paperMuted)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Palette.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(archived ? Palette.border : Palette.signal.opacity(0.45),
                                          lineWidth: 1)
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Thread: \(thread.name), \(replies)"))
        .padding(.top, 2)
    }
}

extension View {
    /// Pushes a thread as a full chat when `target` is set.
    ///
    /// A modifier rather than inline code so `ChatView` gains one line for the
    /// whole navigation. `ChatView` keys its model by channel id and a thread
    /// id is a channel id, so the pushed screen needs no thread-specific state.
    func threadDestination(_ target: Binding<ThreadSummary?>) -> some View {
        navigationDestination(item: target) { thread in
            ChatView(channelId: thread.channelId, title: thread.name)
        }
    }
}

/// Every thread in a channel, newest activity first.
///
/// There is no `GET /api/channels/:id/threads` — a thread rides on its origin
/// message, folded into every history page — so this reads one page of history
/// (the server's maximum) and derives the list from it. That is the same set of
/// threads the channel view can show chips for, which is the honest scope: a
/// thread whose origin has scrolled past a hundred messages is reachable by
/// scrolling back to it, exactly as on the web.
struct ThreadListView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let channel: Channel

    @State private var threads: [ThreadSummary] = []
    @State private var origins: [String: Message] = [:]
    @State private var loading = true
    @State private var opened: ThreadSummary?

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                if loading {
                    ProgressView().tint(Palette.signal)
                } else if threads.isEmpty {
                    EmptyState(
                        icon: "bubble.left.and.text.bubble.right",
                        title: "No threads here",
                        message: "Long-press a message and pick Start thread to take a tangent out of the main channel."
                    )
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(threads) { thread in
                                Button {
                                    opened = thread
                                } label: {
                                    ThreadRow(thread: thread, origin: origins[thread.channelId])
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.top, 8)
                    }
                    .refreshable { await load() }
                }
            }
            .navigationTitle("Threads in #\(channel.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.tint(Palette.paperMuted)
                }
            }
            .threadDestination($opened)
            .task { await load() }
        }
    }

    private func load() async {
        loading = true
        // 100 is MESSAGE_PAGE_MAX; asking for more is clamped, not refused.
        if let page = try? await session.api.messages(channelId: channel.id, limit: 100) {
            threads = ThreadDigest.threads(in: page.messages)
            origins = ThreadDigest.origins(in: page.messages)
        }
        loading = false
    }
}

private struct ThreadRow: View {
    let thread: ThreadSummary
    let origin: Message?

    private var archived: Bool {
        thread.archived || ThreadRules.isArchived(thread.lastActivityAt)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: archived ? "archivebox" : "bubble.left.and.text.bubble.right")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(archived ? Palette.paperMuted : Palette.signal)
                .frame(width: 22)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 3) {
                Text(thread.name)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)

                HStack(spacing: 6) {
                    Text(thread.replyCount == 1
                         ? String(localized: "1 reply")
                         : String(localized: "\(thread.replyCount) replies"))
                        .monospacedDigit()
                    Text(verbatim: "·")
                    Text(thread.lastActivityAt, format: .relative(presentation: .named))
                        .lineLimit(1)
                }
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)

                // The message the thread grew out of — context, not part of the
                // thread's own history. A deleted origin says so rather than
                // vanishing: the conversation outlives the message.
                if let origin, !origin.body.isEmpty {
                    Text(verbatim: "\(origin.authorName): \(origin.body)")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                        .lineLimit(1)
                } else if thread.rootMessageId == nil {
                    Text("Original message deleted")
                        .font(Typography.caption)
                        .italic()
                        .foregroundStyle(Palette.paperMuted)
                }
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Palette.paperMuted)
                .padding(.top, 3)
        }
        .padding(12)
        .pqpSurface()
    }
}
