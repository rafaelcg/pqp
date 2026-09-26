package gg.pqp.app.watch

/**
 * What a `watch_party` channel draws at the top of a server's channel list,
 * decided in one pure place. Mirrors the web sidebar's contract
 * (`client/src/components/watch-party/live-party-block.tsx`, whose own doc
 * calls the empty branch "NOTHING, OR ONE BUTTON"): before this, the channel
 * showed up as an ordinary row whatever its state, and opening it with
 * nothing live landed on the audience's idle "nobody is streaming" card --
 * exactly the complaint this closes ("I was expecting to either only see a
 * watch party if there's one on or as an owner to host one").
 *
 * Four states, one per channel:
 *
 * 1. A party is LIVE: [Live], a card that opens the channel to watch it.
 * 2. No live party, but this account is running a draft or scheduled one:
 *    [Pending], a card back to the setup it already started.
 * 3. No party at all, and this account may start one: [Host], a single
 *    button-looking row that opens the channel straight onto its own
 *    hosting controls (see [gg.pqp.app.ui.PqpApp]'s `ChatRoute` handling of
 *    `isServerOwner`).
 * 4. No party and no permission: `null`. The channel draws nothing at all --
 *    no heading, no row, no placeholder.
 */
sealed interface WatchPartyListEntry {
    val channelId: String
    val channelName: String

    data class Live(
        override val channelId: String,
        override val channelName: String,
        val partyName: String,
        val hostDisplayName: String,
        /** Seatless watchers, straight off `watch.channels`. Null: no signal yet, show no number. */
        val watching: Int?,
    ) : WatchPartyListEntry

    data class Pending(
        override val channelId: String,
        override val channelName: String,
        val partyName: String,
        val scheduled: Boolean,
    ) : WatchPartyListEntry

    data class Host(
        override val channelId: String,
        override val channelName: String,
    ) : WatchPartyListEntry
}

/**
 * [WatchPartyListEntry] for one `watch_party` channel, or null for state 4.
 *
 * [isOwner]: the one signal this client has for "may start a watch party"
 * that does not require having already joined the channel's room first. The
 * web asks `Permission.START_WATCH_PARTY`, a bit this app has never modelled
 * outside of `welcome.canStream`, itself only known once a room is actually
 * joined (`WatchPartyHostGate.kt`'s own doc explains why). Server ownership
 * is a safe floor here: an owner always holds every permission, so this
 * never offers the row to somebody the server would refuse, and it is the
 * literal case Rafael asked for -- "as an owner to host one". A non-owner
 * holding START_WATCH_PARTY through a role still gets the on-stage create
 * button the moment they open the channel and join its room; only this list
 * row is narrower than the web's, until Android carries real permission
 * bits. Callers pass `isOwner && serverWatchPartyEnabled` (the same
 * `GET /api/live-hls/config` answer `WatchPartyHostGate.kt` reads), so a
 * server with the feature off never draws a button that goes nowhere.
 *
 * A [party] that is `ended` or `cancelled` reads the same as [Host] would,
 * EXCEPT it does not offer one: it is still the row until the next
 * `watch-party-update` clears it with `party: null`, mirroring the same
 * deliberate gap `watchPartyHostGate`'s own test documents ("an ended party
 * frees the host to create the next one" only once the frame arrives). So a
 * terminal party is neither [Live] nor [Pending] nor [Host] -- it is simply
 * absent from the list until the server says so, same as the on-stage
 * "Criar watch party" button in that window.
 */
fun watchPartyListEntry(
    channelId: String,
    channelName: String,
    party: WatchPartyPayload?,
    watching: Int?,
    isOwner: Boolean,
): WatchPartyListEntry? {
    if (party != null) {
        if (party.isLive) {
            return WatchPartyListEntry.Live(
                channelId = channelId,
                channelName = channelName,
                partyName = party.name,
                hostDisplayName = party.hostDisplayName,
                watching = watching,
            )
        }
        val mine = party.isPreLive && (party.viewerRole == "host" || party.viewerRole == "cohost")
        return if (mine) {
            WatchPartyListEntry.Pending(
                channelId = channelId,
                channelName = channelName,
                partyName = party.name,
                scheduled = party.state == "scheduled",
            )
        } else {
            null
        }
    }
    return if (isOwner) WatchPartyListEntry.Host(channelId, channelName) else null
}

/**
 * What the channel list actually draws, out of every `watch_party` channel's
 * own [watchPartyListEntry] on this server.
 *
 * Live parties are drawn together -- a server can run more than one, "usually
 * exactly one" per the web block's own doc. Short of that, at most ONE
 * pending or host row, by channel order (`channels` is already position-
 * sorted by the time this reads it): multiple idle `watch_party` channels on
 * one server is not a case either client's sidebar designs for, so this picks
 * the first rather than stacking several identical buttons.
 */
sealed interface WatchPartyListBlock {
    data class Live(val parties: List<WatchPartyListEntry.Live>) : WatchPartyListBlock
    data class Pending(val entry: WatchPartyListEntry.Pending) : WatchPartyListBlock
    data class Host(val entry: WatchPartyListEntry.Host) : WatchPartyListBlock
    data object None : WatchPartyListBlock
}

fun watchPartyListBlock(entries: List<WatchPartyListEntry?>): WatchPartyListBlock {
    val present = entries.filterNotNull()
    val live = present.filterIsInstance<WatchPartyListEntry.Live>()
    if (live.isNotEmpty()) return WatchPartyListBlock.Live(live)
    present.filterIsInstance<WatchPartyListEntry.Pending>().firstOrNull()?.let {
        return WatchPartyListBlock.Pending(it)
    }
    present.filterIsInstance<WatchPartyListEntry.Host>().firstOrNull()?.let {
        return WatchPartyListBlock.Host(it)
    }
    return WatchPartyListBlock.None
}
