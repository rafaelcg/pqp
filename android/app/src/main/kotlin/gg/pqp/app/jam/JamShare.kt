package gg.pqp.app.jam

/*
 * WHAT A SHARED JAM SAYS, and which link goes with it. The web's `jam-share-text.ts` and `jam-share-link.ts`, with the
 * same rules so a friend gets the same message from any client:
 *
 *   needs    the song asks for parts: "Falta baixo nessa. Grava a tua parte:"
 *   open     any part is welcome, none is asked for by name
 *   listen   nothing is missing (complete, or closed): an invitation to listen
 *
 * The message never carries a "made with" line: it is the person's own message to their own people, and the link at
 * its end is the only mention of pqp. The link is ALWAYS the song's PUBLIC page (`jam.pqp.gg/m/<id>?ref=share`), which
 * anybody can open with no account, and only for a song that really has one (`offered`): a private channel song keeps
 * the app's own link, which a stranger cannot open and which therefore is not what a share hands out.
 */
object JamShare {
    enum class Kind { Needs, Open, Listen }

    /** What the sender already sent that waits for the song's starter: the song is heard WITHOUT it, so a share must not ask for it. */
    fun pendingOf(tracks: List<JamTrack>, viewerId: String?, isStarter: Boolean): List<JamInstrument> {
        if (viewerId == null || isStarter) return emptyList()
        return tracks.filter { it.authorId == viewerId && !it.inMix }.map { it.instrument }.distinct()
    }

    /**
     * WHAT A SONG STILL NEEDS: the ONE rule. The instruments the song asks for, minus those already in the band, minus
     * the ones the person sent that wait for the starter. An open or closed song names nothing.
     */
    fun stillNeeds(song: JamSongSummary, pending: List<JamInstrument> = emptyList()): List<JamInstrument> {
        if (song.joinMode != JamJoinMode.Wanted) return emptyList()
        return song.wantedInstruments.filter { it !in pending && it !in song.instruments }
    }

    fun kind(joinMode: JamJoinMode, needs: List<JamInstrument>): Kind = when {
        joinMode == JamJoinMode.Closed -> Kind.Listen
        needs.isNotEmpty() -> Kind.Needs
        joinMode == JamJoinMode.Open -> Kind.Open
        else -> Kind.Listen
    }

    /**
     * Whether a song has a public page a stranger can open: public jam is on for this account, the song's publication
     * is `live` (a song that waits for review, was hidden or unpublished has no page that opens), and it has a channel
     * (this is a channel's song; a standalone one is not reachable on a phone). Anything else keeps today's link.
     */
    fun offered(publicEnabled: Boolean, publicationStatus: String?, channelId: String?): Boolean =
        publicEnabled && publicationStatus == "live" && !channelId.isNullOrBlank()

    /**
     * The song's public address, with `ref=share` so a sign-up that comes out of it is its own row in the acquisition
     * report: `jam.pqp.gg/m/<id>` on the hosted instance, `<origin>/jam/m/<id>` anywhere else (a self-host, a preview).
     */
    fun publicLink(appUrl: String, songId: String): String {
        val origin = appUrl.trimEnd('/')
        val host = origin.substringAfter("://").substringBefore('/').substringBefore(':').lowercase()
        val base = if (host == "pqp.gg" || host == "www.pqp.gg") "https://jam.pqp.gg/m/$songId" else "$origin/jam/m/$songId"
        return "$base?ref=$REF"
    }

    const val REF = "share"
}
