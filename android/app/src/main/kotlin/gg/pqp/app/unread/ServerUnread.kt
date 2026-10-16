package gg.pqp.app.unread

import android.os.SystemClock
import gg.pqp.app.core.ServerSummary
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.ui.screens.channels.ChannelUnread
import gg.pqp.app.ui.screens.channels.mutedChannelIds
import gg.pqp.app.ui.screens.channels.serverUnread
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/**
 * What one server's channels hold that this person has not read: the sum of the
 * per-channel unread of `GET /api/servers/:id/unread`, with muted channels left
 * out, which is what the web rail shows on a server it is not looking at.
 */
data class ServerUnreadSummary(val count: Int = 0, val mentions: Int = 0) {
    val hasUnread: Boolean get() = count > 0 || mentions > 0
}

object ServerUnreadRules {

    /** The most servers read in one pass, the web rail's cap. */
    const val MAX_SERVERS = 30

    /** Two requests at a time, the web rail's pace. */
    const val PARALLELISM = 2

    /** How soon the list reads again without being told something changed. */
    const val REFRESH_AFTER_MS = 30_000L

    /**
     * One server's number. A muted channel counts for nothing, mentions
     * included, and a channel with a mention but no count still counts (a forum
     * can carry one).
     */
    fun summarize(channels: Collection<ChannelUnread>, mutedChannels: Set<String>): ServerUnreadSummary {
        val live = channels.filter { it.channelId !in mutedChannels }
        return ServerUnreadSummary(
            count = live.sumOf { it.count.coerceAtLeast(0) },
            mentions = live.sumOf { it.mentions.coerceAtLeast(0) },
        )
    }

    /**
     * Which servers a pass reads: in list order, a server muted as a whole is
     * skipped (it badges nothing), and no more than [MAX_SERVERS].
     */
    fun targets(servers: List<ServerSummary>, mutedServers: Set<String>): List<String> =
        servers.map { it.id }.filterNot { it in mutedServers }.take(MAX_SERVERS)

    /** `servers` map of the stored notification levels: only `none` silences a server. */
    fun mutedServerIds(levels: Map<String, String>?): Set<String> =
        levels.orEmpty().filterValues { it == "none" }.keys

    /** A `channel-activity` frame on top of a summary: one more, and one more mention when it was one. */
    fun bumped(existing: ServerUnreadSummary?, mention: Boolean): ServerUnreadSummary = ServerUnreadSummary(
        count = (existing?.count ?: 0) + 1,
        mentions = (existing?.mentions ?: 0) + if (mention) 1 else 0,
    )
}

/**
 * Channel unread for every server on the server list.
 *
 * The list only knew the Baú's count; a server with unread messages looked the
 * same as a quiet one until it was opened. There is no all-servers endpoint, so
 * this reads `/unread` per server (two at a time, thirty at most, muted servers
 * skipped) the way the web rail does after load, and live `channel-activity`
 * frames add to the number between reads.
 *
 * WHEN IT READS. When the list comes back to the front, at most every
 * [ServerUnreadRules.REFRESH_AFTER_MS], and at once for a server somebody just
 * read a channel of ([markStale]): the moment it is most wrong is coming back
 * from that server, which stamped itself read while the list sat behind it.
 * A failed read keeps what was on screen: a badge one behind beats one that
 * flickers away.
 */
class ServerUnreadStore(
    private val scope: CoroutineScope,
    private val readServer: suspend (String) -> Collection<ChannelUnread>,
    /** The muted channel and server sets, asked for at each pass and frame. */
    private val muted: () -> Pair<Set<String>, Set<String>>,
    /** Who is signed in: another account must not see this one's badges. */
    private val userId: () -> String? = { null },
    private val now: () -> Long = SystemClock::elapsedRealtime,
) {
    private val _unread = MutableStateFlow<Map<String, ServerUnreadSummary>>(emptyMap())
    val unread: StateFlow<Map<String, ServerUnreadSummary>> = _unread.asStateFlow()

    private val lock = Any()
    private var lastPassAt: Long? = null
    private val stale = HashSet<String>()

    /** Bumped by [clear]: a read that started before it must not write after it. */
    private var epoch = 0

    /** Two requests at a time across EVERY pass: overlapping passes share the budget. */
    private val gate = Semaphore(ServerUnreadRules.PARALLELISM)

    /** The newest read started for a server: an older one that lands after it is dropped. */
    private val readSeq = HashMap<String, Int>()

    /** Servers with a read out right now, and those asked for again meanwhile. */
    private val inFlight = HashSet<String>()
    private val askedAgain = HashSet<String>()

    /** Whose servers these are; another account starts from nothing. */
    private var account: String? = null

    /** Frames since a server was last read, so a pass in flight cannot erase them. */
    private val generation = HashMap<String, Int>()

    /** Somebody read (or may have read) something in [serverId]: read it again at the next pass. */
    fun markStale(serverId: String) {
        synchronized(lock) { stale += serverId }
    }

    /**
     * Read the servers that need it. [force] ignores the interval (pull to
     * refresh); a stale server is read whatever the interval says.
     */
    fun hydrate(servers: List<ServerSummary>, force: Boolean = false) {
        val signedIn = userId()
        if (account != null && signedIn != account) {
            // A different account: nothing of the last one's badges may show.
            clear()
        }
        account = signedIn
        val (_, mutedServers) = muted()
        val wanted = ServerUnreadRules.targets(servers, mutedServers)
        // Forget servers the account left, and the muted ones: they badge nothing. The
        // thirty-server cap limits what is READ, not what is kept: a live frame for the
        // thirty-first still shows. Done on every call (a mute or a server change must
        // show even when no read is due), and under the lock live frames take, so a frame
        // that lands meanwhile is never overwritten by an older snapshot of the map.
        val kept = servers.map { it.id }.filterNot { it in mutedServers }.toSet()
        synchronized(lock) { _unread.value = _unread.value.filterKeys { it in kept } }
        val toRead = synchronized(lock) {
            val last = lastPassAt
            val due = force || last == null || now() - last >= ServerUnreadRules.REFRESH_AFTER_MS
            val picked = if (due) wanted else wanted.filter { it in stale }
            if (picked.isEmpty()) return
            if (due) lastPassAt = now()
            stale -= picked.toSet()
            picked
        }
        // A pass is never cancelled by the next one: a small "read this server
        // again" must not cut a full pass short and leave its servers unread
        // until the interval comes round.
        scope.launch {
            toRead.map { serverId ->
                async { readServerOnce(serverId) }
            }.awaitAll()
        }
    }

    /**
     * ONE READ PER SERVER AT A TIME. A server asked for while a read of it is out (a full pass
     * still running, then somebody reads a channel and comes back) is not read in parallel: the
     * ask is remembered and read once more the moment the first lands, so the answer that
     * counts is always the one that left LAST and repeated returns cannot pile requests up.
     */
    private suspend fun readServerOnce(serverId: String) {
        val mine = synchronized(lock) {
            if (!inFlight.add(serverId)) {
                askedAgain += serverId
                false
            } else {
                true
            }
        }
        if (!mine) return
        var done = false
        try {
            while (!done) {
                synchronized(lock) { askedAgain -= serverId }
                gate.withPermit { readOne(serverId) }
                // Decided and released in ONE step: an ask that lands between "nothing is
                // waiting" and "no longer in flight" would otherwise be wiped with the cleanup.
                done = synchronized(lock) {
                    if (serverId in askedAgain) {
                        false
                    } else {
                        inFlight -= serverId
                        true
                    }
                }
            }
        } finally {
            // Only reached with `done` false on a failure or a cancellation.
            if (!done) {
                synchronized(lock) {
                    inFlight -= serverId
                    askedAgain -= serverId
                }
            }
        }
    }

    private suspend fun readOne(serverId: String) {
        val (before, startedIn, mySeq) = synchronized(lock) {
            val seq = (readSeq[serverId] ?: 0) + 1
            readSeq[serverId] = seq
            Triple(generation[serverId] ?: 0, epoch, seq)
        }
        val channels = try {
            readServer(serverId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Asked again next time: a stale badge beats none.
            synchronized(lock) { stale += serverId }
            return
        }
        val summary = ServerUnreadRules.summarize(channels, muted().first)
        synchronized(lock) {
            if (epoch != startedIn) return
            // A newer read of this server started after this one: it will land with the
            // truth, and this answer is older than what it was asked about.
            if (readSeq[serverId] != mySeq) return
            // A frame that landed while the request was out may or may not be in
            // its answer; the larger of the two never loses one, and the next pass
            // (nothing in flight) settles it, the way the channel list does.
            val frames = generation[serverId] ?: 0
            val merged = if (frames != before) {
                val current = _unread.value[serverId]
                ServerUnreadSummary(
                    count = maxOf(summary.count, current?.count ?: 0),
                    mentions = maxOf(summary.mentions, current?.mentions ?: 0),
                )
            } else {
                summary
            }
            if (frames != before) stale += serverId
            _unread.value = if (merged.hasUnread) {
                _unread.value + (serverId to merged)
            } else {
                _unread.value - serverId
            }
        }
    }

    /** A live `channel-activity` frame for a server channel. */
    fun bump(serverId: String, channelId: String, mention: Boolean) {
        val (mutedChannels, mutedServers) = muted()
        if (channelId in mutedChannels || serverId in mutedServers) return
        synchronized(lock) {
            generation[serverId] = (generation[serverId] ?: 0) + 1
            _unread.value = _unread.value + (serverId to ServerUnreadRules.bumped(_unread.value[serverId], mention))
        }
    }

    /** Sign-out: nothing of the previous account may show. */
    fun clear() {
        synchronized(lock) {
            epoch += 1
            _unread.value = emptyMap()
            lastPassAt = null
            stale.clear()
            generation.clear()
            readSeq.clear()
            askedAgain.clear()
        }
    }

    companion object {
        @Volatile
        private var instance: ServerUnreadStore? = null

        /** One store per process, built on first use, like [gg.pqp.app.social.SocialRepository]. */
        fun of(session: SessionStore): ServerUnreadStore =
            instance ?: synchronized(this) {
                instance ?: ServerUnreadStore(
                    scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
                    readServer = { serverId -> session.api.serverUnread(serverId).values },
                    muted = {
                        val levels = (session.phase.value as? SessionPhase.Ready)?.me?.preferences?.notifications
                        mutedChannelIds(levels?.channels) to ServerUnreadRules.mutedServerIds(levels?.servers)
                    },
                    userId = { (session.phase.value as? SessionPhase.Ready)?.me?.id },
                ).also { instance = it }
            }
    }
}
