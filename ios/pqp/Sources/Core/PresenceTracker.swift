import Foundation

/**
 WHO IS LOOKING AT A CHANNEL, REBUILT FROM WHAT CHANGED.

 The same convergence rule as `VoiceRosterTracker`, applied to the other list
 the server fans out on every small change: the viewers of a text channel. It
 is deliberately the identical rule rather than a second one that is nearly the
 same, because two subtly different rules is how a receiver ends up right about
 one list and quietly wrong about the other.

 Two lists, applied IN ORDER, each an absolute statement about one person:

 - `joined` this person is viewing, with this name and picture (replace by id)
 - `left`   this person is not viewing (remove by id)

 There is no `updated` here, unlike the voice roster's. The server folds a
 rename or a new avatar into `joined` (`diffPresence` in
 `server/src/ws/chat.ts` pushes anybody whose entry changed), for the same
 reason both verbs would be a replace-by-id on this side anyway.

 Because every entry is absolute, applying one twice is the same as applying it
 once, which is what makes a delta overlapping a snapshot harmless.

 HOW IT KNOWS IT IS STILL RIGHT. Two independent checks, and failing either
 means this client stops patching and waits:

 - `seq` is monotonic per channel, +1 per frame, and restarts at 1 whenever the
   channel has been empty. A delta is applied only when it is the next one. A
   client holding nothing about a channel holds 0.
 - `size` is how many viewers the channel has AFTER the delta. A client that
   applied both lists and still disagrees has diverged for a reason `seq`
   cannot see.

 On either failure `apply(delta:)` answers nil, nothing whatever is written,
 and the server's next whole list replaces the state wholesale. The worst a
 lost or reordered frame can cost is a bounded interval of staleness.

 ORDER IS PRESERVED, for the same reason the voice roster's is: this is a list
 of faces, and rebuilding it from an unordered dictionary would shuffle
 everybody every time one person opened the channel.

 Not thread safe by itself, and does not need to be: it is held as
 `RealtimeClient` actor state and only ever touched from `ingest`.
 */
struct PresenceTracker {
    private struct Channel {
        /// The sequence of the last frame applied to this channel.
        var seq: Int
        /// Every viewer, in the order the server first named them.
        var users: [PresenceUser]
    }

    private var channels: [String: Channel] = [:]

    /// The sequence held for a channel. 0 when there is no baseline, which is
    /// also what an empty channel restarts from. Exposed for tests.
    func sequence(for channelId: String) -> Int {
        channels[channelId]?.seq ?? 0
    }

    /// How many channels currently have a baseline. Exposed for tests, which is
    /// how "an emptied channel is dropped rather than remembered" is checked.
    var trackedChannelCount: Int { channels.count }

    /**
     Drop every baseline. Called when the socket is (re)opened, because a
     sequence belongs to a server process that may have restarted its numbering
     at 1. Holding a number the server no longer shares is not merely stale:
     the danger is that it lines up by accident and a delta is applied to a
     channel that has moved on.
     */
    mutating func forgetAll() {
        channels.removeAll()
    }

    /**
     A whole viewer list. Authoritative by definition.

     `seq` is absent on a server that predates presence deltas, and absent
     reads as 0.
     */
    mutating func apply(snapshot users: [PresenceUser], channelId: String, seq: Int?) {
        guard !users.isEmpty else {
            // The server forgets an empty channel's sequence so the next
            // visitor starts again at 1. A client that kept the old number
            // would read that first delta as a gap.
            channels[channelId] = nil
            return
        }
        channels[channelId] = Channel(seq: seq ?? 0, users: dedupe(users))
    }

    /**
     A delta. Answers the whole viewer list once it has been applied, or
     **nil** when it must not be applied at all: a sequence gap, or a size this
     client and the server disagree about.

     A refused delta changes nothing, not even the sequence. Advancing past one
     would turn a single missed frame into a permanently wrong list, because
     every later delta would then look like the next one in line while the
     baseline underneath it is missing whatever the skipped frame said.
     */
    mutating func apply(
        deltaFor channelId: String,
        seq: Int,
        size: Int,
        joined: [PresenceUser] = [],
        left: [String] = []
    ) -> [PresenceUser]? {
        let held = channels[channelId]?.seq ?? 0
        guard seq == held + 1 else { return nil }

        var order = channels[channelId]?.users ?? []
        var indexById: [String: Int] = [:]
        for (index, user) in order.enumerated() {
            indexById[user.id] = index
        }
        for user in joined {
            if let index = indexById[user.id] {
                order[index] = user
            } else {
                indexById[user.id] = order.count
                order.append(user)
            }
        }
        if !left.isEmpty {
            // Read off the array rather than off the index built above, so
            // somebody who both opens and closes the channel inside one window
            // ends up out, which is what the server saw happen.
            let departed = Set(left)
            order.removeAll { departed.contains($0.id) }
        }

        guard order.count == size else { return nil }

        if order.isEmpty {
            channels[channelId] = nil
        } else {
            channels[channelId] = Channel(seq: seq, users: order)
        }
        return order
    }

    /// A snapshot is trusted but not assumed: two entries for one person would
    /// put the size check permanently out of step with the server, which counts
    /// people and not rows. Last one wins, position of the first kept.
    private func dedupe(_ users: [PresenceUser]) -> [PresenceUser] {
        var order: [PresenceUser] = []
        var indexById: [String: Int] = [:]
        for user in users {
            if let index = indexById[user.id] {
                order[index] = user
            } else {
                indexById[user.id] = order.count
                order.append(user)
            }
        }
        return order
    }
}
