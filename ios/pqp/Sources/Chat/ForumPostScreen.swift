import SwiftUI

/// A forum post, full screen (UX §2.4 #22): the ordinary `ChatView` on the
/// post's channel, with the forum's chrome around it.
///
/// A post opened from the list already knows its read cursor and mounts the
/// transcript at once. A deep link or a push does not, and the cursor has to
/// be read BEFORE the transcript marks the post read, or every revisit would
/// look like a first visit; so this asks first and mounts after.
struct ForumPostScreen: View {
    @Environment(SessionStore.self) private var session
    @State private var model: ForumPostModel
    let server: Server?

    init(model: ForumPostModel, server: Server?) {
        _model = State(initialValue: model)
        self.server = server
    }

    var body: some View {
        Group {
            if model.isReadyToOpen {
                ChatView(
                    channelId: model.postId,
                    title: model.post?.title ?? model.forumName,
                    server: server,
                    flagsServerId: model.serverId,
                    forumPost: model
                )
            } else if model.loadFailed {
                // A timeout is not a deletion: say it did not load, and retry.
                ZStack {
                    Palette.ink.ignoresSafeArea()
                    EmptyState(
                        icon: "wifi.exclamationmark",
                        title: "Couldn't load the post.",
                        message: "Check your connection.",
                        actionTitle: "Try again",
                        action: { Task { await model.loadDetail() } }
                    )
                }
            } else {
                ZStack {
                    Palette.ink.ignoresSafeArea()
                    ProgressView().tint(Palette.signal)
                }
            }
        }
        .task { await model.start(session: session) }
        .onDisappear {
            // Popped, not covered: a sheet or a profile on top keeps it.
            if model.home?.openPostId == model.postId { model.home?.openPostId = nil }
        }
        .onAppear { model.home?.openPostId = model.postId }
    }
}

/// The bar of a post: the forum and the reply count while the big title is
/// on screen, the title once it has scrolled away (never both), the follow
/// bell, and the post menu grouped by who may use each part.
struct ForumPostChrome: ViewModifier {
    let model: ForumPostModel?
    let headerOnScreen: Bool
    let replyCount: Int
    var onShowPins: () -> Void
    var onEditTags: () -> Void
    var onEditTitle: () -> Void
    var onDelete: () -> Void

    func body(content: Content) -> some View {
        if let model {
            content.toolbar {
                ToolbarItem(placement: .principal) {
                    principal(model)
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    // A deleted post has nothing left to follow or manage.
                    if model.viewer != nil && !model.isRemoved {
                        Button {
                            Task { await model.toggleFollow() }
                        } label: {
                            Image(systemName: model.viewer?.following == true ? "bell.fill" : "bell")
                                .contentTransition(.symbolEffect(.replace))
                        }
                        .tint(Palette.paper)
                        .accessibilityLabel(model.viewer?.following == true ? Text("Following") : Text("Follow"))
                        .accessibilityIdentifier("forum.post.follow")
                    }
                    if !model.isRemoved {
                        menu(model)
                    }
                }
            }
        } else {
            content
        }
    }

    @ViewBuilder
    private func principal(_ model: ForumPostModel) -> some View {
        ZStack {
            VStack(spacing: 0) {
                HStack(spacing: 5) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 12, weight: .semibold))
                    Text(verbatim: model.forumName)
                        .font(.system(size: 16, weight: .semibold))
                        .lineLimit(1)
                }
                .foregroundStyle(Palette.paper)
                Text(ForumCopy.replies(replyCount))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Palette.paperMuted)
            }
            .opacity(headerOnScreen ? 1 : 0)

            Text(verbatim: model.post?.title ?? "")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Palette.paper)
                .lineLimit(1)
                .frame(maxWidth: 230)
                .opacity(headerOnScreen ? 0 : 1)
        }
        .animation(Motion.standard, value: headerOnScreen)
        .accessibilityElement(children: .combine)
    }

    private func menu(_ model: ForumPostModel) -> some View {
        Menu {
            Section {
                if model.canEdit, let post = model.post {
                    Button {
                        Task { await model.setResolved(!post.isResolved) }
                    } label: {
                        if post.isResolved {
                            Label("Reopen", systemImage: "arrow.uturn.backward.circle")
                        } else {
                            Label("Mark as resolved", systemImage: "checkmark.circle")
                        }
                    }
                    Button(action: onEditTitle) {
                        Label("Edit title", systemImage: "pencil")
                    }
                    Button(action: onEditTags) {
                        Label("Edit tags", systemImage: "tag")
                    }
                }
                Button {
                    model.copyLink()
                    Haptics.selection()
                } label: {
                    Label("Copy link", systemImage: "link")
                }
                Button(action: onShowPins) {
                    Label("Pinned messages", systemImage: "pin")
                }
            }
            if model.isStaff, let post = model.post {
                Section("Staff") {
                    Button {
                        Task { await model.setPinned(!post.isPinned) }
                    } label: {
                        if post.isPinned {
                            Label("Unpin post", systemImage: "pin.slash")
                        } else {
                            Label(
                                String(localized: "Pin post (\(model.pinnedCount) of \(ForumLimits.maxPinned))"),
                                systemImage: "pin"
                            )
                        }
                    }
                    Button {
                        Task { await model.setLocked(!post.isLocked) }
                    } label: {
                        if post.isLocked {
                            Label("Reopen to replies", systemImage: "lock.open")
                        } else {
                            Label("Close to replies", systemImage: "lock")
                        }
                    }
                }
                Section {
                    Button(role: .destructive, action: onDelete) {
                        Label("Delete post", systemImage: "trash")
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .tint(Palette.paper)
        .accessibilityLabel(Text("Post options"))
        .accessibilityIdentifier("forum.post.menu")
    }
}

/// Copy with a number in it, in one place.
enum ForumCopy {
    static func replies(_ count: Int) -> String {
        switch count {
        case 0: String(localized: "No replies")
        case 1: String(localized: "1 reply")
        default: String(localized: "\(count) replies")
        }
    }

    static func posts(_ count: Int) -> String {
        switch count {
        case 0: String(localized: "No posts yet")
        case 1: String(localized: "1 post")
        default: String(localized: "\(count) posts")
        }
    }

    static func deleteBody(replies: Int) -> String {
        switch replies {
        case 0: String(localized: "This can't be undone.")
        case 1: String(localized: "Its reply goes with it. This can't be undone.")
        default: String(localized: "Its \(replies) replies go with it. This can't be undone.")
        }
    }

    static func live(_ count: Int) -> String {
        count == 1
            ? String(localized: "1 post with new activity")
            : String(localized: "\(count) posts with new activity")
    }

    static func end(_ count: Int) -> String {
        count == 1
            ? String(localized: "That's all. 1 post.")
            : String(localized: "That's all. \(count) posts.")
    }
}
