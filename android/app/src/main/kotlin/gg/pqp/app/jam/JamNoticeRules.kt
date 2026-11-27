package gg.pqp.app.jam

/*
 * THE TAKE NOTICES' RULES, PURE: which one card is drawn, where a song link goes, what the starter's answer says it
 * did. None of it touches the network or a view, so each is a test (`JamNoticeRulesTest`). The words and the
 * numbers are the web's (`jam-notice-placement.ts`, `jam-answer-notice.tsx`, `jam-take-notice-cards.tsx`).
 */

/** What is drawn now, given what is waiting: a toast first, otherwise the newest card with a count of those behind it. */
data class JamNoticeQueue(
    val toast: Boolean = false,
    val card: JamTakeNotice? = null,
    val more: Int = 0,
)

object JamNoticeRules {
    /**
     * ONE AT A TIME, and NEVER OVER A TRANSPORT (user test round 3, N-1: notices sat over the record button).
     * [held] is true while a song or the studio is open: nothing is drawn, the cards are durable and the toast keeps
     * its place. The card is drawn IN the flow above the screen (it moves the content down), not floated over it, so
     * it can never cover a control.
     */
    fun queue(notices: List<JamTakeNotice>, toastWaiting: Boolean, held: Boolean): JamNoticeQueue {
        if (held) return JamNoticeQueue()
        if (toastWaiting) return JamNoticeQueue(toast = true)
        return JamNoticeQueue(card = notices.firstOrNull(), more = (notices.size - 1).coerceAtLeast(0))
    }

    /**
     * The takes of one song that wait for its starter, taken out of the inbox, oldest first (the order they arrived
     * in is the order they are answered in).
     */
    fun pending(inbox: List<JamPublicInboxItem>, songId: String): List<JamTrack> =
        inbox.filter { it.songId == songId }.map { it.track }.sortedWith(compareBy<JamTrack> { it.createdAtMs }.thenBy { it.id })

    /** Takes waiting on [songId]: the wall's tile pill. */
    fun waitingCount(inbox: List<JamPublicInboxItem>, songId: String): Int = inbox.count { it.songId == songId }

    /**
     * The waiting parts being heard RIGHT NOW, for the button's label: the take is the one in place of the mix's of its
     * instrument AND something is playing, or is about to (its file is still on its way). After the clip ends, or when
     * playback was refused (a call is live), nothing is "heard": the button says "Ouvir" again and never "Parar".
     */
    fun listening(
        pending: List<JamTrack>,
        auditioning: Map<JamInstrument, String>,
        playing: Boolean,
        playPending: Boolean,
    ): Set<String> =
        if (playing || playPending) pending.filter { auditioning[it.instrument] == it.id }.mapTo(HashSet()) { it.id } else emptySet()

    /** Songs with a take waiting, in the order the inbox lists them, with how many. */
    fun songsWaiting(inbox: List<JamPublicInboxItem>): List<WaitingSong> =
        inbox.groupBy { it.songId }.map { (id, items) -> WaitingSong(id, items.first().songTitle, items.size) }

    data class WaitingSong(val songId: String, val title: String, val count: Int)

    /**
     * A take left the inbox (put in the mix, or removed): the take notice for its song goes with the last one, the way
     * the server empties it, without waiting for the read.
     */
    fun afterDrop(state: JamNoticeState, trackId: String): JamNoticeState {
        val dropped = state.inbox.firstOrNull { it.track.id == trackId } ?: return state
        val inbox = state.inbox.filter { it.track.id != trackId }
        val songDone = inbox.none { it.songId == dropped.songId }
        return state.copy(
            inbox = inbox,
            notices = if (songDone) state.notices.filterNot { it.kind == JamTakeNoticeKind.Take && it.songId == dropped.songId } else state.notices,
        )
    }

    /** The waiting parts of this wall, that is of the songs it holds (the wall asks only for what it can open). */
    fun waitingOn(inbox: List<JamPublicInboxItem>, songs: Collection<String>): List<WaitingSong> =
        songsWaiting(inbox).filter { it.songId in songs }
}

/**
 * What the starter's last answer did, said where they gave it (the web's `jam-answer-notice.tsx`): the part is in, with
 * an undo while the box is up, back in the queue, or declined (no undo: a declined take is deleted and the API has no
 * way to bring it back).
 */
enum class JamAnswerKind { Accepted, Undone, Refused }

data class JamAnswer(
    val kind: JamAnswerKind,
    val trackId: String,
    val instrument: JamInstrument,
    /** The sender, as the starter sees them. Null for an account that is gone. */
    val name: String?,
) {
    /** How long the box stays, and how long "Desfazer" is offered: the button is the point of the box. */
    val lifetimeMs: Long get() = if (kind == JamAnswerKind.Undone) UNDONE_MS else ANSWER_MS

    companion object {
        const val ANSWER_MS = 8_000L
        const val UNDONE_MS = 5_000L
    }
}

/** Where a song's id leads on a phone. */
sealed interface JamSongOpening {
    /** A channel song of a server this account is in: the wall, with the song open. */
    data class InApp(val serverId: String, val channelId: String) : JamSongOpening

    /**
     * A public song the phone has no screen for (a standalone public jam, or somebody else's channel song the sender
     * can only reach through its public page): the web opens it.
     */
    data object Web : JamSongOpening

    /** The server says there is no such song (or this account may not see it). */
    data object Gone : JamSongOpening

    /** Nobody knows (no network, a server error): say so, change nothing. */
    data object Failed : JamSongOpening

    companion object {
        /**
         * [place] is what `GET /api/jam-songs/:id` said, [status] the HTTP status when it said no. [isMember] answers
         * for a server id: a song of a server this account is not in cannot be opened as a wall (it would be a dead
         * screen), exactly as a card in chat for such a song is not.
         */
        fun of(place: JamSongPlace.Place?, status: Int?, isMember: (String) -> Boolean): JamSongOpening {
            if (place == null) return if (status == 404) Gone else Failed
            val server = place.serverId
            val channel = place.channelId
            return if (server != null && channel != null && isMember(server)) InApp(server, channel) else Web
        }
    }
}

/** The web's address for a song id, which the browser opens for a signed-in person (`/app/jam/<id>`). */
fun jamPublicSongAppLink(baseUrl: String, songId: String): String = "${baseUrl.trimEnd('/')}/app/jam/$songId"
