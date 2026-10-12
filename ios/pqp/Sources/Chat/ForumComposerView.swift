import PhotosUI
import SwiftUI

/// A draft, saved per forum on this device as it is typed (UX §2.5 #36):
/// closing never asks, "Descartar" clears, reopening restores.
struct ForumDraft: Codable, Equatable {
    var title = ""
    var body = ""
    var tagIds: [String] = []

    var isEmpty: Bool {
        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && tagIds.isEmpty
    }
}

struct ForumDraftStore {
    private let defaults: UserDefaults

    init(accountId: String, defaults: UserDefaults = .standard) {
        self.accountId = accountId
        self.defaults = defaults
    }

    /// Per account AND forum: a phone signed into a second account must not
    /// show the first one's unpublished words.
    let accountId: String

    private func key(_ forumId: String) -> String { "pqp.forum.draft.\(accountId).\(forumId)" }

    func load(forumId: String) -> ForumDraft? {
        guard let data = defaults.data(forKey: key(forumId)),
              let draft = try? JSONDecoder().decode(ForumDraft.self, from: data),
              !draft.isEmpty else { return nil }
        return draft
    }

    func save(_ draft: ForumDraft, forumId: String) {
        if draft.isEmpty {
            defaults.removeObject(forKey: key(forumId))
        } else if let data = try? JSONEncoder().encode(draft) {
            defaults.set(data, forKey: key(forumId))
        }
    }

    func clear(forumId: String) {
        defaults.removeObject(forKey: key(forumId))
    }
}

/// What the composer says about a refusal, by field.
struct ForumComposerRefusal: Equatable {
    enum Field: Equatable { case title, tags, general }
    let field: Field
    let message: String
    /// Slow mode: the button counts this down.
    var retryUntil: Date?
    /// The line is re-said with the seconds left while it counts.
    var isSlowMode = false

    @MainActor
    static func from(_ error: ForumCreateError, now: Date = Date()) -> ForumComposerRefusal {
        switch error {
        case .rejected(let rejection):
            let wait = rejection.retryAfterMs.map { Double($0) / 1000 }
            switch rejection.reason {
            case "slow-mode":
                let seconds = Int((wait ?? 0).rounded(.up))
                return ForumComposerRefusal(
                    field: .general,
                    message: String(localized: "Slow mode. Wait \(seconds)s to post again."),
                    retryUntil: wait.map { now.addingTimeInterval($0) },
                    isSlowMode: true
                )
            case "rate-limited":
                let minutes = max(1, Int(((wait ?? 60) / 60).rounded(.up)))
                return ForumComposerRefusal(
                    field: .general,
                    message: String(localized: "Too many posts in a short time. Try again in \(minutes) min."),
                    retryUntil: wait.map { now.addingTimeInterval($0) }
                )
            case "automod":
                // Which half AutoMod refused, so the line says "esse título"
                // and the title field is the one that lights up.
                let lead: String
                switch rejection.field {
                case "title": lead = String(localized: "AutoMod blocked this title.")
                case "body": lead = String(localized: "AutoMod blocked this text.")
                default: lead = String(localized: "AutoMod blocked this post.")
                }
                return ForumComposerRefusal(
                    field: rejection.field == "title" ? .title : .general,
                    message: [lead, rejection.automodMessage].compactMap { $0 }.joined(separator: " ")
                )
            case "locked":
                return ForumComposerRefusal(field: .general, message: ChatModel.rejectionCopy(for: "locked"))
            default:
                return ForumComposerRefusal(
                    field: .general,
                    message: ChatModel.rejectionCopy(for: rejection.reason ?? "")
                )
            }
        case .refused(_, let token):
            switch token {
            case ForumErrorCode.tagRequired:
                return ForumComposerRefusal(field: .tags, message: String(localized: "Pick at least one tag."))
            case ForumErrorCode.tagModerated:
                return ForumComposerRefusal(field: .tags, message: String(localized: "Only staff can add this tag."))
            case ForumErrorCode.off:
                return ForumComposerRefusal(field: .general, message: String(localized: "New posts are paused in this forum."))
            default:
                return ForumComposerRefusal(
                    field: .general,
                    message: String(localized: "Couldn't post. The draft is still here, try again.")
                )
            }
        case .transport:
            return ForumComposerRefusal(
                field: .general,
                message: String(localized: "Couldn't post. The draft is still here, try again.")
            )
        }
    }
}

/// "Posts parecidos": the matched words of a title, underlined.
enum ForumSimilar {
    static func highlighted(_ title: String, query: String) -> AttributedString {
        var result = AttributedString(title)
        let words = Set(ForumList.fold(query).split(whereSeparator: \.isWhitespace).map(String.init))
            .filter { $0.count >= 2 }
        guard !words.isEmpty else { return result }
        var searchStart = title.startIndex
        // Walk the title word by word and mark every word that folds to one
        // the person typed.
        let pattern = title.split(whereSeparator: { $0.isWhitespace || $0.isPunctuation })
        for token in pattern {
            guard let range = title.range(of: token, range: searchStart..<title.endIndex) else { continue }
            searchStart = range.upperBound
            let folded = ForumList.fold(String(token))
            guard words.contains(where: { folded.hasPrefix($0) || $0.hasPrefix(folded) && folded.count >= 3 }),
                  let attributed = Range(range, in: result) else { continue }
            result[attributed].underlineStyle = .single
            result[attributed].inlinePresentationIntent = .stronglyEmphasized
        }
        return result
    }
}

/// A new post, as a full sheet (UX §2.5): Título with its counter, the posts
/// that look like it, the details, the tags. Publishing is not optimistic.
struct ForumComposerView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let home: ForumHomeModel
    var seedTitle: String = ""
    var onPublished: (ForumPostSummary, ForumPostViewer?) -> Void
    /// A similar post was picked: close and open it (the draft stays saved).
    var onOpenSimilar: ((ForumPostSummary) -> Void)? = nil

    @State private var draft = ForumDraft()
    @State private var restored = false
    @State private var hasLoadedDraft = false
    @State private var similar: [ForumPostSummary] = []
    @State private var similarQuery = ""
    @State private var similarLoading = false
    @State private var attachments: [PendingAttachment] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var attachmentsEnabled = false
    @State private var publishing = false
    @State private var refusal: ForumComposerRefusal?
    @State private var triedPublish = false
    @State private var now = Date()
    /// One per attempt, reused on a retry of the same draft AND the same
    /// files, so a lost answer never makes two posts and a changed attempt is
    /// never answered with the old one.
    @State private var nonce = UUID().uuidString
    @State private var nonceDraft: ForumDraft?
    @State private var nonceFiles: [UUID] = []
    @FocusState private var focus: Field?

    private enum Field: Hashable { case title, body }

    private var forumId: String { home.forum.id }
    private var drafts: ForumDraftStore { ForumDraftStore(accountId: session.currentUser?.id ?? "anon") }
    private var trimmedTitle: String { draft.title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var needsTag: Bool { home.settings.requireTag && draft.tagIds.isEmpty }
    private var hasBody: Bool {
        !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    private var holdRemaining: Int {
        guard let until = refusal?.retryUntil else { return 0 }
        return max(0, Int(until.timeIntervalSince(now).rounded(.up)))
    }

    private var canPublish: Bool {
        !trimmedTitle.isEmpty && !needsTag && hasBody && !publishing && holdRemaining == 0 && home.canPost
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if !home.canPost {
                        notice(String(localized: "New posts are paused in this forum."), icon: "pause.circle")
                    }
                    titleField
                    if !similar.isEmpty {
                        similarBox
                            .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                    }
                    tagsField
                    bodyField
                    if let refusal, refusal.field == .general {
                        notice(holdRemaining > 0 && refusal.retryUntil != nil
                               ? liveHoldMessage(refusal)
                               : refusal.message,
                               icon: "exclamationmark.triangle.fill", tint: Palette.danger)
                            .accessibilityIdentifier("forum.composer.error")
                    }
                    footer
                }
                .padding(Metrics.hPadding)
                .animation(.channelList(reduceMotion: reduceMotion), value: similar.map(\.id))
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Palette.ink.ignoresSafeArea())
            .navigationTitle("New post")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.ink, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .tint(Palette.paper)
                    .accessibilityLabel(Text("Close"))
                    .accessibilityIdentifier("forum.composer.close")
                }
                ToolbarItem(placement: .confirmationAction) {
                    publishButton
                }
            }
        }
        .presentationBackground(Palette.ink)
        .interactiveDismissDisabled(publishing)
        .onAppear(perform: loadDraft)
        .onChange(of: draft) { _, next in
            guard hasLoadedDraft else { return }
            drafts.save(next, forumId: forumId)
            if refusal?.field == .tags, !next.tagIds.isEmpty { refusal = nil }
        }
        .onChange(of: home.composerTags) { _, usable in
            // Staff deleted a tag (or made it staff-only) while it was picked
            // here: it leaves the pick, or Publicar would send a tag that no
            // longer exists.
            guard hasLoadedDraft else { return }
            let ids = Set(usable.map(\.id))
            let kept = draft.tagIds.filter { ids.contains($0) }
            if kept.count != draft.tagIds.count { draft.tagIds = kept }
        }
        .task {
            // The flag and the settings can have moved since the forum was
            // opened (no frame carries the flag): ask again as a post starts.
            await home.refreshRules()
        }
        .task(id: trimmedTitle) { await searchSimilar() }
        .task {
            attachmentsEnabled = (try? await session.api.attachmentConfig())?.enabled ?? false
        }
        .task(id: refusal?.retryUntil) {
            // The slow-mode countdown on the button.
            guard refusal?.retryUntil != nil else { return }
            while !Task.isCancelled, holdRemaining > 0 {
                try? await Task.sleep(for: .seconds(1))
                now = Date()
            }
        }
        .onChange(of: pickerItems) { _, items in
            Task { await stage(items) }
        }
    }

    // MARK: - Fields

    private var titleField: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Title")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Palette.paper)
                Spacer()
                Text(verbatim: "\(draft.title.count)/\(ForumLimits.titleMax)")
                    .font(.system(size: 12, weight: .medium).monospacedDigit())
                    .foregroundStyle(draft.title.count >= ForumLimits.titleMax ? Palette.warning : Palette.paperMuted)
                    .accessibilityLabel(Text("\(draft.title.count) of \(ForumLimits.titleMax) characters"))
            }
            TextField("Sum it up in one line", text: Binding(
                get: { draft.title },
                set: { value in
                    // One line, capped where the server caps it.
                    let single = value.replacingOccurrences(of: "\n", with: " ")
                    draft.title = String(single.prefix(ForumLimits.titleMax))
                }
            ), axis: .vertical)
                .font(.system(size: 17))
                .lineLimit(1...3)
                .foregroundStyle(Palette.paper)
                .focused($focus, equals: .title)
                .submitLabel(.next)
                .onSubmit { focus = .body }
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                        .fill(Palette.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                        .strokeBorder(focus == .title ? Palette.signal : Palette.border, lineWidth: focus == .title ? 1.5 : 1)
                )
                .accessibilityIdentifier("forum.composer.title")
            if triedPublish && trimmedTitle.isEmpty {
                fieldError(String(localized: "Give the post a title."))
            }
        }
    }

    private var similarBox: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "lightbulb")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Palette.warning)
                Text("Similar questions")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.paper)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .accessibilityAddTraits(.isHeader)
            ForEach(similar) { post in
                Rectangle().fill(Palette.border).frame(height: 1)
                Button {
                    drafts.save(draft, forumId: forumId)
                    onOpenSimilar?(post)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: post.isResolved ? "checkmark.circle" : "circle.dotted")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(post.isResolved ? Palette.success : Palette.paperMuted)
                        Text(ForumSimilar.highlighted(post.title, query: similarQuery))
                            .font(.system(size: 14))
                            .foregroundStyle(Palette.paperSubtle)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 6)
                        Text(verbatim: "\(post.replyCount)")
                            .font(.system(size: 12, weight: .medium).monospacedDigit())
                            .foregroundStyle(Palette.paperMuted)
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(onOpenSimilar == nil)
            }
            Rectangle().fill(Palette.border).frame(height: 1)
            Text("None of these help? Go ahead and post.")
                .font(.system(size: 12))
                .foregroundStyle(Palette.paperMuted)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
        }
        .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
        .opacity(similarLoading ? 0.6 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(similar.count == 1
                                 ? String(localized: "1 similar post")
                                 : String(localized: "\(similar.count) similar posts")))
    }

    private var tagsField: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("Tags")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Palette.paper)
                if home.settings.requireTag {
                    Text("at least 1")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Palette.warning)
                }
                Spacer()
                Text(verbatim: "\(draft.tagIds.count)/\(ForumLimits.maxTagsPerPost)")
                    .font(.system(size: 12, weight: .medium).monospacedDigit())
                    .foregroundStyle(Palette.paperMuted)
            }
            if home.composerTags.isEmpty {
                Text("This forum has no tags yet.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            } else {
                ForumWrap(spacing: 8) {
                    ForEach(home.composerTags) { tag in
                        let isOn = draft.tagIds.contains(tag.id)
                        ForumTagToggle(
                            tag: tag,
                            isOn: isOn,
                            isDisabled: !isOn && draft.tagIds.count >= ForumLimits.maxTagsPerPost
                        ) {
                            Haptics.selection()
                            if let index = draft.tagIds.firstIndex(of: tag.id) {
                                draft.tagIds.remove(at: index)
                            } else if draft.tagIds.count < ForumLimits.maxTagsPerPost {
                                draft.tagIds.append(tag.id)
                            }
                        }
                        .accessibilityIdentifier("forum.composer.tag.\(tag.name)")
                    }
                }
            }
            if draft.tagIds.count >= ForumLimits.maxTagsPerPost {
                Text("Up to \(ForumLimits.maxTagsPerPost) tags.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }
            if let refusal, refusal.field == .tags {
                fieldError(refusal.message)
            } else if triedPublish && needsTag {
                fieldError(String(localized: "Pick at least one tag."))
            }
        }
    }

    private var bodyField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Details")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Palette.paper)
            VStack(alignment: .leading, spacing: 0) {
                ZStack(alignment: .topLeading) {
                    if draft.body.isEmpty {
                        Text("What you tried, what went wrong, a screenshot if you have one")
                            .font(.system(size: 16))
                            .foregroundStyle(Palette.paperMuted.opacity(0.8))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 8)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text: Binding(
                        get: { draft.body },
                        set: { draft.body = String($0.prefix(ForumLimits.bodyMax)) }
                    ))
                    .font(.system(size: 16))
                    .foregroundStyle(Palette.paper)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 140)
                    .focused($focus, equals: .body)
                    .accessibilityIdentifier("forum.composer.body")
                }
                .padding(.horizontal, 8)
                .padding(.top, 4)

                if !attachments.isEmpty {
                    attachmentStrip
                }

                Rectangle().fill(Palette.border).frame(height: 1)
                HStack(spacing: 4) {
                    if attachmentsEnabled {
                        PhotosPicker(
                            selection: $pickerItems,
                            maxSelectionCount: max(1, 10 - attachments.count),
                            matching: .images
                        ) {
                            Image(systemName: "photo")
                                .font(.system(size: 16))
                                .foregroundStyle(Palette.paperMuted)
                                .frame(width: 44, height: 40)
                        }
                        .accessibilityLabel(Text("Add photos"))
                        .accessibilityIdentifier("forum.composer.attach")
                    }
                    Spacer()
                    Text("Markdown works")
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.paperMuted)
                        .padding(.trailing, 10)
                }
            }
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .fill(Palette.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .strokeBorder(focus == .body ? Palette.signal : Palette.border, lineWidth: focus == .body ? 1.5 : 1)
            )
            if triedPublish && !hasBody {
                fieldError(String(localized: "Add some text or a file."))
            }
        }
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { item in
                    ZStack(alignment: .topTrailing) {
                        if let image = UIImage(data: item.data) {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 64, height: 64)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        Button {
                            attachments.removeAll { $0.id == item.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 18))
                                .foregroundStyle(Palette.paper, Palette.inkDeep)
                        }
                        .offset(x: 5, y: -5)
                        .accessibilityLabel(Text("Remove"))
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
    }

    @ViewBuilder
    private var footer: some View {
        HStack {
            if restored {
                Label("Draft restored", systemImage: "arrow.uturn.backward")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            } else if !draft.isEmpty {
                Label("Draft saved", systemImage: "checkmark")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }
            Spacer()
            if !draft.isEmpty || !attachments.isEmpty {
                Button("Discard") {
                    drafts.clear(forumId: forumId)
                    hasLoadedDraft = false
                    draft = ForumDraft()
                    attachments = []
                    restored = false
                    refusal = nil
                    triedPublish = false
                    hasLoadedDraft = true
                }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Palette.danger)
                .frame(minHeight: 44)
                .accessibilityIdentifier("forum.composer.discard")
            }
        }
    }

    private var publishButton: some View {
        Button {
            Task { await publish() }
        } label: {
            HStack(spacing: 6) {
                if publishing {
                    ProgressView().controlSize(.small).tint(Palette.inkDeep)
                    Text("Posting…")
                } else if holdRemaining > 0 {
                    Text(verbatim: "\(holdRemaining)s")
                        .monospacedDigit()
                } else {
                    Text("Post")
                }
            }
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(canPublish || publishing ? Palette.inkDeep : Palette.paperMuted)
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(Capsule().fill(canPublish || publishing ? Palette.signal : Palette.surfaceRaised))
        }
        .buttonStyle(.plain)
        // Not `.disabled`: a tap on a not-ready Post says why under each field
        // (tooltips are inert on touch).
        .accessibilityIdentifier("forum.composer.publish")
        .keyboardShortcut(.return, modifiers: .command)
    }

    private func fieldError(_ message: String) -> some View {
        Text(verbatim: message)
            .font(Typography.caption)
            .foregroundStyle(Palette.warning)
            .transition(.opacity)
    }

    private func notice(_ message: String, icon: String, tint: Color = Palette.paperMuted) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 13))
                .foregroundStyle(tint)
                .padding(.top, 1)
            Text(verbatim: message)
                .font(Typography.callout)
                .foregroundStyle(Palette.paper)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                .fill(tint.opacity(0.12))
        )
    }

    private func liveHoldMessage(_ refusal: ForumComposerRefusal) -> String {
        // Re-say the slow-mode line with the seconds that are left.
        if refusal.isSlowMode {
            return String(localized: "Slow mode. Wait \(holdRemaining)s to post again.")
        }
        return refusal.message
    }

    // MARK: - Actions

    private func loadDraft() {
        guard !hasLoadedDraft else { return }
        if let saved = drafts.load(forumId: forumId) {
            draft = saved
            restored = true
        }
        if !seedTitle.isEmpty {
            draft.title = String(seedTitle.prefix(ForumLimits.titleMax))
        }
        // Tags this person can no longer use (deleted, or staff-only) fall away.
        let usable = Set(home.composerTags.map(\.id))
        draft.tagIds = draft.tagIds.filter { usable.contains($0) }
        hasLoadedDraft = true
        focus = .title
    }

    private func searchSimilar() async {
        let title = trimmedTitle
        guard title.count >= ForumLimits.similarMinChars else {
            similar = []
            return
        }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        similarLoading = true
        defer { similarLoading = false }
        guard let found = try? await session.api.similarForumPosts(forumId: forumId, title: title) else {
            // An error makes the box disappear quietly; it never blocks posting.
            similar = []
            return
        }
        guard !Task.isCancelled else { return }
        similarQuery = title
        similar = Array(found.prefix(ForumLimits.similarMax))
    }

    private func stage(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self),
               let image = UIImage(data: data),
               let pending = PendingAttachment.fromImage(image),
               attachments.count < 10 {
                attachments.append(pending)
            }
        }
        pickerItems = []
    }

    private func publish() async {
        triedPublish = true
        guard canPublish else {
            Haptics.selection()
            if trimmedTitle.isEmpty { focus = .title }
            return
        }
        publishing = true
        refusal = nil
        defer { publishing = false }

        // A retry of the same draft reuses the nonce; a changed draft is a new attempt.
        let files = attachments.map(\.id)
        if nonceDraft != draft || nonceFiles != files {
            nonce = UUID().uuidString
            nonceDraft = draft
            nonceFiles = files
        }

        // Minted against the FORUM: the post has no id yet. The create
        // re-homes them.
        var attachmentIds: [String] = []
        if !attachments.isEmpty {
            let uploader = AttachmentUploader(api: session.api)
            do {
                for index in attachments.indices {
                    if let id = attachments[index].attachmentId {
                        attachmentIds.append(id)
                        continue
                    }
                    let id = try await uploader.upload(attachments[index], channelId: forumId)
                    attachments[index].attachmentId = id
                    attachmentIds.append(id)
                }
            } catch {
                refusal = ForumComposerRefusal(
                    field: .general,
                    message: String(localized: "Couldn't post. The draft is still here, try again.")
                )
                return
            }
        }

        let body = APIClient.CreateForumPostBody(
            title: trimmedTitle,
            body: draft.body.trimmingCharacters(in: .whitespacesAndNewlines),
            tagIds: draft.tagIds,
            attachmentIds: attachmentIds,
            nonce: nonce
        )
        do {
            let created = try await session.api.createForumPost(forumId: forumId, body: body)
            drafts.clear(forumId: forumId)
            Haptics.selection()
            onPublished(created.post, created.viewer)
        } catch {
            refusal = ForumComposerRefusal.from(error)
            now = Date()
            if case .refused(_, let token) = error,
               token == ForumErrorCode.off || token == ForumErrorCode.tagRequired {
                // The server knew better than the screen: read the rule again,
                // so the paused state or "pick a tag" matches the refusal.
                Task { await home.refreshRules() }
            }
        }
    }
}
