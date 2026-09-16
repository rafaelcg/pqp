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

    @Volatile
    var callbacks: TelecomConnectionCallbacks? = null

    fun register(roomId: String, connection: PqpConnection) {
        connections[roomId] = connection
    }

    /** Only removes the entry if it is still this exact connection: a second,
     * newer connection for the same room id must never be evicted by the
     * teardown of an older one that has already been replaced. */
    fun unregister(roomId: String, connection: PqpConnection) {
        if (connections[roomId] === connection) connections.remove(roomId)
    }

    fun find(roomId: String): PqpConnection? = connections[roomId]
}
