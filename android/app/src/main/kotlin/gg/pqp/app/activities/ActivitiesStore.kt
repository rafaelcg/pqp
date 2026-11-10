package gg.pqp.app.activities

import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.ServerMember
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * What activities are running where, and whether a server has them at all: the
 * one source of truth the channel list, the strip and the screens read
 * (`app-sessions-store.ts` on the web).
 *
 * Fed two ways that must agree. `GET /api/servers/:id/app-sessions` seeds a
 * server when a screen first needs it and after every reconnect (the `/ws`
 * welcome carries none of it, on purpose: a reconnect herd must not fan out per
 * room), and the `channel-app` frame, sent to every socket whose account can
 * VIEW the channel, keeps it right in between. **A frame that lands while a
 * read is in flight wins over that read**, so a slow answer cannot bring back a
 * session that ended meanwhile.
 *
 * Nothing is asked of a server until a screen shows it ([watch]), and nothing
 * is drawn for one whose config says `enabled: false`, so a server without
 * activities looks exactly as it did before they existed.
 */
class ActivitiesStore(
    private val scope: CoroutineScope,
    frames: Flow<JsonObject>,
    realtimeState: Flow<RealtimeState>,
    /** Null when the lookup failed: not "off", just unknown, so the last good answer stays. */
    private val fetchConfig: suspend (serverId: String) -> ActivitiesConfig?,
    private val fetchSessions: suspend (serverId: String) -> List<ChannelSession>,
    private val fetchMembers: suspend (serverId: String) -> List<ServerMember> = { emptyList() },
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _sessions = MutableStateFlow<Map<String, ActivitySession>>(emptyMap())

    /** The live session of each channel that has one, by channel id. */
    val sessions: StateFlow<Map<String, ActivitySession>> = _sessions.asStateFlow()

    private val _configs = MutableStateFlow<Map<String, ActivitiesConfig>>(emptyMap())

    /** What each watched server answered. A server not in the map has not answered yet. */
    val configs: StateFlow<Map<String, ActivitiesConfig>> = _configs.asStateFlow()

    private val _members = MutableStateFlow<Map<String, Map<String, ServerMember>>>(emptyMap())

    /** Server id to (user id to member): who a session's user ids are, for names and faces. */
    val members: StateFlow<Map<String, Map<String, ServerMember>>> = _members.asStateFlow()

    private val _endings = MutableSharedFlow<ActivityFrame.Ended>(extraBufferCapacity = 16)

    /** `app-ended` as it arrives, for a screen that wants to say how it ended. */
    val endings: SharedFlow<ActivityFrame.Ended> = _endings.asSharedFlow()

    private val lock = Any()
    private var seq = 0L
    private val lastFrameSeq = HashMap<String, Long>()
    /** Which server each channel we have heard of belongs to: what lets a read of a server retire ITS sessions. */
    private val channelServer = HashMap<String, String>()
    private val membersLock = Mutex()
    private val watched = LinkedHashSet<String>()
    private val configAt = HashMap<String, Long>()
    private val membersAt = HashMap<String, Long>()
    private val inFlight = HashMap<String, Job>()
    private var wasReady = false
    private var heardState = false

    init {
        scope.launch {
            frames.collect { raw ->
                if (!ActivityFrame.isActivity(raw)) return@collect
                when (val frame = ActivityFrame.decode(raw)) {
                    is ActivityFrame.ChannelApp -> applyChannelApp(frame)
                    is ActivityFrame.Ended -> {
                        // The channel's other viewers hear this too, so the record turns quiet; the channel-app
                        // frame that follows is what clears the strip, but a lost one must not leave it standing.
                        applyEnded(frame)
                        _endings.tryEmit(frame)
                    }
                    else -> Unit
                }
            }
        }
        scope.launch {
            realtimeState.collect { state ->
                val ready = state == RealtimeState.Ready
                // The first state we hear is the app opening, not a reconnect: whatever is watched asked for
                // itself. A later Ready after a gap is a reconnect, and what changed while the socket was down
                // is only in the rows.
                if (heardState && ready && !wasReady) {
                    val servers = synchronized(lock) { watched.toList() }
                    for (serverId in servers) refresh(serverId, force = true)
                }
                heardState = true
                wasReady = ready
            }
        }
    }

    /** The server's activities config, as last read (Off until the first answer). */
    fun config(serverId: String): ActivitiesConfig = _configs.value[serverId] ?: ActivitiesConfig.Off

    /** The live session of [channelId], if any. */
    fun session(channelId: String): ActivitySession? = _sessions.value[channelId]

    /** Ask for what [serverId] needs to draw its activities, once per visit and again after a reconnect. */
    fun watch(serverId: String) {
        synchronized(lock) { watched.add(serverId) }
        refresh(serverId, force = false)
    }

    /**
     * Tells the store which channels belong to [serverId] (a screen that draws them knows). A `channel-app` frame
     * names a channel and never its server, so without this a session that ended while the socket was down, its end
     * frame missed, could not be retired by the read that follows the reconnect.
     */
    fun knowChannels(serverId: String, channelIds: Collection<String>) {
        synchronized(lock) { for (id in channelIds) channelServer[id] = serverId }
    }

    /** A person to draw by user id, when this server's member list holds them. */
    fun memberOf(serverId: String, userId: String?): ServerMember? =
        userId?.let { _members.value[serverId]?.get(it) }

    /**
     * A person to draw, reading the member list again when this one is not on it: somebody who joined the
     * server after the list was read (and walked straight into an activity) must not be drawn as "?". At most
     * once per [MEMBERS_RETRY_MS] per server, so a roster of strangers costs one read and not one each.
     */
    suspend fun resolveMember(serverId: String, userId: String): ServerMember? {
        memberOf(serverId, userId)?.let { return it }
        // One read serves every asker at once: the others wait on the lock, then find the answer (or the window) there.
        membersLock.withLock {
            memberOf(serverId, userId)?.let { return it }
            if (now() - (membersAt[serverId] ?: 0L) >= MEMBERS_RETRY_MS) fetchMembersLocked(serverId)
        }
        return memberOf(serverId, userId)
    }

    /** Reads again now: the screen came back to the front, or a config flag may have flipped. */
    fun refresh(serverId: String, force: Boolean = true) {
        val stale = now() - (configAt[serverId] ?: 0L) > CONFIG_TTL_MS
        if (!force && !stale && _configs.value.containsKey(serverId)) return
        synchronized(lock) {
            inFlight[serverId]?.cancel()
            inFlight[serverId] = scope.launch { read(serverId) }
        }
    }

    private suspend fun read(serverId: String) {
        val startSeq = synchronized(lock) { seq }
        val config = try {
            fetchConfig(serverId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: return // a lookup that did not answer: keep what was known, and ask again at the next chance
        _configs.value = _configs.value + (serverId to config)
        if (!config.enabled) {
            // Off for this server, and that answer is real: nothing of it may stand on screen.
            dropServer(serverId)
            configAt[serverId] = now()
            return
        }
        val rows = try {
            fetchSessions(serverId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: return // the sessions were not read: what is on screen stays, and the server is not marked fresh
        applyRead(serverId, rows, startSeq)
        configAt[serverId] = now()
        // Names are only needed once somebody is in something; a server with nothing running costs no roster.
        if (rows.any { it.session != null }) readMembers(serverId)
    }

    private suspend fun readMembers(serverId: String) {
        membersLock.withLock {
            if (now() - (membersAt[serverId] ?: 0L) < MEMBERS_TTL_MS && _members.value.containsKey(serverId)) return
            fetchMembersLocked(serverId)
        }
    }

    /** Reads the roster; the caller holds [membersLock], so concurrent askers share one read. */
    private suspend fun fetchMembersLocked(serverId: String) {
        val list = try {
            fetchMembers(serverId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            membersAt[serverId] = now() // a failure is not retried in a tight loop either
            return
        }
        membersAt[serverId] = now()
        putMembers(serverId, list)
    }

    /** At most [MEMBERS_SERVERS_KEPT] servers' rosters are held, the least recently read dropped first. */
    private fun putMembers(serverId: String, list: List<ServerMember>) {
        val next = LinkedHashMap(_members.value)
        next.remove(serverId)
        next[serverId] = list.associateBy { it.id }
        while (next.size > MEMBERS_SERVERS_KEPT) next.remove(next.keys.first())
        _members.value = next
    }

    private fun applyRead(serverId: String, rows: List<ChannelSession>, startSeq: Long) {
        synchronized(lock) {
            for (row in rows) channelServer[row.channelId] = serverId
            val next = HashMap(_sessions.value)
            val fresh = rows.mapNotNull { it.session?.let { s -> it.channelId to s } }.toMap()
            for ((channelId, session) in fresh) {
                // a frame that landed while the read was out is newer than the read
                if ((lastFrameSeq[channelId] ?: 0L) > startSeq) continue
                next[channelId] = session
            }
            // The read is the authority for this server's channels: one it does not list is over, however it got here.
            for (channelId in next.keys.toList()) {
                if (channelServer[channelId] != serverId || channelId in fresh) continue
                if ((lastFrameSeq[channelId] ?: 0L) > startSeq) continue
                next.remove(channelId)
            }
            _sessions.value = next
        }
    }

    private fun dropServer(serverId: String) {
        synchronized(lock) {
            val gone = _sessions.value.keys.filter { channelServer[it] == serverId }
            if (gone.isEmpty()) return
            _sessions.value = _sessions.value - gone.toSet()
        }
    }

    private fun applyChannelApp(frame: ActivityFrame.ChannelApp) {
        synchronized(lock) {
            seq += 1
            lastFrameSeq[frame.channelId] = seq
            _sessions.value = if (frame.session == null) {
                _sessions.value - frame.channelId
            } else {
                _sessions.value + (frame.channelId to frame.session)
            }
        }
    }

    private fun applyEnded(frame: ActivityFrame.Ended) {
        synchronized(lock) {
            val current = _sessions.value[frame.channelId] ?: return
            if (current.id != frame.sessionId) return
            seq += 1
            lastFrameSeq[frame.channelId] = seq
            _sessions.value = _sessions.value - frame.channelId
        }
    }

    /** A session this phone just started or just met in a 409: it is live now, whatever the next read says. */
    fun adopt(channelId: String, session: ActivitySession) {
        applyChannelApp(ActivityFrame.ChannelApp(channelId, session))
    }

    /** Sign-out: nothing of the previous account may show. */
    fun clear() {
        synchronized(lock) {
            inFlight.values.forEach { it.cancel() }
            inFlight.clear()
            _sessions.value = emptyMap()
            _configs.value = emptyMap()
            _members.value = emptyMap()
            lastFrameSeq.clear()
            channelServer.clear()
            watched.clear()
            configAt.clear()
            membersAt.clear()
        }
    }

    companion object {
        const val CONFIG_TTL_MS = 60_000L
        const val MEMBERS_TTL_MS = 120_000L
        const val MEMBERS_RETRY_MS = 10_000L
        const val MEMBERS_SERVERS_KEPT = 4

        @Volatile
        private var instance: ActivitiesStore? = null

        /** One store per process, built on first use, like [gg.pqp.app.social.SocialRepository]. */
        fun of(session: SessionStore): ActivitiesStore =
            instance ?: synchronized(this) {
                instance ?: ActivitiesStore(
                    scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
                    frames = session.realtime.frames,
                    realtimeState = session.realtime.state,
                    fetchConfig = { serverId -> session.api.activitiesConfig(serverId) },
                    fetchSessions = { serverId -> session.api.serverActivitySessions(serverId) },
                    fetchMembers = { serverId -> session.api.serverMembers(serverId) },
                ).also { store ->
                    instance = store
                    // What must not outlive the account.
                    store.scope.launch { session.sessionEnded.collect { store.clear() } }
                }
            }

        /** Who the signed-in person is, for "this session is mine". */
        fun viewerId(session: SessionStore): String? = (session.phase.value as? SessionPhase.Ready)?.me?.id
    }
}
