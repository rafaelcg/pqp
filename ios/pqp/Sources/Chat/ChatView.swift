import SwiftUI
import PhotosUI

struct ChatView: View {
    @Environment(SessionStore.self) private var session
    let channelId: String
    let title: String

    @State private var model = ChatModel()
    @State private var showingPicker = false
    @State private var showingPins = false
    @State private var showingGifs = false
    @State private var emojiTarget: Message?
    @State private var pickerItem: PhotosPickerItem?
    @FocusState private var composerFocused: Bool

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            VStack(spacing: 0) {
                messageList
                typingRow
                composerContext
                attachmentStrip
                Composer(
                    text: $model.draft,
                    isSending: model.isSending,
                    canAttach: model.attachmentsEnabled,
                    canSendGif: model.gifsEnabled,
                    hasAttachments: !model.pendingAttachments.isEmpty,
                    onSend: { Task { await model.send() } },
                    onType: { model.noteTyping() },
                    onAttach: { showingPicker = true },
                    onGif: { showingGifs = true }
                )
                .focused($composerFocused)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .animation(Motion.standard, value: model.replyingTo?.id)
        .animation(Motion.standard, value: model.editing?.id)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingPins = true } label: { Image(systemName: "pin") }
                    .tint(Palette.signal)
                    .accessibilityLabel("Pinned messages")
            }
        }
        .sheet(isPresented: $showingPins) { PinnedMessagesView(channelId: channelId) }
        .sheet(isPresented: $showingGifs) {
            GifPicker { gif in Task { await model.sendGif(gif) } }
        }
        .sheet(item: $emojiTarget) { target in
            EmojiPicker { emoji in
                Task { await model.toggleReaction(emoji, on: target) }
            }
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
                            }
                        )
                        .id(message.id)
                        .contextMenu {
                            messageActions(for: message)
                        }
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

    @ViewBuilder
    private func messageActions(for message: Message) -> some View {
        // The quick row first: reacting is by far the most common thing anyone
        // does to someone else's message.
        ControlGroup {
            ForEach(ChatModel.quickReactions, id: \.self) { emoji in
                Button(emoji) {
                    Task { await model.toggleReaction(emoji, on: message) }
                }
            }
        }
        .controlGroupStyle(.compactMenu)

        Button {
            emojiTarget = message
        } label: {
            Label("More reactions…", systemImage: "face.smiling")
        }

        Button {
            model.beginReply(to: message)
            composerFocused = true
        } label: {
            Label("Reply", systemImage: "arrowshape.turn.up.left")
        }

        Button {
            UIPasteboard.general.string = message.body
        } label: {
            Label("Copy text", systemImage: "doc.on.doc")
        }

        Button {
            Task { await model.togglePin(message) }
        } label: {
            Label(
                message.pinnedAt == nil ? "Pin" : "Unpin",
                systemImage: message.pinnedAt == nil ? "pin" : "pin.slash"
            )
        }

        // Edit and delete are only ever offered on your own messages; the
        // server would refuse anyway, and offering an action that always fails
        // is worse than not offering it.
        if model.isMine(message) {
            Button {
                model.beginEdit(message)
                composerFocused = true
            } label: {
                Label("Edit", systemImage: "pencil")
            }

            Button(role: .destructive) {
                Task { await model.delete(message) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
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
                Text(isEdit ? "Editing message" : "Replying to \(target.authorName)")
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

struct Composer: View {
    @Binding var text: String
    let isSending: Bool
    var canAttach: Bool = false
    var canSendGif: Bool = false
    var hasAttachments: Bool = false
    let onSend: () -> Void
    let onType: () -> Void
    var onAttach: () -> Void = {}
    var onGif: () -> Void = {}

    private var canSend: Bool {
        // A photo with no caption is a valid message, so attachments alone
        // are enough to enable sending.
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasAttachments)
            && !isSending
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            if canAttach {
                Button(action: onAttach) {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 26))
                        .foregroundStyle(Palette.paperMuted)
                }
                .accessibilityIdentifier("composer.attach")
                .accessibilityLabel("Add photo")
                .padding(.bottom, 3)
            }

            if canSendGif {
                Button(action: onGif) {
                    Text("GIF")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundStyle(Palette.paperMuted)
                }
                .accessibilityIdentifier("composer.gif")
                .padding(.bottom, 12)
            }

            TextField("Message", text: $text, axis: .vertical)
                // Stable identifiers: a SwiftUI TextField's accessibility label
                // is its placeholder, which vanishes once the field has text —
                // so a UI test that queries by "Message" stops finding it
                // exactly when it is being edited.
                .accessibilityIdentifier("composer.input")
                .textFieldStyle(.plain)
                .font(Typography.body)
                .foregroundStyle(Palette.paper)
                .lineLimit(1...5)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(Palette.surface)
                )
                .onChange(of: text) { _, _ in onType() }

            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .accessibilityHidden(true)
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Palette.inkDeep)
                    .frame(width: 40, height: 40)
                    .background(
                        Circle().fill(canSend ? Palette.signal : Palette.surfaceRaised)
                    )
            }
            .accessibilityIdentifier("composer.send")
            .accessibilityLabel("Send")
            .disabled(!canSend)
            .scaleEffect(canSend ? 1 : 0.92)
            .animation(Motion.press, value: canSend)
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 10)
        .background(Palette.inkDeep)
    }
}

struct MessageRow: View {
    let message: Message
    let isGrouped: Bool
    var onToggleReaction: (String) -> Void = { _ in }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if isGrouped {
                // Keeps the text column aligned without repeating the avatar.
                Color.clear.frame(width: 36, height: 1)
            } else {
                Avatar(name: message.authorName, seed: message.authorId, size: 36)
            }

            VStack(alignment: .leading, spacing: 3) {
                if !isGrouped {
                    HStack(spacing: 6) {
                        Text(message.authorName)
                            .font(Typography.bodyMedium)
                            .foregroundStyle(Palette.paper)
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
                    Text(message.body)
                        .font(Typography.body)
                        .foregroundStyle(Palette.paper)
                        .textSelection(.enabled)
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

struct ReplyChip: View {
    let reply: MessageReplyRef

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "arrowshape.turn.up.left.fill")
                .font(.system(size: 9))
            Text(reply.deleted ? "Deleted message" : "\(reply.authorName ?? "Someone"): \(reply.excerpt)")
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

    var body: some View {
        // Images are shown, not described. A filename chip for a photo is the
        // one case where the chip is strictly worse than the thing itself.
        if attachment.isImage, let url = URL(string: attachment.url) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                case .failure:
                    fileChip
                default:
                    RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                        .fill(Palette.surface)
                        .frame(height: 140)
                        .overlay(ProgressView().tint(Palette.paperMuted))
                }
            }
            .frame(maxWidth: 260, maxHeight: 260)
            .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
        } else {
            fileChip
        }
    }

    private var fileChip: some View {
        HStack(spacing: 8) {
            Image(systemName: attachment.isImage ? "photo" : "doc")
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
        }
        .padding(10)
        .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
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
