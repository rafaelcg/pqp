package gg.pqp.app.voice.telecom

/**
 * What the system tells this app about a live [PqpConnection], carried up to
 * [gg.pqp.app.voice.VoiceController] and [gg.pqp.app.voice.CallController].
 *
 * Every method is named for the framework callback it answers, not for what
 * pqp does about it — that mapping is [TelecomController]'s job, kept out of
 * [PqpConnection] itself so the framework-facing class stays a thin adapter.
 */
interface TelecomConnectionCallbacks {
    /** The system's own incoming-call UI, a Bluetooth headset, or Android
     * Auto answered this room. */
    fun onAnswer(roomId: String)

    /** The same, for a decline. */
    fun onReject(roomId: String)

    /** A live call was hung up through Telecom (the CallStyle notification's
     * own action, a Bluetooth button, Android Auto, or the system dismissing
     * an unanswered ring some other way than [onReject]). */
    fun onDisconnect(roomId: String)

    /** Telecom's own audio-state report: the current mute flag and route,
     * reflecting a Bluetooth headset's button, a wired headset's, or the
     * system call UI. */
    fun onAudioStateChanged(roomId: String, muted: Boolean)

    /** Telecom wants this app to draw its own incoming-call UI for this room. */
    fun onShowIncomingCallUi(roomId: String, displayName: String)

    /** Telecom refused to build a connection for this room at all
     * (`onCreateOutgoingConnectionFailed` / `onCreateIncomingConnectionFailed`
     * in [PqpConnectionService]). No [PqpConnection] was ever created, so
     * there is nothing to tear down on the system side -- this exists only so
     * [TelecomController] stops believing a Telecom connection exists for
     * this room, without touching the underlying pqp voice call, which
     * proceeds exactly as it would have before this feature existed (Farol
     * review, PR 678). */
    fun onConnectionFailed(roomId: String)
}

/**
 * The process-wide link between [PqpConnection] objects — created by the
 * system, outside this app's control, inside [PqpConnectionService] — and
 * [TelecomController], which is what actually knows what a room's connection
 * should do.
 *
 * A singleton because there is exactly one of each for the life of the
 * process: one `ConnectionService` instance the system binds to, and one
 * `TelecomController` built once in `PqpApplication`. Neither can hand the
 * other a constructor reference, since the system builds the first and the
 * app builds the second on its own schedule, so this is the seam instead.
 */
object TelecomBridge {
    private val connections = mutableMapOf<String, PqpConnection>()

    // `TelecomManager.placeCall`/`addNewIncomingCall` return before the
    // system actually calls PqpConnectionService and a PqpConnection is
    // registered here -- it is a genuine async round trip through the
    // framework. A markActive()/endConnection() that races ahead of that
    // (VoiceController reaching Connected, or a room ending, within that
    // window) used to just find nothing and silently drop the intent,
    // leaving Telecom showing "Dialing" forever, or a connection that gets
    // created after the app already considers the room gone lingering as a
    // ghost call (Farol review, PR 678). These two sets are that intent,
    // replayed the moment `register` actually happens.
    private val pendingActive = mutableSetOf<String>()
    private val pendingEndCause = mutableMapOf<String, Int>()

    @Volatile
    var callbacks: TelecomConnectionCallbacks? = null

    fun register(roomId: String, connection: PqpConnection) {
        connections[roomId] = connection
        val endCause = pendingEndCause.remove(roomId)
        if (endCause != null) {
            // An end was already decided before this connection existed:
            // honour it immediately rather than leaving a call the app has
            // already moved on from sitting on the lock screen. Never also
            // apply a pending "active" for the same room -- ended wins.
            pendingActive.remove(roomId)
            connection.end(endCause)
            return
        }
        if (pendingActive.remove(roomId)) {
            runCatching { connection.setActive() }
        }
    }

    /** Only removes the entry if it is still this exact connection: a second,
     * newer connection for the same room id must never be evicted by the
     * teardown of an older one that has already been replaced. */
    fun unregister(roomId: String, connection: PqpConnection) {
        if (connections[roomId] === connection) connections.remove(roomId)
    }

    fun find(roomId: String): PqpConnection? = connections[roomId]

    /** [AndroidTelecomGateway.markActive] found no registered connection yet:
     * remember the intent so [register] can replay it. */
    fun queueActive(roomId: String) {
        if (roomId in pendingEndCause) return
        pendingActive += roomId
    }

    /** [AndroidTelecomGateway.endConnection] found no registered connection
     * yet: remember the cause so [register] can replay it. Supersedes any
     * queued "active" for the same room. */
    fun queueEnd(roomId: String, causeCode: Int) {
        pendingActive.remove(roomId)
        pendingEndCause[roomId] = causeCode
    }

    /** A connection for this room will now never be created
     * (`onConnectionFailed`): any intent queued for it is moot. */
    fun clearPending(roomId: String) {
        pendingActive.remove(roomId)
        pendingEndCause.remove(roomId)
    }
}
