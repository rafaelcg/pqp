import SwiftUI
import PhotosUI

/// A conversation to push, wrapped so the destination is keyed by a type only
/// this screen registers — `DmSummary` itself is already a destination further
/// up some of the stacks a chat can live in.
struct OpenedConversation: Identifiable, Hashable {
    let summary: DmSummary
    var id: String { summary.channelId }
}

struct ChatView: View {
    @Environment(SessionStore.self) private var session
    @Environment(CallModel.self) private var call
    let channelId: String
    let title: String
    /// Set only for a conversation (a channel with no server). Calls are a DM
    /// affordance: a server voice channel is a room you walk into from the
    /// channel list, and putting a call button on its text channel would ring
    /// nobody. Nil here is what keeps the header identical for server channels.
    var conversation: DmSummary? = nil
    /// Only a server text channel can host threads — a DM already is the scoped
    /// side-conversation threads exist to create, and threads do not nest. The
    /// server refuses the other cases with a 400; the call sites that can say
    /// yes pass it, so the action is not offered where it would always fail.
    var canStartThreads: Bool = false
    /// The server this channel belongs to, and this account's rank in it. Nil in
    /// a conversation, which has no moderators at all — the same rule
    /// `requireServerChannel` enforces on the API.
    ///
    /// WHAT IT UNLOCKS. Deleting somebody else's message was gated on `isMine`
    /// here, so an owner reading their own server on a phone could not remove
    /// anything anybody else had posted — the most-used moderation action in the
    /// product, and it had no iOS surface. Pinning had the mirror-image bug: it
    /// was gated on nothing, so a plain member tapped Pin and got a 403.
    var server: Server? = nil

    @State private var model = ChatModel()
    @State private var openedThread: ThreadSummary?
    @State private var showingPicker = false
    @State private var showingPins = false
    /// The composer's emoji/GIF panel — inline, below the composer, where the
    /// keyboard was. Not a sheet: a sheet covered the pill and the draft, so
    /// picking an emoji worked and looked like nothing at all had happened.
    @State private var showingExpression = false
    /// The message whose long-press menu is up, and the message whose full
    /// reaction picker is up. Two states, because the menu closes *into* the
    /// picker and both being one would make that a flicker.
    @State private var actionTarget: Message?
    @State private var reactionTarget: Message?
    @State private var reportTarget: ReportTarget?
    @State private var profileSubject: ProfileSubject?
    @State private var openedConversation: OpenedConversation?
    @State private var pickerItem: PhotosPickerItem?
    @FocusState private var composerFocused: Bool

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            VStack(spacing: 0) {
                messageList
                typingRow
                sanctionRow
                errorRow
                composerContext
                attachmentStrip
                Composer(
                    text: $model.draft,
                    isSending: model.isSending,
                    canAttach: model.attachmentsEnabled,
                    hasAttachments: !model.pendingAttachments.isEmpty,
                    isExpressing: showingExpression,
                    onSend: { Task { await model.send() } },
                    onType: { model.noteTyping() },
                    onAttach: { showingPicker = true },
                    onExpress: {
                        // The keyboard goes first: the panel takes its place, so
                        // the two never fight over the bottom of the screen.
                        composerFocused = false
                        withAnimation(Motion.standard) { showingExpression.toggle() }
                    }
                )
                .focused($composerFocused)

                if showingExpression {
                    ExpressionPanel(
                        gifsEnabled: model.gifsEnabled,
                        onEmoji: { model.draft.append($0) },
                        onGif: { gif in Task { await model.sendGif(gif) } },
                        onClose: {
                            withAnimation(Motion.standard) { showingExpression = false }
                        }
                    )
                    .transition(.move(edge: .bottom))
                }
            }
            // The panel and the keyboard occupy the same space, so the one that
            // was asked for wins: typing in the composer collapses the panel
            // rather than stacking a keyboard on top of it. The panel's *own*
            // search field is a different matter — the keyboard covers the
            // panel there, exactly as it does in Discord, and that is fine
            // because the thing being typed into is still on screen.
            .onChange(of: composerFocused) { _, focused in
                if focused, showingExpression {
                    withAnimation(Motion.standard) { showingExpression = false }
                }
            }

            if let target = actionTarget {
                messageActions(for: target)
                    .zIndex(10)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .animation(Motion.standard, value: model.replyingTo?.id)
        .animation(Motion.standard, value: model.editing?.id)
        .animation(Motion.standard, value: model.error)
        .toolbar {
            if let conversation {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        Task { await call.start(conversation: conversation, withVideo: false) }
                    } label: {
                        Image(systemName: "phone.fill")
                    }
                    .tint(Palette.signal)
                    .accessibilityIdentifier("chat.callVoice")
                    .accessibilityLabel("Start a voice call")
                    .disabled(call.phase.isLive)

                    Button {
                        Task { await call.start(conversation: conversation, withVideo: true) }
                    } label: {
                        Image(systemName: "video.fill")
                    }
                    .tint(Palette.signal)
                    .accessibilityIdentifier("chat.callVideo")
                    .accessibilityLabel("Start a video call")
                    .disabled(call.phase.isLive)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingPins = true } label: { Image(systemName: "pin") }
                    .tint(Palette.signal)
                    .accessibilityLabel("Pinned messages")
            }
        }
        // A collapsed call keeps a strip at the top of the thread it belongs to,
        // so "tuck the call away and read" does not mean losing it.
        .safeAreaInset(edge: .top, spacing: 0) {
            if call.isCurrent(channelId), call.isCollapsed {
                CallCollapsedBanner()
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(Motion.standard, value: call.isCollapsed)
        .animation(Motion.standard, value: actionTarget?.id)
        .threadDestination($openedThread)
        // Opening a DM from a profile pushes the conversation onto this stack.
        // Wrapped in its own type rather than pushing `DmSummary` directly:
        // other screens in the same stack already declare a destination for
        // that type, and two registrations for one type is a warning at best.
        .navigationDestination(item: $openedConversation) { opened in
            ChatView(
                channelId: opened.summary.channelId,
                title: opened.summary.title,
                conversation: opened.summary
            )
        }
        .sheet(isPresented: $showingPins) { PinnedMessagesView(channelId: channelId) }
        .sheet(item: $reactionTarget) { target in
            ExpressionPicker { emoji in
                Task { await model.toggleReaction(emoji, on: target) }
            }
        }
        .sheet(item: $reportTarget) { target in
            ReportSheet(target: target)
        }
        .sheet(item: $profileSubject) { subject in
            // `server` is what turns a tap on a message author into a moderation
            // surface — the ladder for somebody who may use it, and a report
            // filed with this server's moderators instead of the instance.
            UserProfileSheet(
                subject: subject,
                onOpenConversation: { conversation in
                    openedConversation = OpenedConversation(summary: conversation)
                },
                server: server
            )
        }
        .photosPicker(isPresented: $showingPicker, selection: $pickerItem, matching: .images)
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            Task {
                // Loaded as Data and re-encoded rather than passed through:
                // an iPhone stores HEIC, which a web client cannot display.
                if let data = try? await item.loadTransferable(type: Data.self),
                   let image = UIImage(data: data) {
                    model.attach(image)
                }
                pickerItem = nil
            }
        }
        .task { await model.open(channelId: channelId, session: session) }
        .onDisappear { model.close() }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if model.hasMore {
                        Button("Load earlier messages") {
                            Task { await model.loadEarlier() }
                        }
                        .font(Typography.callout)
                        .foregroundStyle(Palette.paperMuted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                    }

                    ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                        MessageRow(
                            message: message,
                            // Consecutive messages from one person collapse into
                            // a block, the way the web client groups them — a
                            // repeated avatar every line eats a phone screen.
                            isGrouped: model.isGrouped(at: index),
                            onToggleReaction: { emoji in
                                Task { await model.toggleReaction(emoji, on: message) }
                            },
                            onOpenThread: { openedThread = $0 },
                            onOpenProfile: { profileSubject = $0 }
                        )
                        .id(message.id)
                        // A gesture rather than `.contextMenu`, because the
                        // quick-reaction row's layout is the whole point and a
                        // context menu will not lay one out. The haptic is what
                        // makes it feel like the system menu it replaces.
                        //
                        // High priority, not `.onLongPressGesture`: the row now
                        // contains buttons (the avatar and the author name), and
                        // a plain gesture on the parent loses to them — holding
                        // on the name opened a profile instead of the menu, and
                        // holding near one did it often enough to be a coin
                        // flip. Priority makes "hold anywhere on the message"
                        // mean one thing. A quick tap still fails the long press
                        // and reaches the buttons as normal.
                        .highPriorityGesture(
                            LongPressGesture(minimumDuration: 0.35)
                                .onEnded { _ in
                                    Haptics.menuOpened()
                                    withAnimation(Motion.standard) { actionTarget = message }
                                }
                        )
                    }

                    if model.messages.isEmpty && !model.isLoading {
                        EmptyState(
                            icon: "text.bubble",
                            title: "Start the thread",
                            message: "Nothing here yet. Say something."
                        )
                        .padding(.top, 40)
                    }
                }
                .padding(.horizontal, Metrics.hPadding)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.messages.count) {
                guard let last = model.messages.last else { return }
                // Only follow the tail. Scrolling someone back to the bottom
                // while they are reading history is the classic chat-app sin.
                if model.isNearBottom {
                    withAnimation(Motion.standard) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    /// The long-press menu. Editing is yours alone; deleting is yours OR
    /// anybody's when you manage this server; pinning is free in a DM and
    /// manager-only in a server channel; reporting is other people's only. Every
    /// one of those is `Moderation`'s answer rather than this file's, so the menu
    /// cannot offer what the API would refuse — or hide what it would allow.
    private func messageActions(for message: Message) -> some View {
        MessageActionsOverlay(
            message: message,
            quickReactions: ChatModel.quickReactions,
            canStartThreads: canStartThreads,
            isMine: model.isMine(message),
            canDelete: Moderation.canDelete(
                isMine: model.isMine(message), serverRole: server?.role
            ),
            canPin: Moderation.canPin(inServer: server != nil, serverRole: server?.role),
            canReport: !model.isMine(message) && !message.isWebhook,
            onReact: { emoji in
                Task { await model.toggleReaction(emoji, on: message) }
            },
            onMoreReactions: { reactionTarget = message },
            onReply: {
                model.beginReply(to: message)
                composerFocused = true
            },
            onOpenThread: {
                // Start a thread, or open the one this message already has —
                // the server route is idempotent, so both are the same tap.
                if let existing = message.thread {
                    openedThread = existing
                } else {
                    Task { openedThread = await model.startThread(on: message) }
                }
            },
            onCopy: { UIPasteboard.general.string = message.body },
            onTogglePin: { Task { await model.togglePin(message) } },
            onReport: {
                reportTarget = .message(id: message.id, authorName: message.authorName)
            },
            onEdit: {
                model.beginEdit(message)
                composerFocused = true
            },
            onDelete: { Task { await model.delete(message) } },
            onDismiss: { withAnimation(Motion.standard) { actionTarget = nil } }
        )
    }

    @ViewBuilder
    private var attachmentStrip: some View {
        if !model.pendingAttachments.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.pendingAttachments) { item in
                        ZStack(alignment: .topTrailing) {
                            if let image = UIImage(data: item.data) {
                                Image(uiImage: image)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 64, height: 64)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            Button {
                                model.removeAttachment(item.id)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 17))
                                    .foregroundStyle(Palette.paper, Palette.inkDeep)
                            }
                            .offset(x: 5, y: -5)
                        }
                    }
                }
                .padding(.horizontal, Metrics.hPadding)
                .padding(.vertical, 8)
            }
            .background(Palette.inkDeep)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    @ViewBuilder
    private var composerContext: some View {
        if let target = model.replyingTo ?? model.editing {
            let isEdit = model.editing != nil
            HStack(spacing: 8) {
                Image(systemName: isEdit ? "pencil" : "arrowshape.turn.up.left.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.signal)
                Text(isEdit
                     ? String(localized: "Editing message")
                     : String(localized: "Replying to \(target.authorName)"))
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .lineLimit(1)
                Spacer()
                Button {
                    model.cancelComposerContext()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Palette.paperMuted)
                }
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.vertical, 8)
            .background(Palette.surface)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    /// The timeout notice, rendered verbatim — the server writes the whole
    /// sentence precisely so clients cannot drift into their own explanations.
    /// Dismissible, because it re-arrives on the next refused attempt anyway.
    @ViewBuilder
    private var sanctionRow: some View {
        if let sanction = model.sanction {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.warning)
                    .padding(.top, 2)
                Text(sanction.message)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paper)
                Spacer()
                Button {
                    model.sanction = nil
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Palette.paperMuted)
                }
                .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.vertical, 8)
            .background(Palette.warning.opacity(0.12))
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    /// Whatever went wrong, said out loud, directly above the composer.
    ///
    /// `ChatModel.error` was write-only until now: eight code paths set it and
    /// no view ever read it, so a GIF the server refused, a history page that
    /// failed to load and a send that was rejected were all equally silent.
    /// Above the composer rather than over it, because the panel now occupies
    /// the bottom of the screen and a notice underneath it would be a notice
    /// nobody sees — the exact failure being fixed.
    @ViewBuilder
    private var errorRow: some View {
        if let error = model.error {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.danger)
                    .padding(.top, 2)
                Text(error)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paper)
                    .accessibilityIdentifier("chat.error")
                Spacer()
                Button {
                    withAnimation(Motion.standard) { model.error = nil }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Palette.paperMuted)
                }
                .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.vertical, 8)
            .background(Palette.danger.opacity(0.12))
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    @ViewBuilder
    private var typingRow: some View {
        if !model.typingNames.isEmpty {
            HStack(spacing: 8) {
                TypingDots()
                Text(model.typingDescription)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                Spacer()
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.bottom, 4)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }
}

/// The composer: one floating pill.
///
/// Everything that adds *content* lives inside the pill — attach on the leading
/// edge, the smiley on the trailing one — and the send button only exists when
/// there is something to send. That is deliberate: an always-present grey
/// arrow is a permanent piece of furniture that says "nothing to do here", and
/// the two content buttons flanking the field is what makes the field read as
/// the input rather than as one control among four.
///
/// One smiley, not a smiley and a "GIF": emoji and GIFs are the same errand
/// ("put something expressive in this message") and they now share one sheet.
struct Composer: View {
    @Binding var text: String
    let isSending: Bool
    var canAttach: Bool = false
    var hasAttachments: Bool = false
    /// Whether the expression panel is currently open. The smiley is a toggle,
    /// so it has to look like one — an unlit button over an open panel reads as
    /// "tap me to open the thing that is already open".
    var isExpressing: Bool = false
    let onSend: () -> Void
    let onType: () -> Void
    var onAttach: () -> Void = {}
    var onExpress: () -> Void = {}

    private var canSend: Bool {
        // A photo with no caption is a valid message, so attachments alone
        // are enough to enable sending.
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasAttachments)
            && !isSending
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            HStack(alignment: .bottom, spacing: 4) {
                if canAttach {
                    Button(action: onAttach) {
                        Image(systemName: "plus")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Palette.paperMuted)
                            .frame(width: 34, height: 34)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("composer.attach")
                    .accessibilityLabel("Add photo")
                }

                TextField("Message", text: $text, axis: .vertical)
                    // Stable identifiers: a SwiftUI TextField's accessibility
                    // label is its placeholder, which vanishes once the field
                    // has text — so a UI test that queries by "Message" stops
                    // finding it exactly when it is being edited.
                    .accessibilityIdentifier("composer.input")
                    .textFieldStyle(.plain)
                    .font(Typography.body)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1...5)
                    .padding(.vertical, 8)
                    .padding(.leading, canAttach ? 0 : 8)
                    .onChange(of: text) { _, _ in onType() }

                Button(action: onExpress) {
                    Image(systemName: isExpressing ? "keyboard" : "face.smiling")
                        .font(.system(size: 18))
                        .foregroundStyle(isExpressing ? Palette.signal : Palette.paperMuted)
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("composer.express")
                .accessibilityLabel("Emoji and GIFs")
                .accessibilityAddTraits(isExpressing ? .isSelected : [])
            }
            .padding(.horizontal, 5)
            // A continuous rounded rectangle rather than a Capsule: at one line
            // it reads as a pill, and at five it does not turn into a lozenge
            // with the text swimming in the middle.
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Palette.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(Palette.border, lineWidth: 1)
            )

            if canSend {
                Button(action: onSend) {
                    Image(systemName: "arrow.up")
                        .accessibilityHidden(true)
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Palette.inkDeep)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(Palette.signal))
                }
                .accessibilityIdentifier("composer.send")
                .accessibilityLabel("Send")
                .transition(.scale(scale: 0.6).combined(with: .opacity))
            }
        }
        .animation(Motion.press, value: canSend)
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 10)
        .background(Palette.inkDeep)
    }
}

struct MessageRow: View {
    let message: Message
    let isGrouped: Bool
    var onToggleReaction: (String) -> Void = { _ in }
    var onOpenThread: (ThreadSummary) -> Void = { _ in }
    /// Tapping who said it opens them. This is the discovery path that was
    /// missing: before it, the only way to befriend someone you were talking to
    /// was to already know their full `name#1234` and type it into a different
    /// screen.
    var onOpenProfile: (ProfileSubject) -> Void = { _ in }

    /// A webhook has no account behind it, so there is nobody to open.
    private var isPerson: Bool { !message.isWebhook }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if isGrouped {
                // Keeps the text column aligned without repeating the avatar.
                Color.clear.frame(width: 36, height: 1)
            } else {
                Button {
                    onOpenProfile(ProfileSubject(message: message))
                } label: {
                    Avatar(name: message.authorName, seed: message.authorId, size: 36,
                           url: message.authorAvatarUrl)
                }
                .buttonStyle(.plain)
                .disabled(!isPerson)
                .accessibilityIdentifier("message.avatar")
                .accessibilityLabel(Text("Open \(message.authorName)'s profile"))
            }

            VStack(alignment: .leading, spacing: 3) {
                if !isGrouped {
                    HStack(spacing: 6) {
                        Button {
                            onOpenProfile(ProfileSubject(message: message))
                        } label: {
                            Text(message.authorName)
                                .font(Typography.bodyMedium)
                                .foregroundStyle(Palette.paper)
                        }
                        .buttonStyle(.plain)
                        .disabled(!isPerson)
                        .accessibilityIdentifier("message.author")
                        if message.isWebhook {
                            Text("WEBHOOK")
                                .font(.system(size: 9, weight: .bold))
                                .tracking(0.6)
                                .foregroundStyle(Palette.inkDeep)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1.5)
                                .background(Capsule().fill(Palette.signal))
                        }
                        Text(message.createdAt, format: .dateTime.hour().minute())
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    }
                }

                if let reply = message.replyTo {
                    ReplyChip(reply: reply)
                }

                if message.blocked {
                    Text("Message hidden — you blocked this person.")
                        .font(Typography.callout)
                        .italic()
                        .foregroundStyle(Palette.paperMuted)
                } else if !message.body.isEmpty {
                    // Deliberately NOT `.textSelection(.enabled)`: selectable
                    // text eats the long press, and the long press is now how
                    // the whole action menu is reached. "Copy text" is in that
                    // menu, which is the errand selection was serving anyway.
                    MessageBodyText(body: message.body)
                        .font(Typography.body)
                        .foregroundStyle(Palette.paper)
                }

                ForEach(message.attachments) { attachment in
                    AttachmentChip(attachment: attachment)
                }

                ForEach(message.embeds, id: \.url) { embed in
                    EmbedCard(embed: embed)
                }

                if message.editedAt != nil {
                    Text("edited")
                        .font(.system(size: 10))
                        .foregroundStyle(Palette.paperMuted)
                }

                if !message.reactions.isEmpty {
                    ReactionRow(reactions: message.reactions, onTap: onToggleReaction)
                }

                if let thread = message.thread {
                    ThreadChip(thread: thread) { onOpenThread(thread) }
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, isGrouped ? 1 : 6)
        // A pending message is dimmed rather than hidden, so the text is
        // visibly "yours already" while the round trip completes.
        .opacity(message.isPending ? 0.55 : 1)
        .animation(Motion.standard, value: message.isPending)
    }
}

/// Message bodies are markdown on the web client, so the same text has to
/// render the same way here — `**bold**` shown literally reads as a bug to
/// anyone who typed it on the other platform.
///
/// `inlineOnlyPreservingWhitespace` is deliberate: it covers bold, italics,
/// strikethrough, inline code and links while keeping the author's line breaks,
/// and it cannot produce block elements (headings, quote bars) that would need
/// bespoke layout. Parsing failure falls back to the raw text — a message must
/// never be dropped because its punctuation confused a parser.
struct MessageBodyText: View {
    let raw: String

    init(body: String) { raw = body }

    private var attributed: AttributedString {
        guard var parsed = try? AttributedString(
            markdown: raw,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else { return AttributedString(raw) }
        // Links get the accent so they are visibly tappable on the dark ground.
        for run in parsed.runs where run.link != nil {
            parsed[run.range].foregroundColor = Palette.signal
            parsed[run.range].underlineStyle = .single
        }
        return parsed
    }

    var body: some View { Text(attributed) }
}

struct ReplyChip: View {
    let reply: MessageReplyRef

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "arrowshape.turn.up.left.fill")
                .font(.system(size: 9))
            Text(reply.deleted
                 ? String(localized: "Deleted message")
                 : "\(reply.authorName ?? String(localized: "Someone")): \(reply.excerpt)")
                .lineLimit(1)
        }
        .font(Typography.caption)
        .foregroundStyle(Palette.paperMuted)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Palette.surface)
        )
    }
}

struct AttachmentChip: View {
    let attachment: Attachment
    @Environment(SessionStore.self) private var session
    @State private var playing = false
    @State private var viewingFullscreen = false
    /// Set when the original presigned URL failed and a fresh one was fetched.
    @State private var refreshedUrl: URL?
    @State private var refetched = false

    var body: some View {
        // Images (and GIFs) are shown, not described, and tap open the same
        // fullscreen viewer the web client's lightbox is for — a filename
        // chip for a photo is the one case where the chip is strictly worse
        // than the thing itself.
        if attachment.isImage {
            Button { viewingFullscreen = true } label: { inlineImage }
                .buttonStyle(.plain)
                .fullScreenCover(isPresented: $viewingFullscreen) {
                    MediaFullscreenView(attachment: attachment)
                }
        } else if attachment.isVideo {
            // Tap-to-open rather than autoplay, matching the web client: a
            // chat log that starts making noise on scroll is hostile.
            Button { viewingFullscreen = true } label: { fileChip }
                .buttonStyle(.plain)
                .fullScreenCover(isPresented: $viewingFullscreen) {
                    MediaFullscreenView(attachment: attachment)
                }
        } else if attachment.isPlayable {
            // Audio has no fullscreen visual to show — the existing
            // AVPlayer-backed sheet is exactly right for it.
            Button { playing = true } label: { fileChip }
                .buttonStyle(.plain)
                .fullScreenCover(isPresented: $playing) {
                    MediaPlayerView(attachment: attachment)
                }
        } else {
            fileChip
        }
    }

    @ViewBuilder
    private var inlineImage: some View {
        if attachment.isGif {
            AnimatedImageView(
                url: refreshedUrl ?? URL(string: attachment.url),
                onFailure: { Task { await refreshUrlOnce() } }
            )
            .frame(maxWidth: 260, maxHeight: 260)
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
        } else if let url = refreshedUrl ?? URL(string: attachment.url) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                case .failure:
                    // Presigned URLs expire; ask for a new one exactly once —
                    // the server route exists for precisely this — then admit
                    // defeat as a chip rather than a permanently broken frame.
                    if refetched {
                        fileChip
                    } else {
                        placeholder.task { await refreshUrlOnce() }
                    }
                default:
                    placeholder
                }
            }
            .frame(maxWidth: 260, maxHeight: 260)
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
        }
    }

    private func refreshUrlOnce() async {
        guard !refetched else { return }
        refetched = true
        if let fresh = try? await session.api.attachmentUrl(id: attachment.id) {
            refreshedUrl = URL(string: fresh)
        }
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
            .fill(Palette.surface)
            .frame(height: 140)
            .overlay(ProgressView().tint(Palette.paperMuted))
    }

    private var fileChip: some View {
        HStack(spacing: 8) {
            Image(systemName: chipIcon)
                .foregroundStyle(Palette.signal)
            VStack(alignment: .leading, spacing: 1) {
                Text(attachment.filename)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.byteSize), countStyle: .file))
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.paperMuted)
            }
            if attachment.isPlayable {
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(Palette.signal)
            }
        }
        .padding(10)
        .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
    }

    private var chipIcon: String {
        if attachment.isImage { return "photo" }
        if attachment.isVideo { return "film" }
        if attachment.isAudio { return "waveform" }
        return "doc"
    }
}

struct ReactionRow: View {
    let reactions: [MessageReaction]
    var onTap: (String) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 6) {
            ForEach(reactions, id: \.emoji) { reaction in
                Button { onTap(reaction.emoji) } label: {
                HStack(spacing: 4) {
                    Text(reaction.emoji).font(.system(size: 13))
                    Text("\(reaction.count)")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(reaction.me ? Palette.signal : Palette.paperMuted)
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(
                    Capsule()
                        .fill(Palette.surface)
                        .overlay(
                            Capsule().strokeBorder(
                                reaction.me ? Palette.signal : .clear,
                                lineWidth: 1
                            )
                        )
                )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 2)
        .animation(Motion.press, value: reactions)
    }
}
