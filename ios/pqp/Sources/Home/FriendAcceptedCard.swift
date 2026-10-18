import SwiftUI

/// "Tu e Bia agora são amigos · Mandar um oi".
///
/// A friendship is the moment somebody is most likely to write, and before this
/// the phone ended it on a line in the Friends screen with no way into a
/// conversation. The web has had the card since Conversas
/// (`friend-accepted-toast.tsx`): one card, gone after twelve seconds or on its
/// X, and the button opens (or reuses) the conversation. Who counts as new is
/// `FriendsDigest.newlyAccepted`: only people who said yes to a request THIS
/// account sent, never somebody this account accepted itself.
struct FriendAcceptedCard: View {
    let friend: Friend
    let onSayHi: () -> Void
    let onDismiss: () -> Void

    /// Long enough to read and reach; it is an offer, not a notice that must be
    /// seen.
    static let visibleFor: Duration = .seconds(12)

    var body: some View {
        HStack(spacing: 12) {
            Avatar(name: friend.displayName, seed: friend.id, size: 40, url: friend.avatarUrl)
            VStack(alignment: .leading, spacing: 8) {
                Text("You and \(friend.displayName) are friends now")
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: onSayHi) {
                    HStack(spacing: 6) {
                        Image(systemName: "hand.wave.fill")
                            .font(.system(size: 13, weight: .semibold))
                        // A dotted key of its own: the web's "Mandar um oi" is not
                        // the empty state's "Dizer oi", and one English "Say hi"
                        // cannot carry both.
                        Text("friend.accepted.cta")
                            .font(.system(size: 14, weight: .bold))
                    }
                    .foregroundStyle(Palette.inkDeep)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 36)
                    .background(Capsule().fill(Palette.signal))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("friend.accepted.sayHi")
            }
            Spacer(minLength: 0)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Palette.paperMuted)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Dismiss"))
            .accessibilityIdentifier("friend.accepted.dismiss")
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
        .accessibilityIdentifier("friend.accepted")
        // Gone by itself after twelve seconds. Keyed on the friend, so a second
        // acceptance restarts the clock instead of inheriting the first's.
        .task(id: friend.id) {
            try? await Task.sleep(for: Self.visibleFor)
            guard !Task.isCancelled else { return }
            onDismiss()
        }
    }
}
