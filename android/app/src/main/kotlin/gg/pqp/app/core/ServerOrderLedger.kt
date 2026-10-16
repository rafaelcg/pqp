package gg.pqp.app.core

import gg.pqp.app.ui.screens.ServerActions

/**
 * What a burst of this phone's own order saves leaves behind for a `server-order-update`
 * that arrived during it. Not thread safe: the caller holds `SessionStore`'s `orderLock`.
 *
 * A remote order is ignored while a save of ours is out (the order on screen is the newer).
 * It matters again only if OUR newest save failed: then ours never reached the server and
 * the remote one is the truth. A later save that succeeded puts ours after everything, so it
 * wipes both the failure and any remote order ignored before it.
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
        val next = ServerActions.afterSaves(servers, ignoredRemote, lastSaveFailed)
        ignoredRemote = null
        lastSaveFailed = false
        return next
    }
}
