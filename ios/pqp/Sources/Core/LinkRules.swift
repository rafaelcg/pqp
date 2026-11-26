import Foundation

/// Where a plain channel link (`/app/server/<s>/channel/<c>`) lands, by what
/// the channel turned out to be. Pure, so the table can be read and tested
/// without a navigation stack.
///
/// The web opens every channel type it can draw; this opens the ones the phone
/// can: a text channel's chat, a forum's list, a jam's wall. Anything else (a
/// voice room, a watch party) lands on the server's channel list rather than
/// nowhere, which is where Android leaves it too.
///
/// This is also the list the universal-link file has to stay inside: a path the
/// app is asked to open must be one it opens. The plain channel path is NOT in
/// `apple-app-site-association` because this table has a `.serverOnly` row;
/// the jam song path is, because it has none.
enum ChannelLinkLanding: Equatable {
    case chat
    case forum
    case jamWall
    case serverOnly

    static func landing(for channel: Channel) -> ChannelLinkLanding {
        if channel.isText { return .chat }
        if channel.isForum { return .forum }
        if channel.isJam { return .jamWall }
        return .serverOnly
    }
}

/// When the shell's "Can't open that link" alert may be on screen.
///
/// A link tapped before the person is in the app (at the age question, or in
/// the first-run wizard) is held by the session and followed as soon as the
/// shell exists, behind the wizard, exactly like an invite is held until there
/// is somebody to join it. Every kind of link works like that, and the ones
/// that land do so silently under the wizard, so the person arrives where the
/// link pointed when the wizard closes. A link that cannot land (a song in a
/// server a brand-new account is not in, which is the usual case) used to raise
/// its alert over "How should people see you?". Its sentence now waits for the
/// wizard to close and is said over the hub.
enum LinkAlertRules {
    static func isPresented(linkError: String?, firstRunIsUp: Bool) -> Bool {
        linkError != nil && !firstRunIsUp
    }
}
