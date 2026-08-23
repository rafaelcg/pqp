import SwiftUI

/// Depoimentos — the one feature in this product whose mechanic is an ACT OF
/// APPROVAL rather than an act of publishing.
///
/// A friend writes a short thing about you. It lands in your queue, invisible to
/// everyone — including them, after sending — until you publish it. Published
/// ones sit on your profile, newest first, and you can take any of them down at
/// any time without telling anybody.
///
/// THE THREE RULES THIS FILE EXISTS TO DRAW:
///
///  1. NOTHING IS COUNTED. There is no "0 depoimentos", no empty state, no
///     number anywhere except the subject's own queue. Popularity-counting is
///     precisely the "auge ou ostracismo" dynamic Orkut's reputation came from,
///     and a rendered zero is the worst version of it — so a card with nothing
///     to show looks exactly like a card from before this feature existed.
///  2. THE COMPOSER SHIPS WITH A DM FORK, at the same weight as Send. Because
///     an unaccepted depoimento sat in a queue only the recipient could read,
///     Brazilians worked out that a depoimento WAS a private message and wrote
///     confessions into it opening with "Não aceita!". You cannot warn that
///     away: if the private-message use has no home, people make one out of your
///     pending queue. So the sheet says in plain words that this is going to be
///     public, and offers the DM in the same breath, carrying the same text.
///  3. PUBLISHING IS TWO TAPS OVER A PREVIEW; REFUSING IS ONE TAP AND SILENT.
///     Refusing deletes the row, the author is never told, and the whole safety
///     argument rests on refusing staying cheap.

// MARK: - The published list, on a profile

/// The depoimentos somebody chose to display.
///
/// HIDES ITSELF WHEN EMPTY, and that is rule 1 rather than a style choice.
struct DepoimentosSection: View {
    let depoimentos: [Depoimento]
    /// Set only on your own card: the subject may take any published one down at
    /// any time, without notice, which is what makes publishing safe to do.
    var onRemove: ((String) -> Void)?
    var busy = false

    var body: some View {
        if depoimentos.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: String(localized: "Depoimentos"))
                    .frame(maxWidth: .infinity, alignment: .leading)

                ForEach(depoimentos) { one in
                    VStack(alignment: .leading, spacing: 6) {
                        // The words first and the byline under them, the way a
                        // quotation is set. A depoimento is the only thing on a
                        // profile written by somebody else, and burying it under
                        // a name would make it read as a message.
                        Text(one.body)
                            .font(Typography.callout)
                            .foregroundStyle(Palette.paper)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        HStack(spacing: 6) {
                            // No dash in front of the name, though that is how a
                            // pull quote is usually attributed: the house rule
                            // bans the character in anything a user reads, and an
                            // exception for typography is how 184 of them got into
                            // the web catalogues. The caption weight already says
                            // this line is the byline and not more of the quote.
                            Text("\(one.author.tag ?? one.author.displayName), \(Depoimentos.stamp(one), format: .dateTime.month(.wide).year())")
                                .font(Typography.caption)
                                .foregroundStyle(Palette.paperMuted)
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            if let onRemove {
                                Button(role: .destructive) {
                                    onRemove(one.id)
                                } label: {
                                    Image(systemName: "trash")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundStyle(Palette.paperMuted)
                                }
                                .buttonStyle(.plain)
                                .disabled(busy)
                                .accessibilityLabel(
                                    Text("Take down the depoimento from \(one.author.displayName)")
                                )
                            }
                        }
                    }
                    .padding(12)
                    .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
                    .accessibilityIdentifier("depoimento.\(one.id)")
                }
            }
            .accessibilityIdentifier("profile.depoimentos")
        }
    }
}

// MARK: - The community chips

/// The communities somebody is in, as a garnish on their identity block.
///
/// Icon-and-name at chip size, capped at six with the rest collapsed into "+N".
/// ONLY LISTED COMMUNITIES REACH HERE — the server filters, and a private server
/// can never appear on anybody's card.
struct CommunityBadges: View {
    let list: ProfileCommunityList

    private let columns = [GridItem(.adaptive(minimum: 108, maximum: 200), spacing: 6)]

    var body: some View {
        if list.communities.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: String(localized: "Communities"))
                    .frame(maxWidth: .infinity, alignment: .leading)

                LazyVGrid(columns: columns, alignment: .leading, spacing: 6) {
                    ForEach(list.communities) { community in
                        HStack(spacing: 6) {
                            Text(CommunityDirectory.monogram(community.name))
                                .font(.system(size: 9, weight: .bold, design: .rounded))
                                .foregroundStyle(Palette.inkDeep)
                                .frame(width: 18, height: 18)
                                .background(
                                    Circle().fill(
                                        Color(
                                            hue: CommunityDirectory.hue(community.id),
                                            saturation: 0.55,
                                            brightness: 0.82
                                        )
                                    )
                                )
                            Text(community.name)
                                .font(Typography.caption)
                                .foregroundStyle(Palette.paper)
                                .lineLimit(1)
                        }
                        .padding(.leading, 4)
                        .padding(.trailing, 10)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(Palette.surfaceRaised))
                    }

                    if let hidden = Depoimentos.communityOverflow(list) {
                        Text("+\(hidden)")
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(Capsule().fill(Palette.surfaceRaised))
                    }
                }
            }
            .accessibilityIdentifier("profile.communities")
        }
    }
}

// MARK: - The composer

/// Write one about a friend — and the most opinionated screen in the feature.
///
/// See rule 2 in the file note: the DM fork is the mitigation for the one
/// documented failure of Orkut's depoimentos, and it is given the weight of a
/// real option because for some of the people typing here it is the right one.
struct DepoimentoComposer: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss

    let subject: ProfileSubject
    /// Written and pending. The caller closes and says so.
    let onWritten: () -> Void
    /// The fork, carrying the typed text — an escape hatch that makes you retype
    /// what you wrote is one nobody takes, and this one has to be taken by the
    /// people who need it most.
    let onSendAsDm: (String) -> Void

    @State private var body_ = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var remaining: Int { Depoimentos.remaining(body_) }
    private var canSubmit: Bool { Depoimentos.canSubmit(body_) && !busy }

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                VStack(alignment: .leading, spacing: 12) {
                    Text("Something you'd say about \(subject.displayName)")
                        .font(Typography.bodyMedium)
                        .foregroundStyle(Palette.paper)

                    TextField(
                        "How you met, what they're like, the thing nobody would guess…",
                        text: $body_,
                        axis: .vertical
                    )
                    .lineLimit(5...10)
                    .font(Typography.body)
                    .foregroundStyle(Palette.paper)
                    .focused($focused)
                    .padding(12)
                    .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
                    .accessibilityIdentifier("depoimento.body")

                    HStack(alignment: .top) {
                        // The one sentence that has to be read, where a person's
                        // eye lands after typing. It says what happens rather
                        // than asking them to be careful.
                        Text("If they accept, this goes on their profile for anyone to read.")
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        Text("\(remaining)")
                            .font(Typography.caption)
                            .monospacedDigit()
                            .foregroundStyle(remaining < 0 ? Palette.danger : Palette.paperMuted)
                    }

                    if let error {
                        Text(error)
                            .font(Typography.callout)
                            .foregroundStyle(Palette.danger)
                    }

                    Button {
                        Task { await send() }
                    } label: {
                        Text(busy ? "Sending…" : "Send it")
                    }
                    .buttonStyle(PrimaryButtonStyle(isEnabled: canSubmit))
                    .disabled(!canSubmit)
                    .accessibilityIdentifier("depoimento.send")

                    // THE FORK. Secondary, not a footnote: it has to look like
                    // the other way of doing this.
                    Button {
                        let text = body_.trimmingCharacters(in: .whitespacesAndNewlines)
                        onSendAsDm(text)
                        dismiss()
                    } label: {
                        Label("This is private. Send it as a DM", systemImage: "bubble.left")
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(busy || body_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("depoimento.asDm")

                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Metrics.hPadding)
                .padding(.top, 14)
            }
            .navigationTitle("Write a depoimento")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.tint(Palette.paperMuted)
                }
            }
        }
        .presentationDetents([.large])
        .onAppear { focused = true }
    }

    private func send() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            _ = try await session.api.writeDepoimento(
                userId: subject.id,
                body: body_.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            onWritten()
            dismiss()
        } catch {
            // Verbatim: the server answers "you can only write depoimentos for
            // your friends" for every refusal on purpose, and the length message
            // is one the author has to read in order to fix it.
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

// MARK: - The queue

/// Depoimentos friends have written about you that nobody — not even the person
/// who wrote them — can see until you publish one.
///
/// It lives in the Friends screen's Pending tab beside the friend requests
/// because it is the same errand: somebody is waiting for an answer from you,
/// and both answers are two buttons. Anywhere else would be a second badge on a
/// second door.
///
/// THE ORDER OF WHAT YOU SEE IS DELIBERATE. The author is named ABOVE the text:
/// an ex-friend is the one person the friends gate cannot exclude, so nobody
/// should be ambushed by a paragraph from a name they were not ready to read.
struct PendingDepoimentosSection: View {
    let depoimentos: [Depoimento]
    let busyId: String?
    let onApprove: (String) -> Void
    let onReject: (String) -> Void

    /// The one being published, held for its second tap.
    @State private var confirming: String?

    var body: some View {
        if depoimentos.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: String(localized: "Depoimentos waiting on you"))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)

                Text("Only you can see these. Nobody is told either way.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)

                ForEach(depoimentos) { one in
                    row(one)
                }
            }
            .accessibilityIdentifier("friends.pendingDepoimentos")
        }
    }

    @ViewBuilder
    private func row(_ one: Depoimento) -> some View {
        let busy = busyId == one.id

        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Avatar(
                    name: one.author.displayName, seed: one.author.id,
                    size: 28, url: one.author.avatarUrl
                )
                Text(one.author.displayName)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(1)
                if let tag = one.author.tag {
                    Text(tag)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Palette.paperMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                Text(Depoimentos.stamp(one), format: .dateTime.month().year())
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.paperMuted)
            }

            Text(one.body)
                .font(Typography.callout)
                .foregroundStyle(Palette.paper)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            if confirming == one.id {
                // The second tap, over the text exactly as it will appear. The
                // sentence names the consequence rather than asking "are you
                // sure?" — §05 calls this the most important UI decision here.
                VStack(alignment: .leading, spacing: 8) {
                    Text("Put this on your profile?")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paper)
                    Text("Anyone who opens your profile will read it, with \(one.author.displayName)'s name on it. You can take it down later.")
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.paperMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 10) {
                        Button("Publish") {
                            confirming = nil
                            onApprove(one.id)
                        }
                        .font(Typography.caption)
                        .foregroundStyle(Palette.signal)
                        .disabled(busy)
                        .accessibilityIdentifier("depoimento.confirm.\(one.id)")

                        Button("Not now") { confirming = nil }
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    }
                }
                .padding(10)
                .background(
                    RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                        .fill(Palette.surfaceRaised)
                )
            } else {
                HStack(spacing: 14) {
                    if busy {
                        ProgressView().tint(Palette.signal)
                    } else {
                        Button("Publish") { confirming = one.id }
                            .font(Typography.caption)
                            .foregroundStyle(Palette.signal)
                            .accessibilityIdentifier("depoimento.publish.\(one.id)")
                        // One tap, no confirmation, silent to the author — the
                        // row simply stops existing. The asymmetry is the point.
                        Button("Refuse") { onReject(one.id) }
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                            .accessibilityIdentifier("depoimento.refuse.\(one.id)")
                    }
                    Spacer()
                }
            }
        }
        .padding(12)
        .pqpSurface()
        .accessibilityIdentifier("depoimento.pending.\(one.id)")
    }
}
