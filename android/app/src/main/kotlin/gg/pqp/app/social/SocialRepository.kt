package gg.pqp.app.social

import android.util.Log
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
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
 * channel, its history and the other person are untouched, and the server puts
 * you back in it the instant either side speaks (`restoreDmParticipants`, run
 * *before* the message is written so you are in its audience). So a
 * `channel-activity` frame naming a conversation this client has never heard of
 * is not a frame to drop. It is a conversation that has just come back, and
 * only the server knows who is in it. Dropping it leaves a reopened DM that
 * reaches nobody: the other side sees their message land, and it never appears
 * here until a manual refresh.
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

    fun refreshConversations() {
        scope.launch {
            _loadingConversations.value = true
            runCatching { session.api.conversations() }
                .onSuccess { _conversations.value = it }
                .onFailure { Log.w(TAG, "conversations failed: ${it.message}") }
            _loadingConversations.value = false
        }
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
        scope.launch {
            runCatching { session.api.markChannelRead(channelId) }
                .onFailure { Log.w(TAG, "mark read failed: ${it.message}") }
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
            lastMessageAt = Instant.now().toString(),
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
