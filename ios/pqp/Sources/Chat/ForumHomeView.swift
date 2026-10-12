import SwiftUI

/// A post to push, with what the list already knows about it.
struct ForumPostRoute: Hashable, Identifiable {
    let id: String
    var summary: ForumPostSummary?
}

/// A forum on a phone (UX §2.9, mock 07): the whole screen is the list. The
/// rules collapse to one row that opens a sheet, every filter lives on one
/// strip that scrolls sideways, pinned posts sit on top, and "Novo post" is a
/// floating button in thumb reach that steps aside while the list scrolls
/// down.
struct ForumHomeView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var model: ForumHomeModel
    /// A post named by a link or a push, opened on top once.
    private let initialPostId: String?
    @State private var hasOpenedInitialPost = false

    @State private var openedPost: ForumPostRoute?
    @State private var composing = false
    @State private var composerSeedTitle = ""
    @State private var showingRules = false
    @State private var searching = false
    @State private var searchText = ""
    @FocusState private var searchFocused: Bool
    @State private var fabVisible = true
    @State private var lastOffset: CGFloat = 0

    private static let scrollSpace = "forum.scroll"
    private static let topAnchor = "forum.top"

    init(forum: Channel, server: Server, initialPostId: String? = nil) {
        _model = State(initialValue: ForumHomeModel(forum: forum, server: server))
        self.initialPostId = initialPostId
    }

    private var forum: Channel { model.forum }

    private var rules: String? {
        guard let topic = forum.topic?.trimmingCharacters(in: .whitespacesAndNewlines), !topic.isEmpty
        else { return nil }
        return topic
    }

    /// No posts at all and nothing narrowing: the empty forum, which hides
    /// the filters (filters on nothing are noise).
    private var isEmptyForum: Bool {
        model.phase == .ready && model.state.isEmpty && !model.filters.isNarrowing
    }

    var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottomTrailing) {
                Palette.ink.ignoresSafeArea()
                list(proxy)
                if model.canPost && fabVisible && !searching && !isEmptyForum {
                    newPostButton
                        .padding(.trailing, Metrics.hPadding)
                        .padding(.bottom, 12)
                        .transition(reduceMotion
                                    ? .opacity
                                    : .move(edge: .bottom).combined(with: .opacity))
                }
            }
            .overlay(alignment: .top) {
                if model.queuedCount > 0 {
                    livePill {
                        model.flush()
                        withAnimation(.channelList(reduceMotion: reduceMotion)) {
                            proxy.scrollTo(Self.topAnchor, anchor: .top)
                        }
                    }
                    .padding(.top, 8)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.channelList(reduceMotion: reduceMotion), value: model.queuedCount > 0)
            .animation(.channelList(reduceMotion: reduceMotion), value: fabVisible)
        }
        .navigationTitle(forum.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Palette.ink, for: .navigationBar)
        .toolbar { toolbar }
        .sheet(isPresented: $showingRules) { rulesSheet }
        .sheet(isPresented: $composing) {
            ForumComposerView(
                home: model,
                seedTitle: composerSeedTitle,
                onPublished: { post, viewer in
                    composing = false
                    model.published(post, viewer: viewer)
                    // The new post opens, the way the web does it.
                    openedPost = ForumPostRoute(id: post.id, summary: post)
                },
                onOpenSimilar: { post in
                    // The draft is saved; reopening "Novo post" restores it.
                    composing = false
                    openedPost = ForumPostRoute(id: post.id, summary: post)
                }
            )
        }
        .navigationDestination(item: $openedPost) { route in
            ForumPostScreen(
                model: ForumPostModel(
                    postId: route.id,
                    forumId: forum.id,
                    forumName: forum.name,
                    serverId: model.server.id,
                    initialPost: route.summary ?? model.state.post(id: route.id),
                    initialViewer: model.viewer(for: route.id),
                    home: model
                ),
                server: model.server
            )
        }
        .task(id: searchText) {
            // Debounced: a title search costs a query per keystroke otherwise.
            guard searching || !model.filters.query.isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            var next = model.filters
            next.query = searchText
            model.setFilters(next)
        }
        .task {
            await model.start(session: session)
            openInitialPostIfAsked()
        }
        // Back from a post: the button is where the thumb left it.
        .onAppear { fabVisible = true }
    }

    private func openInitialPostIfAsked() {
        guard let initialPostId, !hasOpenedInitialPost else { return }
        hasOpenedInitialPost = true
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            openedPost = ForumPostRoute(id: initialPostId, summary: model.state.post(id: initialPostId))
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            if searching {
                searchField
            } else {
                VStack(spacing: 0) {
                    HStack(spacing: 5) {
                        Image(systemName: "bubble.left.and.bubble.right")
                            .font(.system(size: 12, weight: .semibold))
                        Text(verbatim: forum.name)
                            .font(.system(size: 16, weight: .semibold))
                            .lineLimit(1)
                    }
                    .foregroundStyle(Palette.paper)
                    Text(verbatim: subtitle)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Palette.paperMuted)
                        .lineLimit(1)
                }
                .accessibilityElement(children: .combine)
            }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if searching {
                Button("Cancel") { endSearch() }
                    .tint(Palette.paperMuted)
            } else {
                Button {
                    withAnimation(Motion.standard) { searching = true }
                    searchFocused = true
                } label: {
                    Image(systemName: "magnifyingglass")
                }
                .tint(Palette.paper)
                .accessibilityLabel(Text("Search titles"))
                .accessibilityIdentifier("forum.search")
                notificationMenu
            }
        }
    }

    /// "Bugados · 142 posts".
    private var subtitle: String {
        guard let counts = model.state.counts else { return model.server.name }
        return "\(model.server.name) · \(ForumCopy.posts(counts.posts))"
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13))
                .foregroundStyle(Palette.paperMuted)
            TextField("Search titles", text: $searchText)
                .font(.system(size: 16))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($searchFocused)
                .accessibilityIdentifier("forum.searchField")
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Palette.paperMuted)
                }
                .accessibilityLabel(Text("Clear"))
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 36)
        .frame(minWidth: 240)
        .background(Capsule().fill(Palette.surfaceRaised))
    }

    private func endSearch() {
        searchFocused = false
        searchText = ""
        withAnimation(Motion.standard) { searching = false }
        if !model.filters.query.isEmpty {
            var next = model.filters
            next.query = ""
            model.setFilters(next)
        }
    }

    /// The forum's own notification level (the web's per-channel setting).
    private var notificationLevel: String? {
        session.preferences.notifications?.channels?[forum.id]
    }

    private var notificationMenu: some View {
        Menu {
            Picker("Notifications", selection: Binding(
                get: { notificationLevel ?? "default" },
                set: { level in Task { await setNotificationLevel(level) } }
            )) {
                Text("Server default").tag("default")
                Text("All messages").tag("all")
                Text("Only @mentions").tag("mentions")
                Text("Nothing").tag("none")
            }
        } label: {
            Image(systemName: notificationLevel == "none" ? "bell.slash" : "bell")
        }
        .tint(Palette.paper)
        .accessibilityLabel(Text("Notifications"))
    }

    private func setNotificationLevel(_ level: String) async {
        var preferences = session.preferences
        var notifications = preferences.notifications ?? NotificationPreferences()
        var channels = notifications.channels ?? [:]
        if level == "default" {
            channels.removeValue(forKey: forum.id)
        } else {
            channels[forum.id] = level
        }
        notifications.channels = channels
        preferences.notifications = notifications
        _ = try? await session.savePreferences(preferences)
    }

    // MARK: - List

    private func list(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                Color.clear
                    .frame(height: 1)
                    .id(Self.topAnchor)

                if let rules {
                    rulesRow(rules)
                }

                if !isEmptyForum {
                    filterStrip
                        .padding(.horizontal, -Metrics.hPadding)
                }

                if model.phase == .ready && !model.canPost && !isEmptyForum {
                    pausedLine
                }

                content
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.top, 6)
            // Room for the floating button over the last card.
            .padding(.bottom, 96)
            .opacity(model.isRefreshing ? 0.55 : 1)
            .animation(.easeOut(duration: 0.15), value: model.isRefreshing)
            // Measured on the stack itself, not on a row inside it: a lazy row
            // that scrolls out of the window stops reporting, and the reader's
            // place has to be known however far down they are.
            .onGeometryChange(for: CGFloat.self) { geometry in
                geometry.frame(in: .named(Self.scrollSpace)).minY
            } action: { offset in
                track(offset: offset)
            }
        }
        .coordinateSpace(name: Self.scrollSpace)
        .scrollDismissesKeyboard(.immediately)
        .refreshable { await model.load() }
        // On the list, not the screen: an identifier on a container is
        // handed down to the children that carry none, and it was taking
        // the floating button's and the pill's.
        .accessibilityIdentifier("forum.home")
    }

    /// The reader's place: at the top (the queue may apply in place), and
    /// which way they are moving (the button steps aside going down).
    private func track(offset: CGFloat) {
        let atTop = offset > -24
        if model.isAtTop != atTop { model.isAtTop = atTop }
        let delta = offset - lastOffset
        if atTop {
            if !fabVisible { fabVisible = true }
        } else if delta < -12 {
            if fabVisible { fabVisible = false }
        } else if delta > 12 {
            if !fabVisible { fabVisible = true }
        }
        if abs(delta) > 12 || atTop { lastOffset = offset }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            ForEach(0..<3, id: \.self) { _ in ForumCardSkeleton() }
        case .failed(let message):
            loadError(message)
        case .ready:
            if isEmptyForum {
                emptyForum
            } else {
                posts
            }
        }
    }

    @ViewBuilder
    private var posts: some View {
        let state = model.state
        if !state.pinned.isEmpty {
            HStack(spacing: 6) {
                Image(systemName: "pin")
                    .font(.system(size: 10, weight: .semibold))
                Text("PINNED")
                    .font(Typography.label)
                    .tracking(1.2)
                Rectangle().fill(Palette.border).frame(height: 1)
            }
            .foregroundStyle(Palette.paperMuted)
            .padding(.top, 4)

            ForEach(state.pinned) { post in
                Button {
                    open(post)
                } label: {
                    ForumPinnedRow(post: post, unread: model.unreadState(for: post))
                }
                .buttonStyle(ForumCardButtonStyle())
                .accessibilityIdentifier("forum.pinned.\(post.id)")
            }
            .padding(.bottom, 2)
        }

        ForEach(Array(state.posts.enumerated()), id: \.element.id) { index, post in
            Button {
                open(post)
            } label: {
                ForumPostCard(
                    post: post,
                    unread: model.unreadState(for: post),
                    tags: post.tagIds.compactMap { model.tag(id: $0) }
                )
            }
            .buttonStyle(ForumCardButtonStyle())
            .accessibilityIdentifier("forum.card.\(post.id)")
            .transition(reduceMotion ? .opacity : .asymmetric(
                insertion: .move(edge: .top).combined(with: .opacity),
                removal: .opacity
            ))
            .onAppear {
                // 600 pt before the end, roughly five cards.
                if index >= state.posts.count - 5 {
                    Task { await model.loadMore() }
                }
            }
        }
        .animation(.channelList(reduceMotion: reduceMotion), value: state.posts.map(\.id))

        if state.posts.isEmpty {
            filteredEmpty
        } else {
            footer
        }
    }

    private func open(_ post: ForumPostSummary) {
        openedPost = ForumPostRoute(id: post.id, summary: post)
    }

    @ViewBuilder
    private var footer: some View {
        if model.isLoadingMore {
            ProgressView()
                .tint(Palette.paperMuted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
        } else if model.loadMoreFailed {
            Button {
                Task { await model.loadMore() }
            } label: {
                VStack(spacing: 4) {
                    Text("Couldn't load posts.")
                        .foregroundStyle(Palette.paperMuted)
                    Text("Try again")
                        .foregroundStyle(Palette.signal)
                        .fontWeight(.semibold)
                }
                .font(Typography.callout)
                .frame(maxWidth: .infinity, minHeight: 56)
            }
            .buttonStyle(.plain)
        } else if model.state.nextCursor == nil {
            Text(verbatim: ForumCopy.end(model.state.counts?.posts ?? (model.state.posts.count + model.state.pinned.count)))
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
        }
    }

    // MARK: - Rules, strip, states

    private func rulesRow(_ rules: String) -> some View {
        Button {
            showingRules = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "book")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.signal)
                    .frame(width: 28, height: 28)
                    .background(Palette.signal.opacity(0.14), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                Text("Forum guidelines")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Palette.paper)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Palette.paperMuted)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 52)
            .pqpSurface()
        }
        .buttonStyle(ForumCardButtonStyle())
        .accessibilityIdentifier("forum.rules")
    }

    private var rulesSheet: some View {
        NavigationStack {
            ScrollView {
                Text(verbatim: rules ?? "")
                    .font(Typography.body)
                    .foregroundStyle(Palette.paperSubtle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Metrics.hPadding)
                    .textSelection(.enabled)
            }
            .background(Palette.ink.ignoresSafeArea())
            .navigationTitle("Forum guidelines")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingRules = false }.tint(Palette.signal)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Palette.ink)
    }

    /// Every filter on one strip: sort, the two statuses, mine, then the
    /// tags, active ones first.
    private var filterStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                sortChip

                ForumFilterChip(
                    title: Text("forum.filter.open"),
                    isActive: model.filters.status == .open
                ) {
                    var next = model.filters
                    next.status = next.status == .open ? nil : .open
                    model.setFilters(next)
                }
                .accessibilityIdentifier("forum.filter.open")

                ForumFilterChip(
                    title: Text("forum.filter.resolved"),
                    isActive: model.filters.status == .resolved
                ) {
                    var next = model.filters
                    next.status = next.status == .resolved ? nil : .resolved
                    model.setFilters(next)
                }
                .accessibilityIdentifier("forum.filter.resolved")

                ForumFilterChip(title: Text("My posts"), isActive: model.filters.mine) {
                    var next = model.filters
                    next.mine.toggle()
                    model.setFilters(next)
                }
                .accessibilityIdentifier("forum.filter.mine")

                ForEach(orderedTags) { tag in
                    ForumFilterChip(
                        title: Text(verbatim: tag.name),
                        emoji: tag.emoji,
                        isActive: model.filters.tagIds.contains(tag.id)
                    ) {
                        model.toggleTag(tag.id)
                    }
                    .accessibilityIdentifier("forum.filter.tag.\(tag.name)")
                }
            }
            .padding(.horizontal, Metrics.hPadding)
            .animation(.channelList(reduceMotion: reduceMotion), value: model.filters)
        }
    }

    /// Active tags first, the rest in the order staff set.
    private var orderedTags: [ForumTag] {
        let active = model.filters.tagIds
        return model.tags.filter { active.contains($0.id) } + model.tags.filter { !active.contains($0.id) }
    }

    private var sortChip: some View {
        Menu {
            Picker("Sort", selection: Binding(
                get: { model.filters.sort },
                set: { sort in
                    var next = model.filters
                    next.sort = sort
                    model.setFilters(next)
                }
            )) {
                Label("Recent activity", systemImage: "clock.arrow.circlepath").tag(ForumSort.activity)
                Label("Newest", systemImage: "sparkles").tag(ForumSort.created)
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "arrow.up.arrow.down")
                    .font(.system(size: 11, weight: .semibold))
                Text(model.filters.sort == .activity ? "Activity" : "Newest")
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
            }
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Palette.paperSubtle)
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(Capsule().strokeBorder(Palette.border, lineWidth: 1))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(Text("Sort"))
        .accessibilityValue(model.filters.sort == .activity ? Text("Recent activity") : Text("Newest"))
        .accessibilityIdentifier("forum.sort")
    }

    private var pausedLine: some View {
        HStack(spacing: 8) {
            Image(systemName: "pause.circle")
            Text("New posts are paused in this forum.")
            Spacer(minLength: 0)
        }
        .font(Typography.callout)
        .foregroundStyle(Palette.paperMuted)
        .padding(.vertical, 4)
    }

    private var newPostButton: some View {
        Button {
            composerSeedTitle = ""
            composing = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "plus")
                    .font(.system(size: 17, weight: .bold))
                Text("New post")
                    .font(.system(size: 17, weight: .semibold))
            }
            .foregroundStyle(Palette.inkDeep)
            .padding(.horizontal, 20)
            .frame(height: 54)
            .background(Capsule().fill(Palette.signal))
            .shadow(color: .black.opacity(0.4), radius: 14, y: 6)
        }
        .buttonStyle(ForumCardButtonStyle())
        .accessibilityIdentifier("forum.newPost")
    }

    private func livePill(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 12, weight: .bold))
                Text(verbatim: ForumCopy.live(model.queuedCount))
                Text(verbatim: "·")
                Text("Refresh").fontWeight(.bold)
            }
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Palette.inkDeep)
            .padding(.horizontal, 16)
            .frame(height: 38)
            .background(Capsule().fill(Palette.signal))
            .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("forum.livePill")
    }

    private var emptyForum: some View {
        EmptyState(
            icon: "bubble.left.and.bubble.right",
            title: "Nobody has posted here yet",
            message: "Start the first post and get things going.",
            actionTitle: model.canPost ? "Create the first post" : nil,
            action: model.canPost ? {
                composerSeedTitle = ""
                composing = true
            } : nil
        )
        .padding(.top, 24)
    }

    @ViewBuilder
    private var filteredEmpty: some View {
        let query = model.filters.trimmedQuery
        VStack(spacing: 12) {
            if !query.isEmpty {
                Text("No titles match \"\(query)\"")
                    .font(Typography.title(18))
                    .foregroundStyle(Palette.paper)
                    .multilineTextAlignment(.center)
                Text("This might be the first time anyone asks.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
                    .multilineTextAlignment(.center)
                if model.canPost {
                    Button("Post \"\(query)\"") {
                        composerSeedTitle = query
                        composing = true
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .frame(maxWidth: 260)
                }
            } else if model.filters.mine && model.filters.status == nil && model.filters.tagIds.isEmpty {
                Text("Nothing in My posts yet.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
            } else {
                Text("No posts match these filters")
                    .font(Typography.title(18))
                    .foregroundStyle(Palette.paper)
                    .multilineTextAlignment(.center)
                Button("Clear filters") { model.clearFilters() }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.signal)
                    .frame(minHeight: 44)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
    }

    private func loadError(_ message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 22))
                .foregroundStyle(Palette.warning)
            Text("Couldn't load posts.")
                .font(Typography.bodyMedium)
                .foregroundStyle(Palette.paper)
            Text(verbatim: message)
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
                .multilineTextAlignment(.center)
            Button("Try again") { Task { await model.load() } }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.signal)
                .frame(minHeight: 44)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
    }
}

/// A filter that toggles. 34 pt drawn, 44 pt to the touch. Active is lime
/// with an X, so "why is my list short" answers itself.
struct ForumFilterChip: View {
    let title: Text
    var emoji: String?
    let isActive: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let emoji, !emoji.isEmpty {
                    Text(verbatim: emoji).font(.system(size: 13))
                }
                title
                if isActive {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                }
            }
            .font(.system(size: 14, weight: isActive ? .semibold : .medium))
            .foregroundStyle(isActive ? Palette.signal : Palette.paperSubtle)
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(Capsule().fill(isActive ? Palette.signal.opacity(0.16) : .clear))
            .overlay(Capsule().strokeBorder(isActive ? Palette.signal.opacity(0.6) : Palette.border, lineWidth: 1))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isActive ? [.isSelected] : [])
    }
}

/// The first-load placeholder, in the card's own shape.
struct ForumCardSkeleton: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            bar(width: 240, height: 15)
            bar(width: 290, height: 12)
            bar(width: 180, height: 12)
            HStack {
                bar(width: 64, height: 18)
                Spacer()
                bar(width: 70, height: 12)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .pqpSurface()
        .opacity(dim ? 0.55 : 1)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
        }
        .accessibilityHidden(true)
    }

    private func bar(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
            .fill(Palette.surfaceRaised)
            .frame(maxWidth: width, minHeight: height, maxHeight: height)
    }
}
