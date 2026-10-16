package gg.pqp.app.core

import gg.pqp.app.ui.screens.ServerActions

/**
 * What a burst of this phone's own order saves leaves behind for a `server-order-update`
 * that arrived during it. Not thread safe: the caller holds `SessionStore`'s `orderLock`.
 *
 * A remote order is ignored while a save of ours is out (the order on screen is the newer).
 * It matters again unless a save of ours reached the server AFTER it: a save that succeeded
 * wipes the remote orders ignored before it, and whatever is left when the saves settle (a
 * failed save, or a queued one that found nothing to send) is the newest order there is.
 */
class ServerOrderLedger {
    private var ignoredRemote: List<String>? = null
    private var lastSaveFailed = false

    /** A remote order arrived while a save was out. */
    fun ignored(ids: List<String>) {
        ignoredRemote = ids
    }

    fun saveFailed() {
        lastSaveFailed = true
    }

    fun saveSucceeded() {
        lastSaveFailed = false
        ignoredRemote = null
    }

    /** All saves settled: the order to show instead of [servers], if the remote one wins. */
    fun settle(servers: List<ServerSummary>): List<ServerSummary>? {
        // A remote order still here arrived after the last save that reached the server (a
        // success clears the ones before it), so it is the newest: whether our last save failed
        // or a queued one turned out to be a no-op.
        val next = ServerActions.afterSaves(servers, ignoredRemote, true)
        ignoredRemote = null
        lastSaveFailed = false
        return next
    }
}
