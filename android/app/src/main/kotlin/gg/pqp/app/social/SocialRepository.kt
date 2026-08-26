package gg.pqp.app.social

import android.os.SystemClock
import android.util.Log
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Friends and conversations, for the whole process.
 *
 * It is not a `ViewModel` because the two lists outlive any one screen: a
 * friend request has to land on the Friends badge while somebody is reading a
 * channel, and a DM has to bump the Messages badge from anywhere. Those are
 * both socket frames, so something has to be listening when neither tab is on
 * screen. `VoiceController` lives on the `Application` for the same reason.
 *
 * THE ONE RULE THAT IS EASY TO GET WRONG, and the reason this class exists at
 * all rather than a `collect` inside a screen:
 *
 * Closing a conversation deletes only your own `channel_members` row. The
 * channel, its history and the other person are untouched, and **for a 1:1**
 * the server puts you back in it the instant either side speaks
 * (`restoreDmParticipants`, run *before* the message is written so you are in
 * its audience). So a `channel-activity` frame naming a conversation this
 * client has never heard of is not a frame to drop. It is a conversation that
 * has just come back, and only the server knows who is in it. Dropping it
 * leaves a reopened DM that reaches nobody: the other side sees their message
 * land, and it never appears here until a manual refresh.
 *
 * **A group is not restored, and this is not a detail.** Restoration reads
 * `dm_pairs`, and only a 1:1 has a row there; `restoreDmParticipants` on a
 * group channel matches nothing and inserts nothing, so no frame is sent to
 * somebody who left one (`server/src/services/dms.ts`, which says it outright:
 * "leaving a group is leaving it"). Nothing here can soften that, and the
 * user-facing strings already do not promise otherwise. This comment used to,
 * which is worse than saying nothing: a reader would have gone looking for the
 * client bug that loses a reopened group, and there is no such bug and no such
 * reopening.
 */
class SocialRepository(
    private val session: SessionStore,
    private val scope: CoroutineScope,
) {
    private val _friends = MutableStateFlow(FriendsResponse())
    val friends: StateFlow<FriendsResponse> = _friends.asStateFlow()

    private val _conversations = MutableStateFlow<List<DmSummary>>(emptyList())
    val conversations: StateFlow<List<DmSummary>> = _conversations.asStateFlow()

    private val _loadingFriends = MutableStateFlow(false)
    val loadingFriends: StateFlow<Boolean> = _loadingFriends.asStateFlow()

    private val _loadingConversations = MutableStateFlow(false)
    val loadingConversations: StateFlow<Boolean> = _loadingConversations.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /**
     * The last live friend nudge, so a screen can say what just happened. A row
     * quietly appearing in a list is easy to miss. It never names anybody: the
     * frame carries no name by design, and the row that just appeared is the
     * name.
     */
    private val _friendNudge = MutableStateFlow<String?>(null)
    val friendNudge: StateFlow<String?> = _friendNudge.asStateFlow()

    init {
        scope.launch { listen() }
        scope.launch { followSession() }
    }

    // --- reads ---

    fun refreshFriends() {
        scope.launch {
            _loadingFriends.value = true
            runCatching { session.api.friends() }
                .onSuccess { _friends.value = it }
                .onFailure { Log.w(TAG, "friends failed: ${it.message}") }
            _loadingFriends.value = false
        }
    }

    /**
     * Re-read `GET /api/dms`, at most one at a time.
     *
     * The guard is not tidiness. Every `channel-activity` frame for a
     * conversation this client does not know about calls this, and that is the
     * normal state of a closed DM coming back, so five messages typed quickly
     * into one opened five concurrent reads of the whole inbox. A request that
     * arrives while one is in flight is *coalesced* rather than dropped: the
     * in-flight read may have been sent before the row it is being asked about
     * existed, so exactly one more has to follow it.
     */
    fun refreshConversations() {
        if (refreshJob?.isActive == true) {
            refreshAgain = true
            return
        }
        refreshJob = scope.launch {
            _loadingConversations.value = true
            do {
                refreshAgain = false
                val startedAt = SystemClock.elapsedRealtime()
                runCatching { session.api.conversations() }
                    .onSuccess { _conversations.value = it.map { row -> row.honouringRead(startedAt) } }
                    .onFailure { Log.w(TAG, "conversations failed: ${it.message}") }
            } while (refreshAgain)
            _loadingConversations.value = false
        }
    }

    private var refreshJob: Job? = null

    @Volatile private var refreshAgain = false

    /**
     * Conversations whose badge this client has cleared, with the moment the
     * server confirmed it. The web calls this an unread hold.
     *
     * `GET /api/dms` counts unread from the read cursor, so a snapshot that was
     * requested before `POST /api/channels/:id/read` landed still carries the
     * old count, and applying it puts the badge straight back on the
     * conversation somebody is reading. Comparing against when the read
     * *settled* is what makes the hold release itself: the first read started
     * after that point is trustworthy again, with no timer to tune and no set
     * to remember to empty.
     */
    private val readSettledAt = mutableMapOf<String, Long>()
    private val readInFlight = mutableSetOf<String>()

    private fun DmSummary.honouringRead(snapshotStartedAt: Long): DmSummary =
        if (readHoldApplies(snapshotStartedAt, readSettledAt[channelId], channelId in readInFlight)) {
            copy(unread = UnreadCounts())
        } else {
            this
        }

    // --- friend actions ---
    //
    // Each answers with the server's own sentence on failure and never a
    // friendlier local one. The server deliberately gives one message for every
    // refusal; paraphrasing it here is how a client turns a refusal into an
    // oracle for who has blocked whom.

    suspend fun addFriend(userId: String): Outcome = act {
        val result = session.api.sendFriendRequest(userId)
        refreshFriends()
        if (result.isAccepted) Outcome.Accepted else Outcome.RequestSent
    }

    suspend fun acceptFriend(userId: String): Outcome = act {
        session.api.acceptFriendRequest(userId)
        refreshFriends()
        Outcome.Accepted
    }

    /** Decline, cancel, or unfriend: one call, silent to the other side. */
    suspend fun removeFriend(userId: String): Outcome = act {
        session.api.removeFriendship(userId)
        refreshFriends()
        Outcome.Done
    }

    suspend fun block(userId: String): Outcome = act {
        session.api.blockUser(userId)
        // A block ends the friendship through a database trigger, so the lists
        // change even though nothing here asked them to.
        refreshFriends()
        refreshConversations()
        Outcome.Done
    }

    // --- discovery ---

    /**
     * Find people to add or to message.
     *
     * Two paths, mirroring the server's two: an exact `name#1234` lookup when
     * the query looks like a tag, and a prefix search over handles otherwise.
     * The exact form is not a shortcut: prefix search is the tightest-budgeted
     * endpoint in this API because it answers questions about people you have
     * no relationship with, and somebody who already knows a full tag should not
     * have to spend that budget fishing for it.
     *
     * A tag that matches nobody is a 404, which is an ANSWER and not a failure:
     * reporting it as an error would put the server's "user not found" under a
     * search box as though something had gone wrong.
     */
    suspend fun searchPeople(query: String): Result<List<PublicUser>> {
        val term = query.trim()
        if (term.length < USER_SEARCH_MIN_LENGTH) return Result.success(emptyList())
        return runCatching {
            if (looksLikeTag(term)) {
                listOf(session.api.lookupUser(term))
            } else {
                session.api.searchUsers(term)
            }
        }.recoverCatching { error ->
            if (error is ApiException && error.status == 404) emptyList() else throw error
        }
    }

    // --- conversation actions ---

    /**
     * Open or reuse a conversation. The returned summary is inserted into the
     * list straight away rather than waiting for a refetch, because the caller
     * navigates into it in the same breath and an empty list behind the back
     * button reads as a conversation that failed to open.
     */
    suspend fun openConversation(userIds: List<String>): Result<DmSummary> = runCatching {
        val conversation = session.api.openConversation(userIds)
        upsert(conversation)
        refreshConversations()
        conversation
    }.onFailure { _error.value = it.readable() }

    suspend fun closeConversation(channelId: String): Outcome = act {
        session.api.closeConversation(channelId)
        _conversations.value = _conversations.value.filterNot { it.channelId == channelId }
        Outcome.Done
    }

    /**
     * Clear a conversation's unread badge, locally and server-side.
     *
     * The local half is not an optimisation: the server answers `GET /api/dms`
     * from the read cursor, so without it the badge would sit there until the
     * next refetch, on the one screen the reader is demonstrably looking at.
     */
    fun markRead(channelId: String) {
        _conversations.value = _conversations.value.map {
            if (it.channelId == channelId) it.copy(unread = UnreadCounts()) else it
        }
        readInFlight += channelId
        scope.launch {
            runCatching { session.api.markChannelRead(channelId) }
                .onFailure { Log.w(TAG, "mark read failed: ${it.message}") }
            // Recorded even on failure. The hold exists to stop a snapshot
            // *older than the read* undoing it; a read that never happened has
            // nothing to protect, and the server is then right to put the badge
            // back on the next refresh.
            readSettledAt[channelId] = SystemClock.elapsedRealtime()
            readInFlight -= channelId
        }
    }

    fun clearError() {
        _error.value = null
    }

    fun clearFriendNudge() {
        _friendNudge.value = null
    }

    // --- live ---

    private suspend fun listen() {
        session.realtime.frames.collect { frame ->
            when (frame.string("type")) {
                "friend-activity" -> onFriendActivity(frame)
                "channel-activity" -> onChannelActivity(frame)
                "profile-update" -> onProfileUpdate(frame)
            }
        }
    }

    /**
     * "Something changed about your friendships, read them again."
     *
     * The frame names nobody and carries no list, on purpose: the recipient
     * re-reads a bounded endpoint they were entitled to read anyway, so the
     * nudge discloses nothing new. Nothing is sent for a decline, a cancel, an
     * unfriend or a block; those are silent by design, and a client that
     * refetches on a nudge and finds a name gone learned it only because it was
     * already looking.
     */
    private fun onFriendActivity(frame: JsonObject) {
        _friendNudge.value = frame.string("kind")
        refreshFriends()
    }

    private fun onChannelActivity(frame: JsonObject) {
        val channelId = frame.string("channelId") ?: return
        val kind = frame.string("kind") ?: "server"
        val serverIsNull = frame["serverId"].let { it == null || it is JsonNull }
        // `kind` is what decides, and `serverId == null` is the fallback for an
        // API that predates it. A frame for a server channel belongs to the
        // sidebar's badges, not to this list, and filing one here would put a
        // public channel in somebody's inbox.
        if (kind == "server" && !serverIsNull) return
        if (kind != "dm" && kind != "group" && !serverIsNull) return

        val mention = frame["mention"]?.jsonPrimitive?.booleanOrNull ?: false
        val known = _conversations.value.firstOrNull { it.channelId == channelId }
        if (known == null) {
            // The reopened-conversation case, and the one worth being careful
            // about. See the note at the top of this class.
            refreshConversations()
            return
        }

        val bumped = known.copy(
            lastMessageAt = bumpedTimestamp(
                Instant.now(),
                _conversations.value.mapNotNull { it.lastMessageAt }.maxOrNull(),
            ),
            unread = UnreadCounts(
                count = known.unread.count + 1,
                mentions = known.unread.mentions + if (mention) 1 else 0,
            ),
        )
        upsert(bumped)
    }

    /**
     * Somebody renamed themselves or changed their picture.
     *
     * Fanned out to every socket rather than to a channel, precisely because a
     * person's name is drawn in places that have no channel to key off, a
     * conversation row being the example the schema names. Without this the
     * inbox keeps showing the old name until the next refetch.
     */
    private fun onProfileUpdate(frame: JsonObject) {
        val userId = frame.string("userId") ?: return
        val displayName = frame.string("displayName") ?: return
        val tag = frame.string("tag")
        val avatarUrl = frame.string("avatarUrl")

        _conversations.value = _conversations.value.map { conversation ->
            if (conversation.participants.none { it.id == userId }) {
                conversation
            } else {
                conversation.copy(
                    participants = conversation.participants.map {
                        if (it.id == userId) {
                            it.copy(displayName = displayName, tag = tag, avatarUrl = avatarUrl)
                        } else {
                            it
                        }
                    },
                )
            }
        }
        _friends.value = _friends.value.copy(
            friends = _friends.value.friends.map {
                if (it.id == userId) {
                    it.copy(displayName = displayName, tag = tag, avatarUrl = avatarUrl)
                } else {
                    it
                }
            },
        )
    }

    /**
     * Both lists are emptied on sign-out and re-read on sign-in. Leaving them
     * would show one account's inbox to the next one on the same phone, which
     * is the single worst thing a chat client can do with a cache.
     */
    private suspend fun followSession() {
        var wasReady = false
        session.phase.collect { phase ->
            val ready = phase is SessionPhase.Ready
            if (ready && !wasReady) {
                refreshFriends()
                refreshConversations()
            }
            if (!ready && wasReady) {
                _friends.value = FriendsResponse()
                _conversations.value = emptyList()
                _friendNudge.value = null
                _error.value = null
                readSettledAt.clear()
                readInFlight.clear()
            }
            wasReady = ready
        }
    }

    // --- helpers ---

    /** Freshest first, exactly the order `GET /api/dms` returns. */
    private fun upsert(conversation: DmSummary) {
        val others = _conversations.value.filterNot { it.channelId == conversation.channelId }
        _conversations.value = (others + conversation)
            .sortedByDescending { it.lastMessageAt ?: "" }
    }

    private inline fun act(block: () -> Outcome): Outcome = try {
        _error.value = null
        block()
    } catch (cancelled: kotlinx.coroutines.CancellationException) {
        // A screen that went away mid-request is not a refusal, and reporting it
        // as one would flash the server's error line as the sheet closes.
        throw cancelled
    } catch (error: Throwable) {
        val message = error.readable()
        _error.value = message
        Outcome.Failed(message)
    }

    private fun Throwable.readable(): String =
        (this as? ApiException)?.serverMessage ?: message.orEmpty()

    private fun JsonObject.string(key: String): String? =
        this[key]?.jsonPrimitive?.contentOrNull

    /**
     * What an action has to say afterwards. Typed rather than "a string that
     * starts with the right word": whether something failed must not depend on
     * wording that is translated.
     */
    sealed interface Outcome {
        data object Done : Outcome
        data object RequestSent : Outcome
        data object Accepted : Outcome
        data class Failed(val message: String) : Outcome
    }

    companion object {
        private const val TAG = "pqp.social"

        /**
         * Whether a snapshot's unread count for one conversation is older than
         * this client's own read of it, and so must not be applied.
         *
         * Pure, because the whole fix is this comparison. A read still in
         * flight always wins; otherwise the snapshot is trusted only if it was
         * *started after* the read settled, which is the point from which the
         * server's own cursor is guaranteed to be the one it answers from.
         */
        internal fun readHoldApplies(
            snapshotStartedAt: Long,
            settledAt: Long?,
            inFlight: Boolean,
        ): Boolean = inFlight || (settledAt != null && snapshotStartedAt <= settledAt)

        /**
         * The server's own timestamp format: UTC, exactly three fractional
         * digits, `Z`. What JavaScript's `toISOString()` prints, which is what
         * every `lastMessageAt` in this list is compared against.
         */
        private val SERVER_TIME: DateTimeFormatter =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

        /**
         * A timestamp for a message that has just arrived: two bugs, one value.
         *
         * `Instant.now().toString()` is the wrong shape. It prints as many
         * fractional digits as the clock has, so a phone with microsecond
         * resolution writes `…:04.123456Z` where the server writes
         * `…:04.123Z`, and these strings are ordered lexicographically: `'4'`
         * is below `'Z'`, so the row this client just bumped sorts *under* a
         * server row from the same millisecond instead of above it.
         *
         * And it is the wrong clock. The phone's is not the server's, so a
         * device running even a few seconds slow stamps a message that just
         * arrived into the middle of the list. Taking the newest timestamp the
         * server has already given us as a floor removes the skew from the
         * comparison entirely: whatever the phone thinks the time is, a message
         * that has just arrived is newer than every message already listed.
         */
        internal fun bumpedTimestamp(now: Instant, newestKnown: String?): String {
            // Compared at the precision it will be *printed* at. A phone clock
            // that is 400 microseconds ahead of the newest server row is not
            // ahead of it at all once both are three digits long, and the two
            // would come out equal, which leaves the order to whatever the
            // sort happened to be given.
            val at = Instant.ofEpochMilli(now.toEpochMilli())
            val floor = newestKnown
                ?.let { runCatching { Instant.parse(it) }.getOrNull() }
                ?.let { Instant.ofEpochMilli(it.toEpochMilli()) }
            val stamped = if (floor != null && !at.isAfter(floor)) floor.plusMillis(1) else at
            return SERVER_TIME.format(stamped)
        }

        /**
         * `name#1234`, as typed into a lookup box. One separator and something
         * on both sides of it. Anything else is a prefix search, including a
         * trailing `#` somebody is still typing.
         */
        fun looksLikeTag(query: String): Boolean {
            val parts = query.split("#")
            return parts.size == 2 && parts[0].isNotBlank() && parts[1].isNotBlank()
        }

        @Volatile
        private var instance: SocialRepository? = null

        /**
         * One repository per process, built on first use.
         *
         * A plain singleton rather than an entry in a DI module because there
         * is no DI module here to add to, and because inventing one on a branch
         * that has to merge alongside two others would be the kind of shared
         * edit this feature is deliberately avoiding.
         */
        fun of(session: SessionStore): SocialRepository =
            instance ?: synchronized(this) {
                instance ?: SocialRepository(
                    session,
                    CoroutineScope(SupervisorJob() + kotlinx.coroutines.Dispatchers.Main.immediate),
                ).also { instance = it }
            }
    }
}
