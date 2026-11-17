package gg.pqp.app.jam

import android.content.Context
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.mapNotNull

/**
 * Everything the jam screens read from the outside world, in one seam, so the
 * view models run on the JVM against a fake (`JamWallViewModelTest`).
 */
interface JamBackend {
    val viewerId: String?

    /** The seven jam frames, decoded; every other frame is dropped here. */
    val frames: Flow<JamFrame>
    val connection: Flow<RealtimeState>

    suspend fun config(serverId: String): JamConfig
    suspend fun songs(channelId: String, cursor: String? = null, limit: Int = JamLimits.PAGE_SIZE): JamSongListResponse
    suspend fun song(songId: String): JamSongDetailResponse
    suspend fun vote(trackId: String, voted: Boolean): JamVoteResponse
    suspend fun setInMix(trackId: String, inMix: Boolean): JamTrackWithSong
    suspend fun deleteTrack(trackId: String)
    suspend fun deleteSong(songId: String)

    /** The jam channel takes the socket's primary slot: its frames are fanned out to its viewers. */
    fun join(channelId: String)

    /** Give the primary slot back, if it is still ours (a chat opened since keeps its own). */
    fun leave(channelId: String)
}

/** The live backend: the session's API and socket. */
class SessionJamBackend(private val session: SessionStore) : JamBackend {
    override val viewerId: String?
        get() = (session.phase.value as? SessionPhase.Ready)?.me?.id

    override val frames: Flow<JamFrame>
        get() = session.realtime.frames
            .filter { JamFrame.isJam(it) }
            .mapNotNull { JamFrame.decode(it) }

    override val connection: Flow<RealtimeState> get() = session.realtime.state

    override suspend fun config(serverId: String) = session.api.jamConfig(serverId)
    override suspend fun songs(channelId: String, cursor: String?, limit: Int) =
        session.api.jamSongs(channelId, cursor, limit)

    override suspend fun song(songId: String) = session.api.jamSong(songId)
    override suspend fun vote(trackId: String, voted: Boolean) =
        if (voted) session.api.voteJamTrack(trackId) else session.api.unvoteJamTrack(trackId)

    override suspend fun setInMix(trackId: String, inMix: Boolean) = session.api.setJamTrackInMix(trackId, inMix)
    override suspend fun deleteTrack(trackId: String) = session.api.deleteJamTrack(trackId)
    override suspend fun deleteSong(songId: String) = session.api.deleteJamSong(songId)

    override fun join(channelId: String) {
        session.realtime.joinChannel(channelId)
    }

    override fun leave(channelId: String) {
        session.realtime.leaveChannel(channelId)
    }
}

/**
 * The newest bump this device saw per jam channel: a per-device convenience,
 * losing it costs one dot. Plain preferences, every access guarded.
 */
class JamSeenStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("pqp.jam", Context.MODE_PRIVATE)

    fun lastSeenMs(channelId: String): Long? =
        runCatching { prefs.getLong(KEY + channelId, 0L) }.getOrDefault(0L).takeIf { it > 0 }

    fun markSeen(channelId: String, ms: Long) {
        runCatching { prefs.edit().putLong(KEY + channelId, ms).apply() }
    }

    private companion object {
        const val KEY = "seen."
    }
}
