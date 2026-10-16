import Foundation

/// What the status menu on the Tu screen shows, and what the server last
/// confirmed. Several things move it: this device's own choices (each a write
/// that can fail), and a frame from another device. The rules:
///
///  - WRITES ARE SERIALISED. A choice made while a write is in the air is queued
///    (only the latest queued choice is kept) and sent when that write answers, so
///    the order the server applies them in is the order they were chosen in, and
///    no response can be "older" than another;
///  - the menu shows the latest choice at once; a write that fails puts it back on
///    the last CONFIRMED status (unless a queued choice is about to be sent);
///  - a status frame from another device while a write of ours is in the air is
///    not trusted to be ahead of or behind it: it is remembered, shown as soon as
///    the writes are done, and the server is READ to settle which came last;
///  - with nothing in the air, a frame is confirmed and shown at once.
struct OwnStatusMenu: Equatable {
    private(set) var shown: String
    private(set) var confirmed: String
    private(set) var writing = false
    private var pending: String?
    /// The latest status another device announced while a write was in the air.
    private var remoteDuringWrite: String?

    enum Next: Equatable {
        case nothing
        /// Send this status.
        case send(String)
        /// Read the account's status from the server and hand it to `serverStatus`.
        case reread
    }

    init(_ status: String = "online") {
        shown = status
        confirmed = status
    }

    /// The first read of the account's status.
    mutating func loaded(_ status: String) { serverStatus(status) }

    /// A read of the server's status (the first, or after overlapping updates).
    mutating func serverStatus(_ status: String) {
        confirmed = status
        if !writing { shown = status }
    }

    /// A choice made on this device: shown now. Returns what to send right away,
    /// or nil when a write is already in the air and this one waits its turn.
    mutating func choose(_ status: String) -> String? {
        shown = status
        if writing {
            pending = status
            return nil
        }
        writing = true
        return status
    }

    /// The write of `sent` answered.
    mutating func completed(sent: String, ok: Bool) -> Next {
        if ok { confirmed = sent }
        if let queued = pending {
            pending = nil
            if queued == confirmed {
                // The queued choice is what the server already holds.
                return finish()
            }
            return .send(queued)
        }
        if !ok { shown = confirmed }
        return finish()
    }

    private mutating func finish() -> Next {
        writing = false
        if let remote = remoteDuringWrite {
            // The newer announcement stays on show while the server is read to
            // settle the order; a read that fails leaves it, not the older value.
            remoteDuringWrite = nil
            confirmed = remote
            shown = remote
            return .reread
        }
        shown = confirmed
        return .nothing
    }

    mutating func remote(_ status: String) {
        if writing {
            remoteDuringWrite = status
        } else {
            confirmed = status
            shown = status
        }
    }
}
