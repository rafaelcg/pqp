import Foundation
import AVFoundation
import CoreVideo
import LiveKit

/// SFU voice: the media half of a room the server pinned to LiveKit.
///
/// Presence never moves. The roster, the mute badges, `peer-joined` and
/// `peer-left` all still ride `/ws`; only the audio and video go through the
/// SFU. The join is therefore in two halves, and the *order* is the contract:
/// `welcome` first (it mints the peer id), then `POST /api/voice/token` for
/// that id, then `Room.connect`. The server only mints a token for a live peer
/// owned by this user in this channel, so a token request before `welcome` is
/// refused by design.
///
/// **Participant identity is the peer id.** The SFU knows a participant by the
/// string the token named, and the server names it after the WS peer id. That
/// is the whole join between the two halves: a remote participant's identity
/// is looked up in the WS roster for a name and a face, and its tracks are
/// filed under that id so the stage draws them beside the right person. Same
/// rule as `client/src/lib/livekit-session.ts`, and it is the reason the UI
/// above this type never learned there were two transports.
///
/// Produces exactly what `VoiceClient` produces, `[VoicePeerState]` and
/// `[String: PeerVideo]`, so the models swap the transport and keep the screen.
actor LiveKitVoiceClient {
    private var room: Room?
    private var bridge: RoomBridge?
    /// The WS roster, for names and faces. Keyed by peer id, which is the
    /// participant identity.
    private var roster: [String: VoiceParticipant] = [:]
    /// Peers with at least one subscribed audio track, which is what
    /// "connected" means here (the web's `connectionStateFor(streams.has)`).
    private var audible: Set<String> = []
    private var speaking: Set<String> = []
    private var cameras: [String: VideoFeed] = [:]
    private var screens: [String: VideoFeed] = [:]
    /// Remote audio, so deafen and per-person level have something to act on.
    /// Same mixer as the mesh; the track type differs and nothing else does.
    private var remoteAudio = RemoteAudioMixer<LiveKitRemoteAudio>()
    /// Publications we hold, by track sid, so an unsubscribe can find the
    /// entry it is taking down without a second lookup on the SDK.
    private var audioByTrackSid: [String: (peerId: String, isScreen: Bool)] = [:]

    private var isMuted = false
    private var isDeafened = false
    private var localCamera: LocalVideoTrack?
    private var usesFrontCamera = true
    /// Our screen, while the ReplayKit bridge is feeding one. The track is
    /// created on `startScreenShare` and *published on the first frame*: the
    /// SDK resolves a buffer track's dimensions from what it captures, and a
    /// publish before any frame waits on that and times out.
    private var localScreen: LocalVideoTrack?
    private var screenPublish: Task<Void, Never>?
    private var screenPlan: SfuScreenPlan?

    private var onStateChange: (@Sendable ([VoicePeerState]) -> Void)?
    private var onVideoChange: (@Sendable ([String: PeerVideo]) -> Void)?

    func configure(
        onStateChange: @escaping @Sendable ([VoicePeerState]) -> Void,
        onVideoChange: @escaping @Sendable ([String: PeerVideo]) -> Void
    ) {
        self.onStateChange = onStateChange
        self.onVideoChange = onVideoChange
    }

    /// File (or refresh) who a peer id is. Called with the `welcome` roster and
    /// on every `peer-joined` / `peer-updated`, because a participant's tracks
    /// can arrive before the frame that names them, and the tile has to fill
    /// in when it does.
    func setRoster(_ participants: [VoiceParticipant]) {
        for participant in participants {
            roster[participant.peerId] = participant
        }
        emit()
    }

    func forgetPeer(_ peerId: String) {
        roster[peerId] = nil
        emit()
    }

    /// Connects the room and publishes the microphone.
    ///
    /// The caller wraps this in `withSfuTimeout`; nothing here waits on its
    /// own clock. `muted` is the state to publish *in*: a mute-on-join or a
    /// deafen decided before the room existed has to be true from the first
    /// packet, not applied a beat after.
    ///
    /// `publishMicrophone` false is a listen-only seat (`welcome.canSpeak`).
    /// No track is created and nothing is published: the server has already
    /// withheld the LiveKit publish grant, and asking anyway is a refused
    /// publish in the log for every listener in a stage. A later
    /// `setMuted(false)`, which only happens once the rule flips to true,
    /// publishes the track through `setMicrophone(enabled:)`.
    func connect(
        _ info: VoiceSessionInfo, muted: Bool, speaker: Bool, publishMicrophone: Bool = true
    ) async throws {
        await disconnect()
        let bridge = RoomBridge(owner: self)
        self.bridge = bridge
        // Speaker or earpiece, decided before the session exists so the SDK's
        // own audio-session configuration picks the right route the first time
        // rather than switching audibly a moment in. Category, mode and
        // activation are the SDK's: it configures `.playAndRecord` / `.voiceChat`
        // around the tracks it holds, which is the same configuration the mesh
        // path writes by hand.
        AudioManager.shared.isSpeakerOutputPreferred = speaker
        let room = Room(
            delegate: bridge,
            connectOptions: ConnectOptions(),
            // Same two switches as the web session. No adaptive stream: the
            // phone shows one share at a time at a size the SFU cannot guess
            // from a SwiftUI frame. Dynacast, so a camera nobody is looking at
            // costs the presenter nothing.
            roomOptions: RoomOptions(adaptiveStream: false, dynacast: true)
        )
        self.room = room
        isMuted = muted
        do {
            try await room.connect(url: info.url, token: info.token)
        } catch {
            throw SfuJoinError.connect(String(describing: error))
        }
        if !publishMicrophone {
            adoptExistingTracks()
            emit()
            return
        }
        // Published rather than captured-and-muted: the microphone is a track
        // on the room from the start, and mute toggles that track. DTX and RED
        // to match the web publisher, so a quiet room costs nothing and a
        // lossy one still sounds like speech.
        do {
            _ = try await room.localParticipant.setMicrophone(
                enabled: true,
                publishOptions: AudioPublishOptions(dtx: true, red: true)
            )
            if muted {
                try await room.localParticipant.setMicrophone(enabled: false)
            }
        } catch {
            throw SfuJoinError.connect(String(describing: error))
        }
        // Everybody already in the room has tracks we may have subscribed to
        // during connect, before the delegate was listening for them.
        adoptExistingTracks()
        emit()
    }

    var isConnected: Bool {
        room?.connectionState == .connected
    }

    /// Mutes the *published* track rather than stopping capture, which is what
    /// keeps unmute instant and what the far end sees as a muted participant
    /// rather than one whose audio vanished.
    func setMuted(_ muted: Bool) async {
        isMuted = muted
        guard let room, room.connectionState == .connected else { return }
        _ = try? await room.localParticipant.setMicrophone(enabled: !muted)
    }

    /// Silences everyone else. The mic is the caller's to mute alongside, and
    /// both models do, matching the web client.
    func setDeafened(_ deafened: Bool) {
        isDeafened = deafened
        remoteAudio.setDeafened(deafened)
    }

    func setSpeaker(_ on: Bool) {
        AudioManager.shared.isSpeakerOutputPreferred = on
    }

    /// Per-person playback level, 0…2 where 1 is unchanged. Keyed by peer id;
    /// the caller keeps the memory by user id, as it does for the mesh.
    func setVolume(_ volume: Double, for peerId: String) {
        remoteAudio.setVolume(volume, for: peerId)
        emit()
    }

    // MARK: - Camera

    /// Publishes the camera under the SFU's own `camera` source, so receivers
    /// never need the stream-id classification the mesh does.
    ///
    /// Returns a stream id all the same, because `set-camera` carries one and
    /// the server counts cameras against the room's cap by it. Receivers on
    /// LiveKit ignore the value; receivers do not exist on any other transport
    /// in this room.
    func startCamera() async -> (feed: VideoFeed, streamId: String)? {
        guard let room, room.connectionState == .connected else { return nil }
        if let localCamera {
            return (.livekit(localCamera), "pqp-camera-livekit")
        }
        do {
            let publication = try await room.localParticipant.setCamera(
                enabled: true,
                captureOptions: CameraCaptureOptions(position: usesFrontCamera ? .front : .back)
            )
            guard let track = publication?.track as? LocalVideoTrack else { return nil }
            localCamera = track
            return (.livekit(track), "pqp-camera-" + UUID().uuidString)
        } catch {
            return nil
        }
    }

    /// Unpublishes rather than mutes: a muted camera track on this SDK keeps the
    /// capture session open, and a lit camera light on a call whose camera is
    /// off is not acceptable.
    func stopCamera() async {
        guard let room, localCamera != nil else { return }
        localCamera = nil
        // `getTrackPublication(source:)` is not public on this SDK version, so
        // the camera publication is found by walking our own publications.
        let camera = room.localParticipant.trackPublications.values
            .first { $0.source == .camera } as? LocalTrackPublication
        if let camera {
            try? await room.localParticipant.unpublish(publication: camera)
        }
    }

    /// Front ↔ back on the same track, so the far end sees the picture change
    /// rather than a publication restart.
    func flipCamera() async {
        usesFrontCamera.toggle()
        guard let capturer = localCamera?.capturer as? CameraCapturer else { return }
        _ = try? await capturer.switchCameraPosition()
    }

    var isCameraOn: Bool { localCamera != nil }

    // MARK: - Screen share

    /// Everyone in the room, us included, for the large-room cap.
    var participantCount: Int {
        guard let room else { return 0 }
        return room.remoteParticipants.count + 1
    }

    /// Gets a screen track ready for the frames the ReplayKit bridge is about
    /// to deliver. Nothing goes on the wire until the first one arrives.
    ///
    /// NOT the SDK's own broadcast path (`LKSampleHandler` in the extension,
    /// `BroadcastScreenCapturer` here), deliberately. That path has the
    /// extension JPEG-encode every frame at the screen's full size and the
    /// app decode it again, inside a process iOS kills at about 50 MB, and it
    /// would link LiveKit and its WebRTC build into that process. The bridge
    /// this app already has scales to `ScreenShareWire.maxLongSide`, clocks
    /// to 30 fps and allocates nothing per frame, and it feeds the mesh from
    /// the same socket. So the same NV12 buffers are handed to a
    /// `BufferCapturer` track, which is the SDK's door for exactly this
    /// ("can be used to provide video buffers from ReplayKit").
    ///
    /// The SDK still believes an extension is configured, because our bundle
    /// ids happen to match its convention (`gg.pqp.app` + `.broadcast`,
    /// `group.gg.pqp.app`), and it listens for Darwin notifications our
    /// extension never posts. That is inert: `setScreenShare(enabled:)` is
    /// never called, so nothing here ever reaches `BroadcastManager`.
    func startScreenShare(quality: VideoQuality) -> Bool {
        guard let room, room.connectionState == .connected else { return false }
        if localScreen != nil { return true }
        let plan = sfuScreenPlan(quality: quality, participantCount: participantCount)
        let track = LocalVideoTrack.createBufferTrack(
            name: Track.screenShareVideoName,
            source: .screenShareVideo,
            options: BufferCaptureOptions(
                dimensions: plan.topHeight >= 1080 ? .h1080_169 : .h720_169,
                fps: sfuScreenMaxFramerate
            )
        )
        localScreen = track
        screenPlan = plan
        return true
    }

    /// One frame from the bridge. The first one also starts the publish.
    func pushScreenFrame(
        _ box: UncheckedBox<CVPixelBuffer>,
        rotation: Int,
        timeStampNs: Int64
    ) {
        guard let localScreen,
              let capturer = localScreen.capturer as? BufferCapturer else { return }
        capturer.capture(
            box.value,
            timeStampNs: timeStampNs,
            rotation: liveKitRotation(degrees: rotation)
        )
        guard screenPublish == nil, let plan = screenPlan else { return }
        screenPublish = Task { [weak self] in
            await self?.publishScreen(localScreen, plan: plan)
        }
    }

    private func publishScreen(_ track: LocalVideoTrack, plan: SfuScreenPlan) async {
        guard let room, localScreen === track else { return }
        do {
            _ = try await room.localParticipant.publish(
                videoTrack: track,
                options: Self.screenPublishOptions(for: plan)
            )
        } catch {
            // The room said no, or went away. The bridge keeps delivering
            // frames into a track nobody receives; the next `stopScreenShare`
            // clears it, and a fresh broadcast tries again.
            if localScreen === track { localScreen = nil }
            screenPublish = nil
        }
    }

    /// The web's `publishScreenVideo`, field for field: simulcast with the
    /// plan's lower rungs declared, the top layer capped by the plan's
    /// ceiling, and `maintainFramerate` so the encoder sheds pixels before
    /// it sheds motion. `screenShareEncoding`, not `encoding`: the SDK reads
    /// a screen's ceiling from that field alone.
    static func screenPublishOptions(for plan: SfuScreenPlan) -> VideoPublishOptions {
        VideoPublishOptions(
            screenShareEncoding: VideoEncoding(
                maxBitrate: plan.topBitrate, maxFps: sfuScreenMaxFramerate
            ),
            simulcast: true,
            screenShareSimulcastLayers: plan.lowerLayers.map { layer in
                VideoParameters(
                    dimensions: Dimensions(
                        width: Int32(layer.width), height: Int32(layer.height)
                    ),
                    encoding: VideoEncoding(
                        maxBitrate: layer.maxBitrate, maxFps: layer.maxFramerate
                    )
                )
            },
            degradationPreference: .maintainFramerate
        )
    }

    func stopScreenShare() async {
        screenPublish?.cancel()
        screenPublish = nil
        screenPlan = nil
        guard let track = localScreen else { return }
        localScreen = nil
        guard let room else { return }
        let screen = room.localParticipant.trackPublications.values
            .first { $0.source == .screenShareVideo } as? LocalTrackPublication
        if let screen {
            try? await room.localParticipant.unpublish(publication: screen)
        } else {
            _ = try? await track.stop()
        }
    }

    var isSharingScreen: Bool { localScreen != nil }

    // MARK: - Teardown

    func disconnect() async {
        let room = self.room
        self.room = nil
        bridge = nil
        localCamera = nil
        screenPublish?.cancel()
        screenPublish = nil
        localScreen = nil
        screenPlan = nil
        roster.removeAll()
        audible.removeAll()
        speaking.removeAll()
        cameras.removeAll()
        screens.removeAll()
        audioByTrackSid.removeAll()
        remoteAudio.removeEverything()
        isDeafened = false
        await room?.disconnect()
        emitVideo()
        emit()
    }

    // MARK: - Track bookkeeping

    /// Tracks that were subscribed before the delegate was attached, or while
    /// the connect was still in flight, are already on the participants.
    private func adoptExistingTracks() {
        guard let room else { return }
        for participant in room.remoteParticipants.values {
            guard let identity = participant.identity?.stringValue else { continue }
            for publication in participant.trackPublications.values {
                guard let remote = publication as? RemoteTrackPublication,
                      let track = remote.track else { continue }
                file(track: track, publication: remote, peerId: identity)
            }
        }
    }

    fileprivate func noteSubscribed(_ box: UncheckedBox<(Track, RemoteTrackPublication)>, peerId: String) {
        file(track: box.value.0, publication: box.value.1, peerId: peerId)
        emitVideo()
        emit()
    }

    private func file(track: Track, publication: RemoteTrackPublication, peerId: String) {
        let sid = publication.sid.stringValue
        switch publication.source {
        case .camera:
            if let video = track as? VideoTrack { cameras[peerId] = .livekit(video) }
        case .screenShareVideo:
            if let video = track as? VideoTrack { screens[peerId] = .livekit(video) }
        case .screenShareAudio, .microphone, .unknown:
            guard let audio = track as? RemoteAudioTrack else { return }
            // Keyed by track, not by peer: a presenter's screen audio must not
            // overwrite the reference to their microphone. See `RemoteAudioMixer`.
            remoteAudio.add(LiveKitRemoteAudio(audio), id: sid, for: peerId)
            let isScreen = publication.source == .screenShareAudio
            audioByTrackSid[sid] = (peerId, isScreen)
            if !isScreen { audible.insert(peerId) }
        }
    }

    fileprivate func noteUnsubscribed(source: Track.Source, sid: String, peerId: String) {
        switch source {
        case .camera:
            cameras[peerId] = nil
        case .screenShareVideo:
            screens[peerId] = nil
        case .screenShareAudio, .microphone, .unknown:
            remoteAudio.remove(trackId: sid, for: peerId)
            if let entry = audioByTrackSid.removeValue(forKey: sid), !entry.isScreen {
                audible.remove(peerId)
            }
        }
        emitVideo()
        emit()
    }

    fileprivate func noteParticipantLeft(peerId: String) {
        cameras[peerId] = nil
        screens[peerId] = nil
        audible.remove(peerId)
        speaking.remove(peerId)
        remoteAudio.remove(peerId: peerId)
        audioByTrackSid = audioByTrackSid.filter { $0.value.peerId != peerId }
        emitVideo()
        emit()
    }

    fileprivate func noteParticipantJoined() {
        emit()
    }

    fileprivate func noteSpeaking(_ identities: Set<String>) {
        guard identities != speaking else { return }
        speaking = identities
        emit()
    }

    /// The SFU gave up on the room. Surfaced as everyone having gone; the
    /// model's next `welcome` or `leave` decides what to do about it.
    fileprivate func noteDisconnected() {
        cameras.removeAll()
        screens.removeAll()
        audible.removeAll()
        speaking.removeAll()
        remoteAudio.removeEverything()
        audioByTrackSid.removeAll()
        emitVideo()
        emit()
    }

    private func emitVideo() {
        var result: [String: PeerVideo] = [:]
        for peerId in Set(cameras.keys).union(screens.keys) {
            result[peerId] = PeerVideo(camera: cameras[peerId], screen: screens[peerId])
        }
        onVideoChange?(result)
    }

    /// One row per remote participant the SFU knows, whether or not the WS
    /// roster has named them yet: the tile shows "Someone" for a beat rather
    /// than nothing, exactly as the mesh does for a peer whose frame is late.
    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    private func emit() {
        guard let room else {
            onStateChange?([])
            return
        }
        let states = room.remoteParticipants.values.compactMap { participant -> VoicePeerState? in
            guard let peerId = participant.identity?.stringValue else { return nil }
            let named = roster[peerId]
            return VoicePeerState(
                peerId: peerId,
                // An SDK name that is empty (the common case for a participant
                // that never joined /ws) reads as nobody, not as a blank row.
                displayName: named?.displayName ?? Self.nonEmpty(participant.name) ?? "Someone",
                userId: named?.userId ?? "",
                connection: audible.contains(peerId) ? "connected" : "connecting",
                avatarUrl: named?.avatarUrl,
                isSpeaking: speaking.contains(peerId),
                volume: remoteAudio.volume(for: peerId)
            )
        }
        .sorted { $0.displayName < $1.displayName }
        onStateChange?(states)
    }
}

/// `RemoteAudioMixer`'s view of a LiveKit track.
///
/// The SDK exposes no local enable switch on a remote track, only its playout
/// gain, so "disabled" is gain zero and the chosen level is kept aside to come
/// back to. The mixer sets both and never reads them back, so the pair cannot
/// disagree.
final class LiveKitRemoteAudio: RemoteAudible, @unchecked Sendable {
    private let track: RemoteAudioTrack
    private var level: Double = 1
    private var enabled = true

    init(_ track: RemoteAudioTrack) {
        self.track = track
    }

    var isEnabled: Bool {
        get { enabled }
        set {
            enabled = newValue
            apply()
        }
    }

    var playbackVolume: Double {
        get { level }
        set {
            level = newValue
            apply()
        }
    }

    private func apply() {
        track.volume = enabled ? level : 0
    }
}

/// LiveKit's delegate protocol is Objective-C and its callbacks arrive on
/// arbitrary threads, so this bridges each one onto the actor. Only `Sendable`
/// values cross, or references boxed for a single handoff.
private final class RoomBridge: NSObject, RoomDelegate, @unchecked Sendable {
    weak var owner: LiveKitVoiceClient?

    init(owner: LiveKitVoiceClient) {
        self.owner = owner
    }

    func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        guard let peerId = participant.identity?.stringValue, let track = publication.track else { return }
        let box = UncheckedBox((track, publication))
        Task { [owner] in await owner?.noteSubscribed(box, peerId: peerId) }
    }

    func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        guard let peerId = participant.identity?.stringValue else { return }
        let source = publication.source
        let sid = publication.sid.stringValue
        Task { [owner] in await owner?.noteUnsubscribed(source: source, sid: sid, peerId: peerId) }
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { [owner] in await owner?.noteParticipantJoined() }
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        guard let peerId = participant.identity?.stringValue else { return }
        Task { [owner] in await owner?.noteParticipantLeft(peerId: peerId) }
    }

    func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        let identities = Set(participants.compactMap { participant -> String? in
            guard !(participant is LocalParticipant) else { return nil }
            return participant.identity?.stringValue
        })
        Task { [owner] in await owner?.noteSpeaking(identities) }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        Task { [owner] in await owner?.noteDisconnected() }
    }
}

/// ReplayKit's rotation, in the degrees the bridge carries, as the SDK names
/// it. Both count clockwise, so the mapping is a rename and nothing else.
func liveKitRotation(degrees: Int) -> VideoRotation {
    switch degrees {
    case 90: ._90
    case 180: ._180
    case 270: ._270
    default: ._0
    }
}
