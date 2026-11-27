package gg.pqp.app.jam

/*
 * "OUVIR COM A BANDA", PURE: a waiting part is heard in place of the mix's part of its instrument, and playback starts only
 * when THAT part's own file is decoded (a part heard without the very part that was asked for is the wrong answer to the tap).
 *
 * The wish to start is kept PER TAKE, by id. Two taps on two parts while their files are on the way are two wishes, and
 * stopping one is not stopping the other.
 */
object JamListen {
    /** What to do with the wishes now, and what is left of them. */
    data class Step(
        /** The takes still waiting for their file. */
        val pending: Set<String>,
        /** Start playing now: every wished take is decoded and the song's band is ready. */
        val play: Boolean,
        /** A wished take could not be decoded on this phone: it is told, and its wish is dropped. */
        val failed: Boolean,
    )

    /**
     * Resolve the wishes against what is decoded. A wish whose stem is [JamStemStatus.Ready] is done, one that is
     * [JamStemStatus.Unplayable] is dropped with a failure, one still loading (or unknown) waits. Nothing starts while any
     * wish waits, or while the band as a whole is not ready; already playing, nothing starts a second time.
     */
    fun resolve(pending: Set<String>, stems: Map<String, JamStemStatus>, songReady: Boolean, playing: Boolean): Step {
        if (pending.isEmpty()) return Step(emptySet(), play = false, failed = false)
        val failed = pending.filter { stems[it] == JamStemStatus.Unplayable }.toSet()
        val live = pending - failed
        val waiting = live.filter { stems[it] != JamStemStatus.Ready }.toSet()
        if (waiting.isNotEmpty() || (live.isNotEmpty() && !songReady && !playing)) {
            return Step(live, play = false, failed = failed.isNotEmpty())
        }
        return Step(emptySet(), play = live.isNotEmpty() && !playing, failed = failed.isNotEmpty())
    }

    /** A new wish for [trackId]: another take of the SAME instrument is no longer the chosen one, so its wish goes. */
    fun wish(pending: Set<String>, trackId: String, instrument: JamInstrument, instrumentOf: (String) -> JamInstrument?): Set<String> =
        pending.filterNot { it != trackId && instrumentOf(it) == instrument }.toSet() + trackId

    /** Stopping the audition of [instrument] drops the wishes of THAT instrument's takes and nobody else's. */
    fun stopped(pending: Set<String>, instrument: JamInstrument, instrumentOf: (String) -> JamInstrument?): Set<String> =
        pending.filterNot { instrumentOf(it) == instrument }.toSet()
}
