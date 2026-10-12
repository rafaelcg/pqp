import SwiftUI

// The rows of the live channel list (direction A1): 40 pt lines with no card
// behind them, the way the web sidebar draws them. Each piece is its own view
// so the screens that come next (forum channels, the DM bar) can reuse a row
// without inheriting the whole list.

// MARK: - Motion

extension Animation {
    /// The list's one spring: sections folding, people joining a room, a
    /// badge appearing. Nil under Reduce Motion, which SwiftUI reads as "no
    /// animation", so the change lands at once.
    static func channelList(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.86)
    }
}

/// Pressed rows get the raised surface; nothing else does.
struct ChannelRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .fill(configuration.isPressed ? Palette.surfaceRaised : .clear)
            )
            .contentShape(Rectangle())
    }
}

// MARK: - Channel row

struct ChannelRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let channel: Channel
    var mark: ChannelUnreadMark = .none
    var isMuted: Bool = false
    /// Something is being broadcast in this channel right now.
    var isLive: Bool = false
    /// The call this phone is in: lime surface and lime text.
    var isCurrentCall: Bool = false
    /// People in a voice room. Zero draws nothing; the room under it is
    /// dimmer instead.
    var occupantCount: Int = 0

    /// The clapperboard is what the web sidebar draws for a watch party
    /// (`ChannelIcon`); build 21 drew the speaker and nobody could tell them
    /// apart.
    private var glyph: String {
        if channel.isWatchParty { return "movieclapper" }
        // The web's `MessagesSquare`: conversations, not a `#`.
        if channel.isForum { return "bubble.left.and.bubble.right" }
        return channel.isVoice ? "speaker.wave.2" : "number"
    }

    /// An empty voice room is quieter than a room with people in it.
    private var isQuietRoom: Bool { channel.isVoice && occupantCount == 0 && !isCurrentCall }

    private var nameColor: Color {
        if isCurrentCall { return Palette.signal }
        if mark.isUnread { return Palette.paper }
        return isQuietRoom ? Palette.paperMuted.opacity(0.75) : Palette.paperMuted
    }

    var body: some View {
        HStack(spacing: 10) {
            icon
            Text(channel.name)
                .font(.system(size: 16, weight: mark.isUnread || isCurrentCall ? .semibold : .regular))
                .foregroundStyle(nameColor)
                .lineLimit(1)

            if isLive {
                LiveBadge()
                    .accessibilityIdentifier("channels.live")
            }

            Spacer(minLength: 8)

            trailing
        }
        .padding(.horizontal, 10)
        .frame(height: 40)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                .fill(isCurrentCall ? Palette.signal.opacity(0.16) : .clear)
        )
        .overlay(alignment: .leading) {
            if mark.isUnread {
                // The tick sits on the screen's own edge, outside the list's
                // gutter, the way the web sidebar's pip sits on its border.
                Capsule()
                    .fill(Palette.paper)
                    .frame(width: 5, height: 8)
                    .offset(x: -Metrics.hPadding - 2)
                    .transition(.scale(scale: 0.2).combined(with: .opacity))
            }
        }
        .opacity(isMuted ? 0.4 : 1)
        .animation(.channelList(reduceMotion: reduceMotion), value: mark)
        .accessibilityElement(children: .combine)
        .accessibilityValue(accessibilityValue)
    }

    private var icon: some View {
        Image(systemName: glyph)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(isCurrentCall ? Palette.signal : Palette.paperMuted)
            .frame(width: 22, height: 22)
            .overlay(alignment: .bottomTrailing) {
                if channel.isPrivate {
                    // In the icon's corner rather than loose after the name,
                    // so a long name never pushes it off the row.
                    Image(systemName: "lock.fill")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(Palette.paperMuted)
                        .padding(1.5)
                        .background(Circle().fill(Palette.ink))
                        .offset(x: 4, y: 3)
                        .accessibilityLabel(Text("Private"))
                }
            }
    }

    @ViewBuilder
    private var trailing: some View {
        if isMuted {
            Image(systemName: "bell.slash")
                .font(.system(size: 13))
                .foregroundStyle(Palette.paperMuted)
                .accessibilityLabel(Text("Muted channel"))
        } else if mark.mentions > 0 {
            MentionPill(count: mark.mentions)
                .transition(.scale(scale: 0.4).combined(with: .opacity))
        }
        if isCurrentCall {
            Image(systemName: "chart.bar.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Palette.signal)
                .accessibilityHidden(true)
        } else if channel.isVoice && occupantCount > 0 {
            Text(verbatim: "\(occupantCount)")
                .font(.system(size: 13, weight: .medium).monospacedDigit())
                .foregroundStyle(Palette.paperMuted)
                .accessibilityHidden(true)
        }
    }

    private var accessibilityValue: Text {
        if mark.mentions > 0 { return Text("\(mark.mentions) mentions") }
        if mark.isUnread { return Text("Unread") }
        return Text(verbatim: "")
    }
}

/// The lime "@3". Lime because `UnreadBadge(isMention:)` already is.
struct MentionPill: View {
    let count: Int

    var body: some View {
        Text(verbatim: count > 99 ? "@99+" : "@\(count)")
            .font(.system(size: 12, weight: .bold).monospacedDigit())
            .foregroundStyle(Palette.inkDeep)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(Palette.signal))
    }
}

/// Red, never lime: lime is "the call you are in", red is "on air".
struct LiveBadge: View {
    var body: some View {
        Text("LIVE")
            .font(Typography.label)
            .tracking(0.8)
            .foregroundStyle(Palette.paper)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Palette.danger, in: RoundedRectangle(cornerRadius: 4))
    }
}

// MARK: - Who is in a voice room

/// The people under a voice room: up to three by name, then "+N pessoas".
/// The speaking ring is only ever drawn for the call this phone is in; the
/// roster does not carry `speaking`, see `VoiceOccupancyStore`.
struct VoiceOccupantList: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let participants: [VoiceParticipant]
    var selfUserId: String?
    var speakingPeerIds: Set<String> = []

    var body: some View {
        // Built once per render: the listed lines, the "+N" count and its
        // faces all read this one value.
        let summary = VoiceOccupantSummary(participants)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(summary.listed) { person in
                VoiceOccupantLine(
                    person: person,
                    isSelf: person.userId == selfUserId,
                    isSpeaking: speakingPeerIds.contains(person.peerId)
                )
                .transition(.asymmetric(
                    insertion: .move(edge: .top).combined(with: .opacity),
                    removal: .opacity
                ))
            }
            if summary.overflowCount > 0 {
                overflowLine(summary)
                    .transition(.opacity)
            }
        }
        .padding(.leading, 32)
        .animation(.channelList(reduceMotion: reduceMotion), value: summary.listed.map(\.peerId))
        .animation(.channelList(reduceMotion: reduceMotion), value: summary.overflowCount)
        .animation(.channelList(reduceMotion: reduceMotion), value: speakingPeerIds)
    }

    private func overflowLine(_ summary: VoiceOccupantSummary) -> some View {
        HStack(spacing: 8) {
            HStack(spacing: -6) {
                ForEach(summary.overflowFaces) { person in
                    Avatar(name: person.displayName, seed: person.userId, size: 20, url: person.avatarUrl)
                        .overlay(Circle().strokeBorder(Palette.ink, lineWidth: 1.5))
                }
            }
            Text("+\(summary.overflowCount) people")
                .font(.system(size: 14))
                .foregroundStyle(Palette.paperMuted)
            Spacer(minLength: 0)
        }
        .frame(height: 30)
        .accessibilityElement(children: .combine)
    }
}

struct VoiceOccupantLine: View {
    let person: VoiceParticipant
    let isSelf: Bool
    let isSpeaking: Bool

    var body: some View {
        HStack(spacing: 8) {
            Avatar(
                name: person.displayName, seed: person.userId, size: 20,
                isSpeaking: isSpeaking && !person.serverMuted, url: person.avatarUrl
            )
            HStack(spacing: 4) {
                Text(verbatim: person.displayName)
                    .foregroundStyle(Palette.paperSubtle)
                if isSelf {
                    Text("(that's you)")
                        .foregroundStyle(Palette.paperMuted)
                }
            }
            .font(.system(size: 15))
            .lineLimit(1)
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                if person.sharingScreen {
                    Image(systemName: "display")
                        .accessibilityLabel(Text("Sharing their screen"))
                }
                if person.deafened {
                    Image(systemName: "headphones.slash")
                        .accessibilityLabel(Text("Audio off"))
                } else if person.muted || person.serverMuted {
                    Image(systemName: "mic.slash")
                        .foregroundStyle(person.serverMuted ? Palette.danger : Palette.paperMuted)
                        .accessibilityLabel(Text("Microphone off"))
                }
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Palette.paperMuted)
        }
        .padding(.trailing, 10)
        .frame(height: 30)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Section header

/// TEXT, VOICE or a category. A tap folds it; folded, it says how many
/// channels are inside and whether any of them has something new.
struct ChannelSectionHeader: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let title: String
    let isCollapsed: Bool
    let summary: ChannelSectionSummary
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .rotationEffect(.degrees(isCollapsed ? -90 : 0))
                Text(title.uppercased())
                    .font(Typography.label)
                    .tracking(1.2)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if isCollapsed {
                    Text("\(summary.channelCount) channels")
                        .font(.system(size: 11, weight: .medium))
                        .transition(.opacity)
                    if summary.hasUnread {
                        Circle()
                            .fill(Palette.paper)
                            .frame(width: 6, height: 6)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
            }
            .foregroundStyle(Palette.paperMuted)
            .padding(.horizontal, 4)
            .frame(height: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(.channelList(reduceMotion: reduceMotion), value: isCollapsed)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(isCollapsed ? Text("Collapsed") : Text("Expanded"))
    }
}

// MARK: - Create watch party

/// A plain row at the end of the voice list, for whoever may start a party
/// and only while none is running. Not the dashed box at the top any more.
struct CreateWatchPartyRow: View {
    var isCreating: Bool = false
    let onCreate: () -> Void

    var body: some View {
        Button(action: onCreate) {
            HStack(spacing: 10) {
                Group {
                    if isCreating {
                        ProgressView().controlSize(.small).tint(Palette.paperMuted)
                    } else {
                        Image(systemName: "plus")
                            .font(.system(size: 15, weight: .medium))
                    }
                }
                .frame(width: 22, height: 22)
                Text("Create watch party")
                    .font(.system(size: 16))
                Spacer(minLength: 8)
            }
            .foregroundStyle(Palette.paperMuted)
            .padding(.horizontal, 10)
            .frame(height: 40)
        }
        .buttonStyle(ChannelRowButtonStyle())
        .disabled(isCreating)
        .accessibilityIdentifier("channels.watchPartyCreate")
    }
}
