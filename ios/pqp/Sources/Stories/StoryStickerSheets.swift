import SwiftUI

/// The stickers tray: what can be placed on the story besides words and
/// pictures. Two today, with room for the next ones.
struct StoryStickerTray: View {
    /// The story already holds the ceiling (20): say so on both tiles.
    var isFull = false
    let canAddCall: Bool
    let canAddMention: Bool
    let onCall: () -> Void
    let onMention: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Stickers")
                .font(Typography.title(19))
                .foregroundStyle(Palette.paper)
            HStack(spacing: 12) {
                tile(symbol: "headphones", title: String(localized: "Call"),
                     detail: isFull ? String(localized: "That's the most things a story can hold.")
                         : (canAddCall ? String(localized: "Bring people into a room") : String(localized: "One call per story")),
                     enabled: canAddCall, id: "tray.call", action: onCall)
                tile(symbol: "at", title: String(localized: "Mention"),
                     detail: isFull ? String(localized: "That's the most things a story can hold.")
                         : (canAddMention ? String(localized: "Tag someone") : String(localized: "Up to 5 people")),
                     enabled: canAddMention, id: "tray.mention", action: onMention)
            }
            Spacer(minLength: 0)
        }
        .padding(Metrics.hPadding)
        .padding(.top, 8)
    }

    private func tile(symbol: String, title: String, detail: String, enabled: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: symbol)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(enabled ? Palette.signal : Palette.paperMuted)
                Text(verbatim: title)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(enabled ? Palette.paper : Palette.paperMuted)
                Text(verbatim: detail)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Palette.surfaceRaised))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityIdentifier(id)
    }
}

// MARK: - The call

/// Picking the room for a call sticker: every voice room this account can post
/// to, with the server it belongs to and who is in it right now, and a warning
/// when the author is not in the room (the card is closed for everyone while
/// the author is out of it). Nothing is preselected unless the author is in a
/// room.
struct StoryCallSheet: View {
    @Environment(SessionStore.self) private var session
    @State private var selection: StoryCallChoice?
    let onAdd: (StoryCallChoice) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StoryCallPicker(selection: $selection)
            Spacer(minLength: 0)
            Button {
                if let selection { onAdd(selection) }
            } label: {
                Text("Add to story").frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(Palette.inkDeep)
            .padding(.vertical, 14)
            .background(Capsule().fill(selection == nil ? Palette.signal.opacity(0.35) : Palette.signal))
            .disabled(selection == nil)
            .accessibilityIdentifier("call.add")
        }
        .padding(Metrics.hPadding)
        .padding(.top, 8)
    }
}

// MARK: - Mentions

struct StoryMentionCandidate: Identifiable, Hashable, Sendable {
    let id: String
    let displayName: String
    let handle: String?
    let avatarUrl: String?

    var author: StoryAuthor {
        StoryAuthor(id: id, displayName: displayName, avatarUrl: avatarUrl, handle: handle)
    }
}

enum StoryMentionRules {
    /// Friends first, then the people of the server the story starts from,
    /// each once, never the author, filtered by the search text.
    static func candidates(
        friends: [StoryMentionCandidate], members: [StoryMentionCandidate],
        me: String?, taken: Set<String>, query: String
    ) -> [StoryMentionCandidate] {
        var seen = Set<String>()
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return (friends + members).filter { person in
            guard person.id != me, !taken.contains(person.id), seen.insert(person.id).inserted else { return false }
            return needle.isEmpty
                || person.displayName.lowercased().contains(needle)
                || (person.handle?.lowercased().contains(needle) ?? false)
        }
    }
}

/// Who can be mentioned: friends and the members of the server the composer
/// was opened from. The server has the last word, since a mention has to be
/// somebody who can see the story, and says so if the audience chosen after
/// this leaves them out.
struct StoryMentionSheet: View {
    @Environment(SessionStore.self) private var session
    let serverId: String?
    let taken: Set<String>
    let onPick: (StoryMentionCandidate) -> Void

    @State private var query = ""
    @State private var friends: [StoryMentionCandidate] = []
    @State private var members: [StoryMentionCandidate] = []
    @State private var loaded = false
    @State private var failed = false

    private var shown: [StoryMentionCandidate] {
        StoryMentionRules.candidates(friends: friends, members: members, me: session.currentUser?.id, taken: taken, query: query)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Mention someone")
                .font(Typography.title(19))
                .foregroundStyle(Palette.paper)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Palette.paperMuted)
                TextField("", text: $query, prompt: Text("Search people").foregroundStyle(Palette.paperMuted))
                    .foregroundStyle(Palette.paper)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("mention.search")
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.surfaceRaised))
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(shown) { person in
                        Button { onPick(person) } label: {
                            HStack(spacing: 12) {
                                Avatar(name: person.displayName, seed: person.id, size: 36, url: person.avatarUrl)
                                Text(verbatim: person.displayName)
                                    .font(Typography.bodyMedium)
                                    .foregroundStyle(Palette.paper)
                                Spacer()
                            }
                            .padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("mention.person.\(person.id)")
                    }
                    if loaded && failed {
                        VStack(spacing: 8) {
                            Text("Couldn't load everyone.")
                                .font(Typography.callout)
                                .foregroundStyle(Palette.paperMuted)
                            Button("Try again") { Task { loaded = false; await load() } }
                                .font(Typography.bodyMedium)
                                .foregroundStyle(Palette.signal)
                                .accessibilityIdentifier("mention.retry")
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 20)
                    } else if loaded && shown.isEmpty {
                        Text("Nobody to mention yet.")
                            .font(Typography.callout)
                            .foregroundStyle(Palette.paperMuted)
                            .padding(.top, 20)
                    }
                }
            }
        }
        .padding(Metrics.hPadding)
        .padding(.top, 8)
        .task { await load() }
    }

    /// Friends and the server's people are asked for at the same time. A
    /// request that fails is said out loud, with a retry: an empty list that
    /// really means "nobody" and one that means "could not ask" must not look
    /// the same.
    private func load() async {
        failed = false
        let id = serverId
        async let friendsResult = try? session.api.friends()
        async let membersResult: [ServerMember]? = {
            guard let id else { return [] }
            return try? await session.api.members(serverId: id)
        }()
        let (friendsResponse, memberList) = await (friendsResult, membersResult)
        if let friendsResponse {
            friends = friendsResponse.friends.map {
                StoryMentionCandidate(id: $0.id, displayName: $0.displayName, handle: nil, avatarUrl: $0.avatarUrl)
            }
        }
        if let memberList {
            members = memberList.map {
                StoryMentionCandidate(id: $0.id, displayName: $0.displayName, handle: nil, avatarUrl: $0.avatarUrl)
            }
        }
        failed = friendsResponse == nil || memberList == nil
        loaded = true
    }
}
