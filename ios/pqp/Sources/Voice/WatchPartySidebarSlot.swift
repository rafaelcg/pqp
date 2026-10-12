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
   microphone prompt. Unless the party is this account's own, see below.
 - `.pending`: this account's own draft/scheduled party, so the control that
   would otherwise say "Create watch party" instead becomes the way back
   into the one already started.

 WHAT A TAP DOES IS NOT DECIDED HERE. `onOpen` hands the whole party up and
 the caller asks `watchPartyCardTap`: a host or co-host lands on the channel
 with the setup card on its stage, everybody else on the seatless picture.
 Neither takes a seat.
 - `.canHost`: nothing here. The list draws `CreateWatchPartyRow` at the
   end of the voice rooms instead: a single row that reads as an action, not
   a channel type (build 21's "watch party shows as a regular voice channel"
   bug, see `ChannelListView`'s own doc).
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
    let onOpen: (WatchPartyPayload) -> Void

    var body: some View {
        switch state {
        case .none:
            EmptyView()
        case .live(let party):
            liveCard(party)
        case .pending(let party):
            pendingCard(party)
        case .canHost:
            // Drawn by the list itself, as a plain row at the end of the voice
            // rooms (`CreateWatchPartyRow`). Kept as a case so the decision
            // stays in one place, `resolveServerWatchPartyListState`.
            EmptyView()
        }
    }

    // MARK: - Live

    /// One red card above everything: a party is an event, and on the night it
    /// matters it is the reason the app is open.
    private func liveCard(_ party: WatchPartyPayload) -> some View {
        Button {
            onOpen(party)
        } label: {
            HStack(spacing: 12) {
                poster(party)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: party.name)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Palette.paper)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        Avatar(name: party.hostDisplayName, seed: party.hostUserId, size: 16, url: party.hostAvatarUrl)
                        Text("\(party.hostDisplayName) streaming")
                            .lineLimit(1)
                        if let count = watching[party.channelId] {
                            watchingCount(count)
                        }
                    }
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                }
                Spacer(minLength: 4)
                Text("Watch")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Palette.paper)
                    .padding(.horizontal, 12)
                    .frame(height: 30)
                    .background(Capsule().fill(Palette.danger))
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .fill(Palette.danger.opacity(0.1))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .strokeBorder(Palette.danger.opacity(0.45), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("channels.watchPartyLive")
    }

    /// No frame of the film is known here, so the poster is the room's hue
    /// with the clapperboard, and the red "LIVE" pill on its corner.
    private func poster(_ party: WatchPartyPayload) -> some View {
        let hue = Avatar.hue(seed: party.channelId)
        return ZStack {
            LinearGradient(
                colors: [
                    Color(hue: hue, saturation: 0.5, brightness: 0.55),
                    Color(hue: hue, saturation: 0.6, brightness: 0.22),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Image(systemName: "movieclapper.fill")
                .font(.system(size: 18))
                .foregroundStyle(Palette.paper.opacity(0.85))
        }
        .frame(width: 76, height: 48)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(alignment: .topLeading) { livePill.padding(4) }
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
            onOpen(party)
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

}
