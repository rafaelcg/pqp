import SwiftUI

/// The communities directory — the whole screen, not a pane.
///
/// WHY IT TAKES THE SCREEN, on a phone as much as on the web. Browsing is a
/// different mode from talking, and a directory folded into a section of the hub
/// would be a list of strangers' rooms sitting under your own conversations.
/// It opens from a compass beside the Friends button — the two doors out of the
/// hub that lead to people you have not met yet — and covers everything while it
/// is up.
///
/// WHAT THIS IS NOT. Not a feed, no ranking model, no engagement machinery. The
/// research this is built on (`docs/research/communities-orkut.html` §02) found
/// 51 million Orkut communities against 120 million topics — about 2.35 topics
/// per community across the platform's whole life, which means the median
/// community never hosted a conversation at all. Joining WAS the product. So
/// this surface spends everything on the moment of the tap — a name, one line, a
/// count, a button — and nothing on making people talk once they are in.
///
/// NOTHING HERE IS REACHABLE UNLESS THE SERVER SAYS SO. The hub only offers the
/// compass once `/api/communities/config` answered `enabled`, and every route
/// behind this screen 404s with the flag off.
struct CommunitiesView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss

    /// Joined, or opened one already joined. The caller closes this screen and
    /// navigates; the directory does not own navigation, exactly as the profile
    /// sheet does not.
    let onEnter: (String) -> Void

    @State private var model = CommunitiesModel()
    @State private var reportTarget: ReportTarget?

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14, pinnedViews: []) {
                        hero
                        searchField
                        chipRow
                        results
                    }
                    .padding(.bottom, 28)
                }
                .scrollDismissesKeyboard(.immediately)
            }
            .navigationTitle("Communities")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                        .tint(Palette.paperMuted)
                        .accessibilityIdentifier("communities.done")
                }
            }
            .sheet(item: $reportTarget) { target in ReportSheet(target: target) }
        }
        .tint(Palette.signal)
        .task { await model.load(session: session) }
    }

    // MARK: - Chrome

    /// The one piece of persuasion on the screen, and it is two lines.
    ///
    /// A directory needs to say what it is before somebody scrolls a grid of
    /// rooms they have never heard of — but it is a header, not a landing page,
    /// so it scrolls away with everything else rather than pinning.
    private var hero: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "safari")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.signal)
                SectionLabel(text: String(localized: "Communities"))
            }
            Text("Find your people")
                .font(Typography.display(26))
                .foregroundStyle(Palette.paper)
            Text("Public rooms anyone can join. No invite, no queue.")
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Palette.signal.opacity(0.16), Palette.surface],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .strokeBorder(Palette.border, lineWidth: 1)
        )
        .padding(.horizontal, Metrics.hPadding)
        .padding(.top, 8)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Palette.paperMuted)
            TextField("Search by name…", text: $model.rawQuery)
                .textFieldStyle(.plain)
                .foregroundStyle(Palette.paper)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
                .accessibilityIdentifier("communities.search")
                .accessibilityLabel("Search communities")
                .onChange(of: model.rawQuery) { _, value in model.searchChanged(value) }
            if !model.rawQuery.isEmpty {
                Button {
                    model.rawQuery = ""
                    model.searchChanged("")
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Palette.paperMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .pqpSurface(cornerRadius: 22)
        .padding(.horizontal, Metrics.hPadding)
    }

    /// Ten categories and the sweep chip, in the shared constant's order.
    private var chipRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(CommunityFilter.chips) { chip in
                    let active = chip == model.filter
                    Button {
                        model.select(chip)
                    } label: {
                        HStack(spacing: 5) {
                            // Decorative: the label beside it is the accessible
                            // name, and "🎮 Games" announced in full is worse
                            // than "Games".
                            Text(chip.emoji).font(.system(size: 13))
                            Text(chip.label)
                                .font(Typography.caption)
                                .foregroundStyle(active ? Palette.inkDeep : Palette.paperSubtle)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Capsule().fill(active ? Palette.signal : Palette.surface))
                        .overlay(
                            Capsule().strokeBorder(
                                active ? Color.clear : Palette.border, lineWidth: 1
                            )
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("communities.chip.\(chip.id)")
                    .accessibilityLabel(chip.label)
                    .accessibilityAddTraits(active ? [.isSelected, .isButton] : .isButton)
                }
            }
            .padding(.horizontal, Metrics.hPadding)
        }
        .accessibilityIdentifier("communities.chips")
    }

    // MARK: - The grid

    @ViewBuilder
    private var results: some View {
        if let error = model.error {
            EmptyState(
                icon: "exclamationmark.triangle",
                title: "Could not load communities.",
                message: LocalizedStringKey(error),
                actionTitle: "Try again",
                action: { Task { await model.reload() } }
            )
            .padding(.top, 20)
        } else if model.isLoading && model.communities.isEmpty {
            // Card-shaped holes rather than a spinner, so the list does not jump
            // when the first page lands — which is the only thing a skeleton is
            // for.
            VStack(spacing: 12) {
                ForEach(0..<3, id: \.self) { _ in CommunityCardSkeleton() }
            }
            .padding(.horizontal, Metrics.hPadding)
        } else if model.communities.isEmpty {
            EmptyState(
                icon: "sparkles",
                title: "Nothing here yet",
                // A search that found nothing has advice worth giving: a
                // brand-new community is only reachable by exact name until
                // somebody else joins it. Browsing that found nothing has no
                // such story, and pretending it does would send people typing
                // names that do not exist.
                message: model.query.isEmpty
                    ? "New communities show up here once a couple of people are in them."
                    : "Nothing by that name. A brand-new one only turns up if you type it exactly."
            )
            .padding(.top, 20)
        } else {
            VStack(spacing: 12) {
                if let joinError = model.joinError {
                    Text(joinError)
                        .font(Typography.callout)
                        .foregroundStyle(Palette.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                ForEach(Array(model.communities.enumerated()), id: \.element.id) { index, community in
                    CommunityCard(
                        community: community,
                        joining: model.joiningId == community.id,
                        onEnter: { Task { await enter(community) } },
                        onReport: {
                            reportTarget = .community(
                                serverId: community.id, name: community.name
                            )
                        }
                    )
                    .animation(
                        Motion.standard.delay(Motion.stagger(index)),
                        value: model.communities.count
                    )
                }

                if model.hasMore {
                    Button {
                        Task { await model.loadMore() }
                    } label: {
                        Text(model.isLoadingMore ? "Loading…" : "Show more")
                            .font(Typography.bodyMedium)
                            .foregroundStyle(Palette.paper)
                            .frame(maxWidth: .infinity)
                            .frame(height: 46)
                            .pqpSurface()
                    }
                    .buttonStyle(.plain)
                    .disabled(model.isLoadingMore)
                    .accessibilityIdentifier("communities.loadMore")
                }
            }
            .padding(.horizontal, Metrics.hPadding)
        }
    }

    private func enter(_ community: CommunitySummary) async {
        guard await model.enter(community) else { return }
        onEnter(community.id)
        dismiss()
    }
}

// MARK: - Model

/// The directory's state, out of the view so the debounce and the paging are one
/// object rather than four `@State`s that have to agree.
@MainActor
@Observable
final class CommunitiesModel {
    var filter: CommunityFilter = .all
    /// What is in the box. `query` is what has been asked for.
    var rawQuery = ""
    private(set) var query = ""
    private(set) var communities: [CommunitySummary] = []
    private(set) var isLoading = true
    private(set) var isLoadingMore = false
    private(set) var hasMore = false
    private(set) var error: String?
    private(set) var joiningId: String?
    private(set) var joinError: String?

    private var session: SessionStore?
    private var searchTask: Task<Void, Never>?
    private var offset = 0

    func load(session: SessionStore) async {
        self.session = session
        await reload()
    }

    /// Debounced, for the reason the web file gives: firing per keystroke and
    /// cancelling is still one round trip per character on the server's side, and
    /// the directory search is a LIKE scan.
    func searchChanged(_ value: String) {
        searchTask?.cancel()
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(280))
            guard !Task.isCancelled, let self else { return }
            guard trimmed != self.query else { return }
            self.query = trimmed
            await self.reload()
        }
    }

    func select(_ chip: CommunityFilter) {
        guard chip != filter else { return }
        filter = chip
        Task { await reload() }
    }

    func reload() async {
        guard let session else { return }
        offset = 0
        isLoading = true
        error = nil
        joinError = nil
        do {
            let page = try await session.api.communities(
                category: filter.slug,
                query: query.isEmpty ? nil : query
            )
            communities = page.communities
            hasMore = page.hasMore
            offset = page.communities.count
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }

    func loadMore() async {
        guard let session, hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        guard let page = try? await session.api.communities(
            category: filter.slug,
            query: query.isEmpty ? nil : query,
            offset: offset
        ) else { return }
        // Deduped, because the order key is `member_count` and it moves under the
        // reader — an offset-paginated second request can hand back a row the
        // first already delivered.
        communities = CommunityDirectory.merge(communities, page.communities)
        hasMore = page.hasMore
        offset = communities.count
    }

    /// Join, or do nothing when already in. Answers whether the caller should
    /// navigate — a refusal (a ban, a listing pulled between the render and the
    /// tap) must leave the person on the directory with the server's sentence in
    /// front of them rather than pushing them into a room they cannot enter.
    func enter(_ community: CommunitySummary) async -> Bool {
        guard let session else { return false }
        if community.joined { return true }
        joiningId = community.id
        joinError = nil
        defer { joiningId = nil }
        do {
            _ = try await session.api.joinCommunity(serverId: community.id)
            communities = CommunityDirectory.applyJoin(communities, serverId: community.id)
            return true
        } catch {
            // Verbatim. "You are banned from this community" and "not found" are
            // the server's two answers and both are its wording to give.
            joinError = (error as? APIError)?.errorDescription ?? error.localizedDescription
            return false
        }
    }
}

// MARK: - Card

/// One community, as a card.
///
/// THE TINT IS NOT DECORATION. A list of cards that differ only in a line of
/// text is a wall, and somebody scanning it has nothing to aim at; a stable
/// per-community hue gives every card a shape you can come back to. It is the
/// fallback for the ones with no picture rather than the design — a community
/// with a banner gets its banner, and a community with an icon gets its icon.
struct CommunityCard: View {
    let community: CommunitySummary
    let joining: Bool
    let onEnter: () -> Void
    let onReport: () -> Void

    private var hue: Double { CommunityDirectory.hue(community.id) }
    private var action: CommunityDirectory.CardAction {
        CommunityDirectory.cardAction(community)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            HStack(alignment: .center, spacing: 12) {
                icon
                    // Overlaps the strip above, which is what makes the card
                    // read as one object rather than a picture with a list under
                    // it. Offset rather than negative padding so the row keeps
                    // its own height.
                    .offset(y: -22)

                VStack(alignment: .leading, spacing: 3) {
                    Text(community.name)
                        .font(Typography.bodyMedium)
                        .foregroundStyle(Palette.paper)
                        .lineLimit(1)
                        // ON THE NAME, NOT ON THE CARD. An identifier applied to
                        // a container propagates down and OVERWRITES every
                        // child's own — which made the join button
                        // unaddressable and every element in the card answer to
                        // the card's id.
                        .accessibilityIdentifier("communities.card.\(community.id)")
                    HStack(spacing: 5) {
                        Image(systemName: "person.2.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(Palette.paperMuted)
                        Text(memberLine)
                            .font(Typography.caption)
                            .monospacedDigit()
                            .foregroundStyle(Palette.paperMuted)
                    }
                }

                Spacer(minLength: 8)

                joinButton
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)

            if let tagline = community.tagline, !tagline.isEmpty {
                // Two lines rather than one: a tagline is the joke, and half a
                // joke is worse than none.
                Text(tagline)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.top, 2)
            }

            if community.joined {
                // Stated as well as implied. The button already reads "Open",
                // but that is one word's difference between two cards side by
                // side; the pill is what survives a glance.
                HStack(spacing: 5) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 11))
                    Text("You're in")
                        .font(Typography.caption)
                }
                .foregroundStyle(Palette.success)
                .padding(.horizontal, 14)
                .padding(.top, 8)
            }

            Color.clear.frame(height: 14)
        }
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .fill(Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .strokeBorder(Palette.border, lineWidth: 1)
        )
        .clipShape(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
        )
    }

    /// The banner strip, or the generated tint where there is none.
    ///
    /// THE PICTURE IS FRAMED AND CLIPPED BEFORE ANYTHING IS DRAWN ON IT. A
    /// `scaledToFill` image inside a ZStack grows the *stack*, not just itself —
    /// so a 1024×360 banner laid out beside the category chip pushed that chip
    /// hundreds of points above the 78pt window and clipping took it away
    /// entirely. Everything that sits on top is an `overlay` applied after the
    /// frame, which measures against the strip rather than against the picture.
    private var header: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(hue: hue, saturation: 0.5, brightness: 0.52),
                    Color(hue: (hue + 0.13).truncatingRemainder(dividingBy: 1),
                          saturation: 0.36, brightness: 0.3),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            if let url = Avatar.resolve(community.bannerUrl) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    // The tint underneath is the placeholder; a spinner over a
                    // gradient would be a card that flickers while it loads.
                    Color.clear
                }
            }
        }
        .frame(height: 78)
        .clipped()
        // Fades the strip into the card body so the icon below has something to
        // sit against instead of a hard seam.
        .overlay(alignment: .bottom) {
            LinearGradient(
                colors: [Palette.surface.opacity(0), Palette.surface],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 28)
            .allowsHitTesting(false)
        }
        .overlay(alignment: .top) {
            HStack {
                HStack(spacing: 4) {
                    Text(community.category.emoji).font(.system(size: 11))
                    Text(community.category.label)
                        .font(Typography.label)
                        .foregroundStyle(Palette.paper)
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(Capsule().fill(.black.opacity(0.42)))

                Spacer()

                // A moderation affordance that only exists behind a long-press
                // is not one. Drawn permanently, quietly, at the far corner.
                Button(action: onReport) {
                    Image(systemName: "flag")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Palette.paperMuted)
                        .padding(6)
                        .background(Circle().fill(.black.opacity(0.42)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Report this community")
            }
            .padding(10)
        }
    }

    private var icon: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color(hue: hue, saturation: 0.6, brightness: 0.8),
                            Color(hue: hue, saturation: 0.55, brightness: 0.6),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            Text(CommunityDirectory.monogram(community.name))
                .font(.system(size: 19, weight: .bold, design: .rounded))
                .foregroundStyle(Palette.inkDeep)

            if let url = Avatar.resolve(community.iconUrl) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    // The monogram underneath is the placeholder, exactly as it
                    // is for a person's avatar.
                    Color.clear
                }
                .frame(width: 54, height: 54)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
        .frame(width: 54, height: 54)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Palette.surface, lineWidth: 3)
        )
    }

    private var joinButton: some View {
        Button(action: onEnter) {
            Group {
                if joining {
                    ProgressView().tint(Palette.inkDeep)
                } else {
                    Text(action == .open ? "Open" : "Join")
                        .font(Typography.caption)
                }
            }
            .foregroundStyle(action == .open ? Palette.paper : Palette.inkDeep)
            .frame(minWidth: 68)
            .frame(height: 34)
            .background(
                Capsule().fill(action == .open ? Palette.surfaceRaised : Palette.signal)
            )
        }
        .buttonStyle(.plain)
        .disabled(joining)
        .accessibilityIdentifier("communities.join.\(community.id)")
    }

    private var memberLine: String {
        let formatted = CommunityDirectory.memberCount(community.memberCount)
        return community.memberCount == 1
            ? String(localized: "1 member")
            : String(localized: "\(formatted) members")
    }
}

/// A card-shaped hole. Matches the real card's geometry — strip, overlapping
/// icon, two lines, a button — so the list does not jump when the data lands.
struct CommunityCardSkeleton: View {
    @State private var shimmer = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle()
                .fill(Palette.surfaceRaised)
                .frame(height: 78)
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Palette.surfaceRaised)
                    .frame(width: 54, height: 54)
                    .offset(y: -22)
                VStack(alignment: .leading, spacing: 6) {
                    Capsule().fill(Palette.surfaceRaised).frame(width: 120, height: 11)
                    Capsule().fill(Palette.surfaceRaised).frame(width: 70, height: 9)
                }
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            Capsule()
                .fill(Palette.surfaceRaised)
                .frame(height: 9)
                .padding(.horizontal, 14)
                .padding(.top, 4)
            Color.clear.frame(height: 16)
        }
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .fill(Palette.surface)
        )
        .clipShape(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
        )
        .opacity(shimmer ? 0.55 : 0.9)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                shimmer = true
            }
        }
        .accessibilityHidden(true)
    }
}
