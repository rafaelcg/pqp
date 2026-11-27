import SwiftUI

/// The durable item of "somebody sent a part" (to the song's starter) and "the
/// starter answered" (to whoever sent it): `GET /api/jam-public/notices`, read at
/// boot, on every reconnect and after every live nudge (`JamPublicStore`). It
/// stays until it is answered, because it is the one thing this person is
/// waiting to hear; there is no timer on it.
///
/// ONE AT A TIME, the newest first, with a count of how many wait behind it
/// (`jamNoticeQueue`). It is drawn over the hub and over whatever is pushed on
/// it (a chat), the way the friend card is, and it is HELD while a jam
/// song or wall is open (the web's "never over a transport": it would sit on the
/// record and play buttons, and on the wall's back button). The wall's row and
/// the starter's own block at the top of the song say the same thing, and the
/// card is there when they leave. The studio is a full screen
/// cover, which this never reaches.
///
/// The main button spends the item and opens the song, where the waiting parts
/// are the first thing on the page. The X spends it without opening.
struct JamTakeNoticeCard: View {
    let queue: JamNoticeQueue
    /// The song opens on the site for this account (no channel of its own to land
    /// in): the button says so, and it is what the tap does.
    var opensOnSite = false
    let onOpen: (JamTakeNotice) -> Void
    let onDismiss: (JamTakeNotice) -> Void

    var body: some View {
        if let notice = queue.card {
            let take = notice.kind == .take
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: take ? "ear.fill" : (notice.kind == .accepted ? "checkmark" : "xmark"))
                    .font(JamFont.text(14, .bold))
                    .foregroundStyle(take ? Palette.inkDeep : Palette.paperMuted)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(take ? Palette.signal : Palette.surfaceRaised))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 8) {
                    Text(verbatim: JamNoticeText.card(notice))
                        .font(JamFont.text(14, .semibold))
                        .foregroundStyle(Palette.paper)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityLabel(Text(verbatim: JamNoticeText.spoken(notice)))
                    if queue.more > 0 {
                        Text("\(queue.more) more after this one.")
                            .font(JamFont.text(12, .semibold))
                            .foregroundStyle(Palette.paperMuted)
                            .accessibilityIdentifier("jam.notice.more")
                    }
                    Button {
                        Haptics.selection()
                        onOpen(notice)
                    } label: {
                        Text(opensOnSite ? "Open on the site" : (take ? "See and answer" : "Open the song"))
                            .font(JamFont.text(14, .bold))
                            .lineLimit(1)
                            .fixedSize()
                            .foregroundStyle(take ? Palette.inkDeep : Palette.paperSubtle)
                            .padding(.horizontal, 16)
                            .frame(minHeight: 44)
                            .background(Capsule().fill(take ? Palette.signal : Palette.surface))
                            .overlay(Capsule().strokeBorder(take ? .clear : Palette.border, lineWidth: 1))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("jam.notice.open")
                }
                Spacer(minLength: 0)
                Button {
                    onDismiss(notice)
                } label: {
                    Image(systemName: "xmark")
                        .font(JamFont.text(13, .bold))
                        .foregroundStyle(Palette.paperMuted)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Dismiss"))
                .accessibilityIdentifier("jam.notice.dismiss")
            }
            .padding(.leading, 12)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .fill(Palette.surfaceRaised)
                    .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .strokeBorder(Palette.border, lineWidth: 1)
            )
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("jam.notice.\(notice.kind.rawValue)")
            .id(notice.id)
            // Said once when it appears (a card that arrives while the person is
            // on the hub is a live frame, and a screen reader hears it).
            .jamAnnounceNow(JamNoticeText.spoken(notice))
        }
    }
}
