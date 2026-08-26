package gg.pqp.app.push

/**
 * Where a notification, or a `pqp://` link, wants the app to go.
 *
 * The vocabulary is the web client's routes, not a mobile one, because the
 * server builds exactly one `path` per push and hands the same string to the
 * browser's service worker, to iOS and to here (`buildPushPayload` in
 * `server/src/services/push.ts`). Three clients, one routing vocabulary. This
 * file is the Kotlin half of what `ios/pqp/Sources/Core/DeepLink.swift` does.
 */
sealed interface DeepLinkTarget {
    /** A text channel inside a server. */
    data class Channel(val serverId: String, val channelId: String) : DeepLinkTarget

    /**
     * A DM or a group. `channelId` really is a channel id: a conversation is a
     * `channels` row with `kind` of `dm` or `group`, and `/app/dm/<id>` carries
     * that id, not a separate conversation id.
     */
    data class Conversation(val channelId: String) : DeepLinkTarget

    /** A server with no channel named. */
    data class Server(val serverId: String) : DeepLinkTarget

    /** `pqp://invite/<code>`, which no push produces but the manifest accepts. */
    data class Invite(val code: String) : DeepLinkTarget
}

/**
 * The channel this target is about, or null when it is not about one.
 *
 * Used by [PushPresentation] to answer "is the user already looking at this?",
 * which is the only question that needs a channel id out of a target.
 */
val DeepLinkTarget.channelId: String?
    get() = when (this) {
        is DeepLinkTarget.Channel -> channelId
        is DeepLinkTarget.Conversation -> channelId
        is DeepLinkTarget.Server, is DeepLinkTarget.Invite -> null
    }

object DeepLink {

    /**
     * Parse a server-supplied path into a target, or null if it is not one.
     *
     * THE POINT OF PARSING RATHER THAN LOOKING UP. Everything needed to route
     * is in the string: `/app/server/<sid>/channel/<cid>` carries the server as
     * well as the channel. Resolving the server by searching a channel list the
     * app happens to hold is the bug the web client shipped and fixed in #79,
     * that list only ever contains the *selected* server, so a frame from
     * anywhere else resolved to null, and the notification lost its route, its
     * title and its mute. Nothing here consults app state, which is also why it
     * works from `FirebaseMessagingService` with no session in the process.
     *
     * Accepts an absolute URL (`https://pqp.gg/app/...`), a root-relative path,
     * or a `pqp://` link, because the same parser serves notification taps and
     * the manifest's VIEW intent.
     */
    fun target(path: String?): DeepLinkTarget? {
        val raw = path?.trim().orEmpty()
        if (raw.isEmpty()) return null

        // `pqp://invite/CODE` has its code in the *authority*, not the path, so
        // it is matched before anything splits on slashes.
        pqpScheme(raw)?.let { return it }

        val segments = pathSegments(raw)
        if (segments.isEmpty()) return null

        if (segments[0] == "invite" && segments.size >= 2) {
            return if (isUsableCode(segments[1])) DeepLinkTarget.Invite(segments[1]) else null
        }
        if (segments[0] != "app") return null

        return when {
            segments.size >= 5 &&
                segments[1] == "server" &&
                segments[3] == "channel" ->
                DeepLinkTarget.Channel(segments[2], segments[4])

            segments.size >= 3 && segments[1] == "server" ->
                DeepLinkTarget.Server(segments[2])

            segments.size >= 3 && segments[1] == "dm" ->
                DeepLinkTarget.Conversation(segments[2])

            else -> null
        }
    }

    private fun pqpScheme(raw: String): DeepLinkTarget? {
        if (!raw.startsWith(PQP_SCHEME)) return null
        val rest = raw.removePrefix(PQP_SCHEME).trim('/')
        if (rest.isEmpty()) return null
        val parts = rest.split('/').filter { it.isNotEmpty() }
        return when {
            parts.size >= 2 && parts[0] == "invite" && isUsableCode(parts[1]) ->
                DeepLinkTarget.Invite(parts[1])
            else -> null
        }
    }

    /**
     * What an invite code may contain, before it is put in a URL path.
     *
     * Any app on the phone can fire a `pqp://` intent at this activity, so the
     * segment that becomes `POST /api/invites/<code>/join` is checked here
     * rather than trusted. The generator makes short alphanumeric codes
     * (`server/src/services/invites.ts`); the cap is generous rather than
     * exact, which is the same call `ios/pqp/Sources/Core/DeepLink.swift`
     * makes. The Swift twin of this function.
     */
    private fun isUsableCode(code: String): Boolean =
        code.length in 1..64 && code.all { it.isLetterOrDigit() || it == '-' || it == '_' }

    /**
     * The path, minus scheme, host, query and fragment, split on `/`.
     *
     * Hand-rolled rather than `Uri.parse`, because this runs in unit tests on a
     * plain JVM where `android.net.Uri` is an unimplemented stub that returns
     * null for everything. The grammar being parsed is four fixed shapes, not
     * RFC 3986.
     */
    private fun pathSegments(raw: String): List<String> {
        var value = raw
        val schemeEnd = value.indexOf("://")
        if (schemeEnd >= 0) {
            val afterScheme = value.substring(schemeEnd + 3)
            val slash = afterScheme.indexOf('/')
            value = if (slash < 0) "" else afterScheme.substring(slash)
        }
        value = value.substringBefore('?').substringBefore('#')
        return value.split('/').filter { it.isNotEmpty() }
    }

    private const val PQP_SCHEME = "pqp://"
}
