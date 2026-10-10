import SwiftUI

/// A post's text with its `#channel` references drawn as links that open the
/// channel in the app. The grammar and the privacy rule are in
/// `BauChannelRefs`: a channel this account cannot see is a muted, unlinked
/// "#canal-indisponível", never a name.
struct BauBodyText: View {
    let text: String
    let channels: [Channel]
    let onOpenChannel: (Channel) -> Void

    /// An in-app address, never opened by the system: the action below
    /// consumes it, and anything else falls through to the system as before.
    static let scheme = "pqp-channel"

    var body: some View {
        Text(Self.attributed(text, channels: channels))
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme == Self.scheme, let id = url.host?.lowercased(),
                      let channel = channels.first(where: { $0.id.lowercased() == id }) else {
                    return .systemAction
                }
                onOpenChannel(channel)
                return .handled
            })
    }

    static func attributed(_ text: String, channels: [Channel]) -> AttributedString {
        var out = AttributedString()
        for part in BauChannelRefs.parse(text, channels: channels) {
            switch part {
            case .text(let value):
                out += MessageBodyText.attributed(value)
            case .link(let id, let name):
                var link = AttributedString("#\(name)")
                if let url = URL(string: "\(scheme)://\(id.lowercased())") { link.link = url }
                link.foregroundColor = Palette.signal
                link.backgroundColor = Palette.signal.opacity(0.12)
                out += link
            case .unavailable:
                var muted = AttributedString("#" + String(localized: "unavailable-channel"))
                muted.foregroundColor = Palette.paperMuted
                out += muted
            }
        }
        return out
    }
}
