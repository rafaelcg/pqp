import SwiftUI
import AVKit
import Combine

/// A server's Baú: the posts that stay, newest first.
///
/// Reading and reacting is for everybody. Staff (whoever the server lets
/// publish, see `communityHomeComposer`) also get a "new post" button; drafts
/// and the schedule stay on the web.
struct CommunityHomeView: View {
    @Environment(SessionStore.self) private var session
    let server: Server
    let config: CommunityHomeConfig
    /// The post a Baú card in chat (or a Baú link) asked for. The feed scrolls
    /// to it once and outlines it for a moment; a post that is not in the feed
    /// (gone, or not this viewer's) leaves the feed as it was.
    var focusPostId: String? = nil
    /// The screen a `#channel` in a post opens, built by whoever owns channel
    /// navigation (the channel list). Absent: the link is drawn but inert.
    var chatDestination: ((Channel) -> AnyView)?

    @State private var focusPending = true
    @State private var highlightedPostId: String?
    @State private var posts: [CommunityHomePost] = []
    @State private var isLoading = true
    @State private var error: String?
    /// Posts whose full comment list has been fetched, by post id.
    @State private var expanded: [String: [CommunityHomeComment]] = [:]
    @State private var loadingComments: Set<String> = []
    @State private var handlerKey = UUID().uuidString
    /// The channels this account can see here, for drawing `#channel`. The
    /// API stores only an id; a channel that is not in this list gets no name.
    @State private var channels: [Channel] = []
    @State private var openedChannel: Channel?

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            if isLoading && posts.isEmpty {
                ProgressView().tint(Palette.signal)
            } else if let error, posts.isEmpty {
                EmptyState(
                    icon: "exclamationmark.triangle",
                    title: "Could not load the Baú",
                    message: LocalizedStringKey(error),
                    actionTitle: "Try again",
                    action: { Task { await load() } }
                )
            } else if posts.isEmpty {
                EmptyState(
                    icon: "archivebox",
                    title: "Nothing in the Baú yet",
                    message: "When the staff of \(server.name) posts, it shows up here."
                )
            } else {
                ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(posts) { post in
                            PostCard(
                                post: post,
                                vipEnabled: config.vipEnabled,
                                channels: channels,
                                onOpenChannel: { channel in
                                    if chatDestination != nil { openedChannel = channel }
                                },
                                expanded: expanded[post.id],
                                loadingComments: loadingComments.contains(post.id),
                                onToggleLike: { Task { await toggleLike(post) } },
                                onLoadAll: { Task { await loadAllComments(post) } },
                                onCollapse: { expanded.removeValue(forKey: post.id) },
                                onComment: { body in await addComment(post, body: body) }
                            )
                            .overlay {
                                if highlightedPostId == post.id {
                                    RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                                        .strokeBorder(Palette.signal, lineWidth: 2)
                                        .allowsHitTesting(false)
                                }
                            }
                            .id(post.id)
                        }
                    }
                    .padding(.horizontal, Metrics.hPadding)
                    .padding(.vertical, 12)
                }
                .refreshable {
                    async let fresh: Void = loadChannels()
                    await load()
                    await fresh
                }
                .accessibilityIdentifier("bau.feed")
                // The restore button of a Picture in Picture window brings
                // the person back to the post that was playing.
                .onChange(of: BauPlayback.shared.restoreTargetPostID) { _, target in
                    guard let target else { return }
                    BauPlayback.shared.restoreTargetPostID = nil
                    withAnimation { proxy.scrollTo(target, anchor: .top) }
                }
                .onChange(of: posts.map(\.id), initial: true) { _, ids in
                    focusIfNeeded(in: ids, proxy: proxy)
                }
                }
            }
        }
        .navigationTitle("Baú")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // Once per opening, beside the feed and not inside every reload: a
            // burst of updates must not turn into a burst of channel-list reads.
            Task { await loadChannels() }
            await load()
            // A publish, a comment, a deletion: the frame says "refetch" and
            // nothing more (likes deliberately do not fan out). The feed is
            // small and unpaginated on the API this pass, so a refetch is the
            // whole list. Expanded comment lists are dropped so a deleted
            // comment does not survive on screen.
            session.eventHandlers[handlerKey] = { event in
                if case .communityHomeUpdate(let serverId) = event, serverId == server.id {
                    expanded = [:]
                    Task { await load() }
                }
            }
        }
        .onDisappear {
            session.eventHandlers.removeValue(forKey: handlerKey)
            // Scrolling a playing card away keeps it going in Picture in
            // Picture; leaving the Baú altogether does not.
            BauPlayback.shared.stopAllUnlessFullScreen()
        }
        .communityHomeComposer(server: server, config: config, channels: channels) { Task { await load() } }
        .navigationDestination(item: $openedChannel) { channel in
            chatDestination?(channel) ?? AnyView(EmptyView())
        }
    }

    /// Best effort: without it a `#channel` is the neutral "unavailable" mark.
    private func loadChannels() async {
        if let fresh = try? await session.api.channels(serverId: server.id) { channels = fresh }
    }

    /// Once per screen: bring the asked-for post into view and outline it.
    private func focusIfNeeded(in ids: [String], proxy: ScrollViewProxy) {
        guard focusPending, let focusPostId, ids.contains(focusPostId) else { return }
        focusPending = false
        withAnimation(Motion.standard) {
            proxy.scrollTo(focusPostId, anchor: .top)
            highlightedPostId = focusPostId
        }
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            withAnimation(Motion.standard) { highlightedPostId = nil }
        }
    }

    private func load() async {
        isLoading = true
        do {
            posts = try await session.api.communityHomePosts(serverId: server.id)
            error = nil

            // Only after the posts arrived: a read marker for a page that
            // failed to load would clear a badge for posts nobody has seen.
            // Best effort past that point, since the posts are the screen and
            // the marker is bookkeeping. The channel list re-reads the count
            // on the way back, which is what clears the row's badge here.
            try? await session.api.markCommunityHomeRead(serverId: server.id)
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }

    /// Applied locally first, then confirmed by the response, which carries the
    /// count the server settled on. A heart that waits for the round trip reads
    /// as a dead control; a heart that never hears back is rolled back.
    private func toggleLike(_ post: CommunityHomePost) async {
        guard let index = posts.firstIndex(where: { $0.id == post.id }) else { return }
        let before = posts[index]
        posts[index].likedByMe.toggle()
        posts[index].likeCount = max(0, before.likeCount + (before.likedByMe ? -1 : 1))
        do {
            let result = try await session.api.toggleCommunityHomeLike(serverId: server.id, postId: post.id)
            if let current = posts.firstIndex(where: { $0.id == post.id }) {
                posts[current].likedByMe = result.liked
                posts[current].likeCount = result.likeCount
            }
        } catch {
            if let current = posts.firstIndex(where: { $0.id == post.id }) {
                posts[current] = before
            }
        }
    }

    /// "See all N": fetch the whole list once and keep it under the card.
    private func loadAllComments(_ post: CommunityHomePost) async {
        guard !loadingComments.contains(post.id), expanded[post.id] == nil else { return }
        loadingComments.insert(post.id)
        if let all = try? await session.api.communityHomeComments(serverId: server.id, postId: post.id) {
            expanded[post.id] = all
        }
        loadingComments.remove(post.id)
    }

    /// Post a comment. The card is patched from the response rather than
    /// refetched: the teaser becomes the two newest, the count goes up by one,
    /// and an expanded list gets the new row at the end, which is exactly what
    /// the web does with the same response.
    private func addComment(_ post: CommunityHomePost, body: String) async -> Bool {
        guard let comment = try? await session.api.addCommunityHomeComment(
            serverId: server.id, postId: post.id, body: body
        ) else { return false }
        if let index = posts.firstIndex(where: { $0.id == post.id }) {
            posts[index].commentTeaser = Array((posts[index].commentTeaser + [comment]).suffix(2))
            posts[index].commentCount += 1
        }
        if let all = expanded[post.id] {
            expanded[post.id] = all + [comment]
        }
        return true
    }
}

private struct PostCard: View {
    let post: CommunityHomePost
    let vipEnabled: Bool
    let channels: [Channel]
    let onOpenChannel: (Channel) -> Void
    let expanded: [CommunityHomeComment]?
    let loadingComments: Bool
    let onToggleLike: () -> Void
    let onLoadAll: () -> Void
    let onCollapse: () -> Void
    let onComment: (String) async -> Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header

            if let title = post.title, !title.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(title)
                        .font(Typography.title(18))
                        .foregroundStyle(Palette.paper)
                    // No "free" chip ever, and a VIP chip only while the VIP
                    // half of the feature is on: with it off, members-only
                    // posts are not in the feed at all.
                    if post.isMembersOnly && vipEnabled {
                        Chip(text: "VIP", accent: true)
                    }
                }
            }

            if post.locked {
                if let teaser = post.teaser, !teaser.isEmpty {
                    BauBodyText(text: teaser, channels: channels, onOpenChannel: onOpenChannel)
                        .font(Typography.callout)
                        .foregroundStyle(Palette.paperMuted)
                }
                LockedBox()
            } else {
                if let body = post.body, !body.isEmpty {
                    if let gifURL = GifLinks.mediaBody(body) {
                        BauGif(url: gifURL)
                    } else {
                        BauBodyText(text: body, channels: channels, onOpenChannel: onOpenChannel)
                            .font(Typography.body)
                            .foregroundStyle(Palette.paper)
                    }
                }
                if let media = post.media {
                    MediaView(media: media, postID: post.id)
                }
            }

            actions

            CommentsBlock(
                post: post,
                expanded: expanded,
                loadingComments: loadingComments,
                onLoadAll: onLoadAll,
                onCollapse: onCollapse,
                onComment: onComment
            )
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .pqpSurface()
        .accessibilityIdentifier("bau.post")
    }

    private var header: some View {
        HStack(spacing: 10) {
            Avatar(name: post.author.displayName, seed: post.author.id, size: 36, url: post.author.avatarUrl)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(post.author.displayName)
                        .font(Typography.bodyMedium)
                        .foregroundStyle(Palette.paper)
                        .lineLimit(1)
                    switch post.authorBadge {
                    case "owner": Chip(text: String(localized: "owner"), accent: false)
                    case "staff": Chip(text: String(localized: "staff"), accent: false)
                    default: EmptyView()
                    }
                }
                Text(DayLabels.label(for: post.shownAt))
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }
            Spacer(minLength: 0)
        }
    }

    private var actions: some View {
        HStack(spacing: 16) {
            Button(action: onToggleLike) {
                HStack(spacing: 5) {
                    Image(systemName: post.likedByMe ? "heart.fill" : "heart")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(post.likedByMe ? Palette.signal : Palette.paperMuted)
                    Text(String(post.likeCount))
                        .font(Typography.caption)
                        .monospacedDigit()
                        .foregroundStyle(Palette.paperMuted)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(post.likedByMe ? Text("Remove like") : Text("Like"))
            .accessibilityIdentifier("bau.like")

            HStack(spacing: 5) {
                Image(systemName: "bubble.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.paperMuted)
                Text(String(post.commentCount))
                    .font(Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Palette.paperMuted)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("Comments"))
            .accessibilityValue(Text(String(post.commentCount)))

            Spacer(minLength: 0)
        }
        .padding(.top, 2)
    }
}

private struct Chip: View {
    let text: String
    let accent: Bool

    var body: some View {
        Text(text)
            .font(Typography.label)
            .foregroundStyle(accent ? Palette.inkDeep : Palette.paperMuted)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                Capsule().fill(accent ? Palette.signal : Palette.surfaceRaised)
            )
    }
}

/// What a member without the cargo sees instead of the body.
///
/// The button is disabled and says so. There is no checkout on any client,
/// and a button that opened nothing would be worse than one that admits it is
/// not ready.
private struct LockedBox: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.paperMuted)
                Text("VIP post")
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
            }
            Text("The full post is for members with the VIP cargo.")
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
            Button("VIP, coming soon") {}
                .buttonStyle(SecondaryButtonStyle())
                .disabled(true)
                .padding(.top, 4)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                .fill(Palette.surfaceRaised)
        )
        .accessibilityIdentifier("bau.locked")
    }
}

/// One post's media. Every kind opens *out*: the image in the browser, the
/// video and the file in Safari or a viewer, YouTube / Twitch / TikTok /
/// Instagram in their apps. A phone has better players for all of those than
/// a chat app does, and a card that plays sound on scroll is the thing the
/// web's `preload="none"` exists to avoid.
private struct MediaView: View {
    @Environment(\.openURL) private var openURL
    let media: CommunityHomeMedia
    var postID: String?

    var body: some View {
        if let videoURL = media.inlineVideoURL {
            // A stored video plays in place, like the web's `<video>`. It is
            // not wrapped in the open-out button: that button would swallow
            // the tap meant for the player's own controls.
            BauInlineVideo(url: videoURL, name: media.name, postID: postID)
        } else if let target = media.openURL {
            Button { openURL(target) } label: { preview(target) }
                .buttonStyle(.plain)
        } else {
            Text("Media unavailable right now.")
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
        }
    }

    @ViewBuilder
    private func preview(_ target: URL) -> some View {
        if media.isImage {
            Group {
                if media.isGif {
                    AnimatedImageView(url: target, contentMode: .scaleAspectFill)
                } else {
                    AsyncImage(url: target) { phase in
                        switch phase {
                        case .success(let image): image.resizable().scaledToFill()
                        case .failure: placeholder(icon: "photo")
                        default: placeholder(icon: nil)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 220)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
            .accessibilityLabel(media.name.isEmpty ? Text("Image") : Text(media.name))
            .accessibilityIdentifier("bau.media.image")
        } else if media.isYoutube {
            ZStack {
                AsyncImage(url: YoutubeLinks.thumbnailURL(media.youtubeUrl)) { phase in
                    if case .success(let image) = phase {
                        image.resizable().scaledToFill()
                    } else {
                        Palette.surfaceRaised
                    }
                }
                PlayBadge(label: String(localized: "Watch on YouTube"))
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(16 / 9, contentMode: .fit)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
            .accessibilityLabel(Text("Watch on YouTube"))
            .accessibilityIdentifier("bau.media.youtube")
        } else if media.isTwitch {
            ZStack {
                Palette.surfaceRaised
                PlayBadge(label: String(localized: "Watch on Twitch"))
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(16 / 9, contentMode: .fit)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
            .accessibilityLabel(Text("Watch on Twitch"))
            .accessibilityIdentifier("bau.media.twitch")
        } else if media.isTiktok {
            ZStack {
                Palette.surfaceRaised
                PlayBadge(label: String(localized: "Watch on TikTok"))
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(9 / 16, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
            .accessibilityLabel(Text("Watch on TikTok"))
            .accessibilityIdentifier("bau.media.tiktok")
        } else if media.isInstagram {
            ZStack {
                Palette.surfaceRaised
                PlayBadge(label: String(localized: "Watch on Instagram"))
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(4 / 5, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
            .accessibilityLabel(Text("Watch on Instagram"))
            .accessibilityIdentifier("bau.media.instagram")
        } else {
            fileCard
        }
    }

    private func placeholder(icon: String?) -> some View {
        Palette.surfaceRaised.overlay {
            if let icon {
                Image(systemName: icon).foregroundStyle(Palette.paperMuted)
            } else {
                ProgressView().tint(Palette.paperMuted)
            }
        }
    }

    /// A PDF, or any other file: name, size, and a tap that opens it.
    private var fileCard: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.fill")
                .foregroundStyle(Palette.signal)
            VStack(alignment: .leading, spacing: 1) {
                Text(media.name.isEmpty ? String(localized: "File") : media.name)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                if let bytes = media.byteSize {
                    Text(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))
                        .font(.system(size: 10))
                        .foregroundStyle(Palette.paperMuted)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.down.circle")
                .foregroundStyle(Palette.paperMuted)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                .fill(Palette.surfaceRaised)
        )
        .accessibilityIdentifier("bau.media.file")
    }
}

/// A GIF posted from the picker: a body that is only an allowlisted URL.
/// Same size and clip as the chat transcript uses for the same thing.
private struct BauGif: View {
    let url: URL

    var body: some View {
        AnimatedImageView(url: url)
            .frame(maxWidth: 260, maxHeight: 260, alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
            .accessibilityLabel(Text("GIF"))
            .accessibilityIdentifier("bau.gif")
    }
}

private struct PlayBadge: View {
    let label: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "play.fill")
            Text(label).lineLimit(1)
        }
        .font(Typography.caption)
        .foregroundStyle(Palette.paper)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Capsule().fill(Color.black.opacity(0.6)))
    }
}

/// The two newest comments, "see all" for the rest, and a one-line composer.
///
/// A locked post carries a count and no words (the API strips the teaser
/// along with the body), so the block draws the composer and nothing else
/// there: a member without the cargo can still say something under a post
/// they cannot read, the same as on the web.
private struct CommentsBlock: View {
    let post: CommunityHomePost
    let expanded: [CommunityHomeComment]?
    let loadingComments: Bool
    let onLoadAll: () -> Void
    let onCollapse: () -> Void
    let onComment: (String) async -> Bool

    @State private var draft = ""
    @State private var submitting = false
    @State private var failed = false

    private var shown: [CommunityHomeComment] { expanded ?? post.commentTeaser }
    private var hidden: Int { max(0, post.commentCount - post.commentTeaser.count) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !shown.isEmpty {
                Rectangle().fill(Palette.border).frame(height: 1)
                ForEach(shown) { comment in
                    HStack(alignment: .top, spacing: 8) {
                        Avatar(name: comment.author.displayName, seed: comment.author.id, size: 24,
                               url: comment.author.avatarUrl)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(comment.author.displayName)
                                .font(Typography.caption)
                                .foregroundStyle(Palette.paper)
                                .lineLimit(1)
                            if let gifURL = comment.gifURL {
                                BauGif(url: gifURL)
                            } else {
                                Text(comment.body)
                                    .font(Typography.callout)
                                    .foregroundStyle(Palette.paper)
                            }
                        }
                    }
                }
            }

            if expanded != nil && hidden > 0 {
                Button("Show fewer", action: onCollapse)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.signal)
            } else if loadingComments {
                ProgressView().tint(Palette.paperMuted)
            } else if hidden > 0 && !post.locked {
                Button(action: onLoadAll) {
                    if post.commentCount == 1 {
                        Text("See \(post.commentCount) comment")
                    } else {
                        Text("See all \(post.commentCount) comments")
                    }
                }
                .font(Typography.caption)
                .foregroundStyle(Palette.signal)
                .accessibilityIdentifier("bau.comments.all")
            }

            if post.commentsEnabled {
                composer
            } else {
                Text("Comments are off on this post.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                TextField("Write a comment", text: $draft)
                    .textFieldStyle(.plain)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paper)
                    .submitLabel(.send)
                    .onSubmit { Task { await send() } }
                    .disabled(submitting)
                    .accessibilityIdentifier("bau.comment.input")
                Button {
                    Task { await send() }
                } label: {
                    Image(systemName: "paperplane.fill")
                        .foregroundStyle(canSend ? Palette.signal : Palette.paperMuted)
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel(Text("Comment"))
                .accessibilityIdentifier("bau.comment.send")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .fill(Palette.surfaceRaised)
            )

            if failed {
                Text("Could not post the comment.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.danger)
            }
        }
    }

    private var canSend: Bool {
        !submitting && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The box empties once the comment has actually landed, not on tap. A
    /// draft that vanished on a failed send is a sentence the person has to
    /// type again; keeping it and saying "did not post" costs nothing.
    private func send() async {
        guard canSend else { return }
        submitting = true
        failed = false
        let ok = await onComment(draft.trimmingCharacters(in: .whitespacesAndNewlines))
        if ok { draft = "" } else { failed = true }
        submitting = false
    }
}
