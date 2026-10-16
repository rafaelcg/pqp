import Foundation

/// What the status menu on the Tu screen shows, and what the server last
/// confirmed. Several things move it at once: this device's own choices (each a
/// write that can fail), the answer to those writes, and a frame from another
/// device. The rules, in one place:
///
///  - a choice shows at once; the LATEST choice is the one on screen, and only
///    the latest write's outcome may change what is shown;
///  - a write that succeeds confirms its value;
///  - a write that fails, while it is still the latest, puts the menu back on the
///    last CONFIRMED status (never on a neighbouring unconfirmed choice);
///  - another device's status is confirmed the moment it arrives, and shown
///    right away only when no write of ours is in the air (otherwise it flicks
///    the menu mid-choice; it is what a failed latest write falls back to).
struct OwnStatusMenu: Equatable {
    private(set) var shown: String
    private(set) var confirmed: String
    private var latest = 0
    /// The newest write that has succeeded. An older write answering after it is
    /// history: the last choice made is the one the server is taken to hold.
    private var confirmedToken = 0
    private(set) var inFlight = 0

    init(_ status: String = "online") {
        shown = status
        confirmed = status
    }

    /// The first read of the account's status.
    mutating func loaded(_ status: String) {
        confirmed = status
        if inFlight == 0 { shown = status }
    }

    /// A choice made on this device. The token identifies its write.
    mutating func choose(_ status: String) -> Int {
        latest += 1
        inFlight += 1
        shown = status
        return latest
    }

    mutating func succeeded(_ token: Int, status: String) {
        inFlight = max(0, inFlight - 1)
        if token >= confirmedToken {
            confirmedToken = token
            confirmed = status
        }
        // The last write in the air has answered: the menu shows what the server
        // holds (an older choice succeeding after a newer one failed).
        if inFlight == 0 { shown = confirmed }
    }

    mutating func failed(_ token: Int) {
        inFlight = max(0, inFlight - 1)
        if token == latest { shown = confirmed }
    }

    mutating func remote(_ status: String) {
        confirmed = status
        if inFlight == 0 { shown = status }
    }
}
