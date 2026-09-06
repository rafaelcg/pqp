import Foundation
import WebRTC

/// A remote audio track this client can silence and level.
///
/// A protocol rather than `RTCAudioTrack` directly so the bookkeeping below can
/// be tested. Making a real `RTCAudioTrack` needs a peer connection factory, an
/// audio session and a device, which is the reason none of the mesh's rules
/// were covered before the pure types were pulled out of it.
protocol RemoteAudible: AnyObject {
    var isEnabled: Bool { get set }
    /// 0…2, where 1 is unchanged. Named apart from WebRTC's `source.volume`
    /// because the source is an implementation detail of one conformance.
    var playbackVolume: Double { get set }
}

extension RTCAudioTrack: RemoteAudible {
    var playbackVolume: Double {
        get { source.volume }
        set { source.volume = newValue }
    }
}

/// Every remote audio track, by peer and then by track, plus the two switches
/// that apply to them: deafen and per-person level.
///
/// WHY THIS IS NESTED and not one track per peer, which is what it was.
/// **A peer can publish more than one audio track.** Sharing a screen with its
/// sound sends the machine's audio alongside the microphone, under the screen
/// capture's own stream id, and the web client has done that since 2026-08-22.
/// Filing them both under the peer id meant the second one overwrote the first,
/// and the overwritten reference was the only way to turn that track off.
///
/// What that looked like: somebody shares a screen, you press deafen, and the
/// presenter's microphone keeps playing. Not an error, not a log line, just the
/// one control whose entire job is silence quietly failing at it. The same
/// reference is what per-person volume moves, so their slider stopped reaching
/// half of them too.
///
/// The volumes outlive the tracks on purpose. The server mints a fresh peer id
/// every join, so the caller keys its own memory by *user* id and re-applies on
/// reconnect; keeping the last value here as well means a track that comes back
/// mid-call comes back at the level it left at.
///
/// A SERVER MUTE IS A THIRD SWITCH, and it sits on top of the slider rather
/// than moving it. On mesh the server cannot stop anybody's audio, so when a
/// moderator mutes somebody the only thing that actually goes quiet is every
/// receiver deciding to play them at zero. That has to win over the per-person
/// level, and it has to win without overwriting it: the slider is the
/// listener's choice about this person, and a moderator's mute is a moment in
/// the call. When the flag clears the person comes back at the level that was
/// chosen for them, not at the zero somebody else put there.
///
/// AND IT SILENCES THE MICROPHONE ONLY. A moderator muting somebody who is
/// sharing a film mutes the person, not the film: the watch-party case is a
/// host quieting chatter while the shared content keeps playing, and the web
/// client applies its zero to the voice sink alone. Telling the two tracks
/// apart works the way cameras are told from screens: the roster announces the
/// screen capture's stream id (`screenAudioStreamId`), an arriving track
/// carries the stream id it was published under, and the two are matched here.
/// Both race, so both re-apply. An audio track under an unannounced stream is
/// the microphone, which is the safe reading: a share that never said it had
/// sound goes quiet with the person, a microphone never plays through a mute.
struct RemoteAudioMixer<Track: RemoteAudible> {
    private var tracks: [String: [String: Track]] = [:]
    /// The stream id each filed track arrived under, by peer then track.
    private var streamIds: [String: [String: String]] = [:]
    /// The roster's `screenAudioStreamId` per peer.
    private var screenAudioStreamIds: [String: String] = [:]
    private var volumes: [String: Double] = [:]
    private var serverMuted: Set<String> = []
    private(set) var isDeafened = false

    /// Files a newly arrived track and brings it in line with the room.
    ///
    /// Both switches are applied here rather than by the caller: a track that
    /// arrives while you are already deafened has to arrive silent, and one
    /// that arrives after you moved somebody's slider has to arrive at that
    /// level. Doing it anywhere else is a track that plays for one tick.
    ///
    /// `streamId` is what the track was published under, when the transport
    /// said. It is the only handle for telling a share's sound from a voice.
    mutating func add(_ track: Track, id: String, streamId: String? = nil, for peerId: String) {
        track.isEnabled = !isDeafened
        tracks[peerId, default: [:]][id] = track
        if let streamId { streamIds[peerId, default: [:]][id] = streamId }
        track.playbackVolume = effectiveVolume(for: peerId, trackId: id)
    }

    /// Drops one track, which is how a screen share ending leaves the
    /// microphone alone.
    mutating func remove(trackId: String, for peerId: String) {
        tracks[peerId]?[trackId] = nil
        streamIds[peerId]?[trackId] = nil
        if tracks[peerId]?.isEmpty == true { tracks[peerId] = nil }
    }

    /// Drops a peer entirely. Their chosen level is kept: they may be back.
    ///
    /// The server mute is NOT kept. It belongs to the roster entry, and a peer
    /// who leaves and returns comes back under a fresh peer id with a fresh
    /// entry that says whether they are still muted. Remembering the old one
    /// would be a mute the server never sent.
    mutating func remove(peerId: String) {
        tracks[peerId] = nil
        streamIds[peerId] = nil
        screenAudioStreamIds[peerId] = nil
        serverMuted.remove(peerId)
    }

    /// The room is gone, levels included.
    mutating func removeEverything() {
        tracks.removeAll()
        streamIds.removeAll()
        screenAudioStreamIds.removeAll()
        volumes.removeAll()
        serverMuted.removeAll()
        isDeafened = false
    }

    mutating func setDeafened(_ deafened: Bool) {
        isDeafened = deafened
        for peer in tracks.values {
            for track in peer.values { track.isEnabled = !deafened }
        }
    }

    /// Per-person playback level, applied to everything that person is sending.
    ///
    /// Their screen's sound included, which matches the web client: one person,
    /// one slider, whatever they happen to be publishing.
    ///
    /// Stored even while the person is server-muted, and applied only through
    /// `effectiveVolume`: moving the slider on somebody a moderator silenced
    /// changes what they will come back at, not what plays now.
    mutating func setVolume(_ volume: Double, for peerId: String) {
        volumes[peerId] = volume
        applyEffectiveVolume(for: peerId)
    }

    /// What the roster says a moderator did to this person. Zero on top of the
    /// slider while set, the slider again the moment it clears.
    mutating func setServerMuted(_ muted: Bool, for peerId: String) {
        if muted { serverMuted.insert(peerId) } else { serverMuted.remove(peerId) }
        applyEffectiveVolume(for: peerId)
    }

    func isServerMuted(_ peerId: String) -> Bool { serverMuted.contains(peerId) }

    /// The roster's word on which of this peer's streams is their share's
    /// sound. Re-applied to whatever has already arrived, because the
    /// announcement and the track race: a `set-sharing-screen` travels over
    /// the socket while the track waits on a renegotiation, and either can
    /// land first.
    mutating func setScreenAudioStreamId(_ streamId: String?, for peerId: String) {
        guard screenAudioStreamIds[peerId] != streamId else { return }
        screenAudioStreamIds[peerId] = streamId
        applyEffectiveVolume(for: peerId)
    }

    /// Whether a filed track is the peer's screen audio, per the roster.
    func isScreenAudio(trackId: String, for peerId: String) -> Bool {
        guard let announced = screenAudioStreamIds[peerId],
              let streamId = streamIds[peerId]?[trackId] else { return false }
        return announced == streamId
    }

    /// The listener's choice, untouched by any server mute. This is what the
    /// slider shows.
    func volume(for peerId: String) -> Double { volumes[peerId] ?? 1 }

    /// What is actually reaching the speaker from this person's microphone:
    /// the chosen level, or zero while a moderator has them muted.
    func effectiveVolume(for peerId: String) -> Double {
        serverMuted.contains(peerId) ? 0 : volume(for: peerId)
    }

    /// The same, for one track: the share's sound is exempt from the mute.
    func effectiveVolume(for peerId: String, trackId: String) -> Double {
        if serverMuted.contains(peerId), !isScreenAudio(trackId: trackId, for: peerId) {
            return 0
        }
        return volume(for: peerId)
    }

    private func applyEffectiveVolume(for peerId: String) {
        for (id, track) in tracks[peerId] ?? [:] {
            track.playbackVolume = effectiveVolume(for: peerId, trackId: id)
        }
    }

    /// For tests. The app never needs to count them.
    func trackCount(for peerId: String) -> Int { tracks[peerId]?.count ?? 0 }
}
