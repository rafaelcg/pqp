import SwiftUI

/**
 The channel list's watch-party slot -- above every other section, exactly
 where the web's `LivePartyBlock` sits (`client/src/components/watch-party/
 live-party-block.tsx`, "ABOVE EVERYTHING"). One of four things, decided
 ahead of time by `resolveServerWatchPartyListState` and handed in as
 `state` so this view has nothing left to decide:

 - `.live`: the party's name, the host's face, a viewer count when one is
   cheaply known, and a red "LIVE" pill. Tapping it opens the channel --
   `WatchStageView` mounts on its own and starts playing; no second tap, no
   microphone prompt.
 - `.pending`: this account's own draft/scheduled party, so the control that
   would otherwise say "Create watch party" instead becomes the way back
   into the one already started.
 - `.canHost`: a single row that reads as an action, not a channel type --
   the whole reason build 21's bug ("watch party shows as a regular voice
   channel", see `ChannelListView`'s own doc) is not simply un-fixed by
   drawing the same row again.
 - `.none`: `EmptyView()`. No heading, no row, no placeholder. Watch parties
   are not part of this account's sidebar until one of the other three is
   true, matching the web's own "NOTHING, OR ONE BUTTON" branch exactly.

 NOT PORTED FROM THE WEB, ON PURPOSE (see the PR description): the waitlist
 teaser for a server where watch parties are off entirely, and the
 "Transmissões anteriores" history link(s) back into an idle channel's past
 broadcasts. Both are reachable follow-ups, not part of this contract fix.
 */
struct WatchPartySidebarSlot: View {
    let state: ServerWatchPartyListState
    /// Viewers watching without a seat, by channel id -- from `channel-live`,
    /// which `ChannelListView` already receives for the plain "LIVE" badge
    /// on an ordinary channel row. Cheap because it costs no extra request:
    /// see that view's own doc on why it is not seeded over REST. A missing
    /// entry draws no count at all, same as the web's `audience?.[id]`
    /// being `undefined` rather than `0`.
    var watching: [String: Int] = [:]
    /// `.canHost`'s row while `createServerWatchParty` is in flight --
    /// disables the row and swaps its icon for a spinner so a slow network
    /// does not read as an unresponsive tap and invite a second one.
    var isCreating: Bool = false
    let onOpen: (String) -> Void
    let onCreate: () -> Void

    var body: some View {
        switch state {
        case .none:
            EmptyView()
        case .live(let party):
            VStack(alignment: .leading, spacing: 4) {
                SectionLabel(text: String(localized: "Watch party"))
                    .padding(.horizontal, 4)
                liveCard(party)
            }
        case .pending(let party):
            pendingCard(party)
        case .canHost:
            createRow
        }
    }

    // MARK: - Live

    private func liveCard(_ party: WatchPartyPayload) -> some View {
        Button {
            onOpen(party.channelId)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 8) {
                    Avatar(name: party.hostDisplayName, seed: party.hostUserId, size: 28, url: party.hostAvatarUrl)
                    Spacer(minLength: 8)
                    livePill
                }
                Text(party.name)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                    .lineLimit(2)
                HStack(spacing: 8) {
                    Text("with \(party.hostDisplayName)")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let count = watching[party.channelId] {
                        watchingCount(count)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .fill(Palette.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .strokeBorder(Palette.danger.opacity(0.45), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("channels.watchPartyLive")
    }

    /// Red, matching `ChannelRow`'s own "LIVE" badge -- the two are the same
    /// fact ("something is being broadcast here") drawn in two places, and
    /// they read as one system only if neither invents its own colour.
    private var livePill: some View {
        Text("LIVE")
            .font(Typography.label)
            .tracking(0.8)
            .foregroundStyle(Palette.paper)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Palette.danger, in: RoundedRectangle(cornerRadius: 4))
    }

    /// The raw number is what is drawn (an eye glyph plus a digit reads at a
    /// glance in a narrow sidebar); accessibility gets the full sentence
    /// instead of the two pieces read separately, same split the web's
    /// `sr-only` span makes for the identical reason. `Text(verbatim:)` for
    /// the visible digit: a bare number is a value, not copy, and the
    /// localisation-coverage build check would otherwise want a catalogue
    /// entry for every count that has ever been drawn.
    private func watchingCount(_ count: Int) -> some View {
        HStack(spacing: 3) {
            Image(systemName: "eye.fill")
            Text(verbatim: "\(count)")
        }
        .font(Typography.caption)
        .foregroundStyle(Palette.paperMuted)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(watchingAccessibilityLabel(count))
    }

    /// Mirrors `WatchStageView.viewerLabel`'s own singular/plural split for
    /// the identical sentence, reusing its two catalogue keys ("1 watching",
    /// "%lld watching") rather than asking the catalogue for a third way to
    /// say the same count.
    private func watchingAccessibilityLabel(_ count: Int) -> String {
        count == 1
            ? String(localized: "1 watching")
            : String(localized: "\(count) watching")
    }

    // MARK: - Pending (this account's own draft/scheduled party)

    private func pendingCard(_ party: WatchPartyPayload) -> some View {
        Button {
            onOpen(party.channelId)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "movieclapper.fill")
                    .foregroundStyle(Palette.warning)
                VStack(alignment: .leading, spacing: 1) {
                    Text(party.name)
                        .font(Typography.bodyMedium)
                        .foregroundStyle(Palette.paper)
                        .lineLimit(1)
                    Text(party.state == "scheduled" ? "Scheduled. Tap to open." : "Being set up. Tap to continue.")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.warning)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .fill(Palette.warning.opacity(0.1))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .strokeBorder(Palette.warning.opacity(0.4), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("channels.watchPartyPending")
    }

    // MARK: - Create

    private var createRow: some View {
        Button(action: onCreate) {
            HStack(spacing: 10) {
                if isCreating {
                    ProgressView().tint(Palette.paperMuted)
                } else {
                    Image(systemName: "movieclapper.fill")
                        .foregroundStyle(Palette.paperMuted)
                }
                Text("Create watch party")
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paperMuted)
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                    .strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            )
        }
        .buttonStyle(.plain)
        .disabled(isCreating)
        .accessibilityIdentifier("channels.watchPartyCreate")
    }
}
