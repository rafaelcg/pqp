import AVKit
import SwiftUI

/**
 THE PRESENTER'S CAMERA, FLOATING OVER THEIR FILM.

 Mirrors `client/src/lib/watch-camera-pip.ts` and `watch-camera-pip.tsx`. A
 watch party's audience is seatless, so a camera published into the room
 reaches nobody on the playlist; the server runs a second, video-only egress
 beside the ladder and states its playlist as `LiveHlsStream.cameraHlsUrl`.
 This file is the iOS half: where the picture-in-picture sits, whether it is
 showing at all, and which of the two pictures owns the stage.

 DELIBERATELY MUCH SIMPLER THAN THE FILM'S PLAYER (`WatchStageView`,
 `WatchVideoSurface`). The camera carries one rendition, no ladder, no
 fullscreen, no system Picture-in-Picture of its own, and a failure whose
 correct response is to disappear rather than to tell anybody anything. See
 `WatchCameraSurface`.
 */

// MARK: - Layout

/// Mirrors `CAMERA_LAYOUTS` in `client/src/lib/watch-camera-pip.ts`, Rafael's
/// four: the default corner, side by side, hide the camera, hide the film.
enum CameraLayout: String, CaseIterable, Codable, Equatable, Sendable {
    /// The default. The film on the stage, the camera small in a corner.
    case pip
    /// The two next to each other (stacked in portrait, film on top; side by
    /// side once the stage is wider than it is tall).
    case side
    /// "Hide camera". The film alone. The camera's player is unmounted,
    /// UNLESS it also carries the presenter's voice, which a hidden webcam
    /// must not silence: then it stays, drawn as a voice-only corner.
    case stream
    /// "Hide stream". The camera on the stage, alone. The film keeps playing
    /// underneath, covered rather than torn down, because it is the one
    /// carrying the party's audio and switching back has to be instant.
    case camera
}

/// Mirrors `CAMERA_PIP_CORNERS`. `Alignment` is what `ZStack` wants; the raw
/// cases are what gets persisted and compared.
enum CameraPipCorner: String, CaseIterable, Codable, Equatable, Sendable {
    case topLeading, topTrailing, bottomLeading, bottomTrailing

    var alignment: Alignment {
        switch self {
        case .topLeading: return .topLeading
        case .topTrailing: return .topTrailing
        case .bottomLeading: return .bottomLeading
        case .bottomTrailing: return .bottomTrailing
        }
    }

    /// The corner closest to a drag's release point inside a stage of the
    /// given size. Pure so a drag gesture's end can be asserted on without a
    /// running view.
    static func nearest(to point: CGPoint, in bounds: CGSize) -> CameraPipCorner {
        let leading = point.x < bounds.width / 2
        let top = point.y < bounds.height / 2
        switch (top, leading) {
        case (true, true): return .topLeading
        case (true, false): return .topTrailing
        case (false, true): return .bottomLeading
        case (false, false): return .bottomTrailing
        }
    }

    /// The next corner, clockwise. Four presses is where you started.
    /// Mirrors `nextCameraPipCorner`; VoiceOver's "move to another corner"
    /// action uses this, since a drag gesture is not reachable that way.
    func clockwise() -> CameraPipCorner {
        switch self {
        case .topLeading: return .topTrailing
        case .topTrailing: return .bottomTrailing
        case .bottomTrailing: return .bottomLeading
        case .bottomLeading: return .topLeading
        }
    }
}

/// What the viewer asked for, remembered per phone. Bottom trailing (the
/// corner every video call on the platform already uses) and `pip`, the
/// default, film on the stage.
///
/// DELIBERATELY NOT `Codable` ITSELF. The standard library gives any type
/// that is both `Codable` and `RawRepresentable` with an `Encodable`
/// `RawValue` a DEFAULT `encode(to:)`/`init(from:)` built out of
/// `rawValue`/`init?(rawValue:)` -- and this type's `rawValue` is built out
/// of `JSONEncoder`, so the two defaults call each other. Confirmed the hard
/// way: a `SIGSEGV` stack overflow pinned on `CameraPipPref.rawValue.getter`
/// calling itself through `JSONEncoder.encode`, every time a test actually
/// exercised the round trip. `StoredCameraPipPref` below is the `Codable`
/// half instead, so the two conformances never meet.
struct CameraPipPref: Equatable, Sendable {
    var corner: CameraPipCorner
    var layout: CameraLayout

    static let `default` = CameraPipPref(corner: .bottomTrailing, layout: .pip)
}

/// The JSON shape alone, with no `RawRepresentable` in sight.
private struct StoredCameraPipPref: Codable {
    var corner: CameraPipCorner
    var layout: CameraLayout
}

/**
 `@AppStorage`-backed via JSON, the same shape `readCameraPipPref` /
 `writeCameraPipPref` give the web's `localStorage`. Defensive by
 construction: a value that fails to decode (nothing stored yet, a future
 format) reads as `.default` rather than crashing the stage over a
 preference nobody would notice missing.
 */
extension CameraPipPref: RawRepresentable {
    init?(rawValue: String) {
        guard let data = rawValue.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(StoredCameraPipPref.self, from: data)
        else {
            self = .default
            return
        }
        self.init(corner: decoded.corner, layout: decoded.layout)
    }

    var rawValue: String {
        let stored = StoredCameraPipPref(corner: corner, layout: layout)
        guard let data = try? JSONEncoder().encode(stored),
              let string = String(data: data, encoding: .utf8)
        else { return "{}" }
        return string
    }
}

/// Whether the viewer is offered the layout menu at all: only for a camera
/// that is actually a picture. Mirrors `cameraLayoutOffered`.
func cameraLayoutOffered(cameraSrc: String?, cameraHasVideo: Bool) -> Bool {
    cameraSrc != nil && cameraHasVideo
}

/// The layout in force. A camera with no picture (the audio-only "separada"
/// shape) has nothing to lay out and always reads as the corner box, which is
/// also where the voice-only indicator lives. Mirrors `effectiveCameraLayout`.
func effectiveCameraLayout(pref: CameraPipPref, cameraHasVideo: Bool) -> CameraLayout {
    cameraHasVideo ? pref.layout : .pip
}

/**
 THE URL WORTH A LIVE CONNECTION FOR, GIVEN WHAT THE VIEWER CAN ACTUALLY SEE
 OR HEAR RIGHT NOW.

 "Hide camera" (`.stream`) with nothing to hear either is nothing worth
 streaming: `nil` here is what makes `WatchCameraStreamSwap` detach a camera
 the viewer explicitly hid, instead of leaving it running invisibly for as
 long as that layout stays picked (Farol review, PR 833). A camera that DOES
 carry the presenter's voice keeps streaming even hidden -- the corner still
 shows the voice-only indicator for it, in every layout but this one.
 */
func cameraUrlWorthStreaming(
    cameraHlsUrl: String?,
    hasVoiceAudio: Bool,
    layoutOffered: Bool,
    layout: CameraLayout
) -> String? {
    let hiddenAndSilent = layoutOffered && layout == .stream && !hasVoiceAudio
    return hiddenAndSilent ? nil : cameraHlsUrl
}

// MARK: - The swap rule

/// What the camera player currently holds, so the swap rule can tell a
/// restamp from a restart. Keyed on the playlist's own path rather than on
/// `LiveHlsStream.startedAt`: the camera shares its parent broadcast's
/// session and never mints an identity of its own on the wire.
struct CameraAttachedStream: Equatable, Sendable {
    let sessionKey: String
    let attachedAt: Date
}

enum CameraPlayerMove: Equatable, Sendable {
    case keep
    case attach(hlsUrl: String)
    case detach
}

/// The camera's own `hlsSessionKey`: everything before the `?`, which is
/// where the server's per-viewer, per-keyframe `?t=` restamp lives. Mirrors
/// `hlsSessionKey` in `client/src/lib/hls-playback.ts`.
func cameraSessionKey(_ url: String) -> String {
    guard let query = url.firstIndex(of: "?") else { return url }
    return String(url[url.startIndex..<query])
}

/**
 WHEN TO HAND THE CAMERA'S `AVPlayer` A DIFFERENT URL, AND, MOSTLY, WHEN NOT
 TO.

 Same shape as `WatchStreamSwap`, and the same bug it exists to avoid: the
 server restamps `cameraHlsUrl`'s `?t=` on the same audience-keyframe clock as
 the film's, about every 30 seconds, for a camera that has not moved at all.
 Rebuilding the player on every restamp would tear it down, drop the buffer
 and blank the corner on that cadence for the whole party.

 A camera with no picture and no voice track is not drawn at all
 (`.detach`); the caller decides whether to even ask (see
 `cameraLayoutOffered`), this only decides the URL once it has.
 */
enum WatchCameraStreamSwap {
    /// Same margin as `WatchStreamSwap.renewAfter`: the viewer token lives an
    /// hour, and this refreshes comfortably inside it rather than at the
    /// edge of expiry.
    static let renewAfter: TimeInterval = 50 * 60

    static func next(
        attached: CameraAttachedStream?,
        latestUrl: String?,
        hasVideo: Bool,
        hasVoiceAudio: Bool,
        failed: Bool,
        now: Date
    ) -> CameraPlayerMove {
        guard let latestUrl, hasVideo || hasVoiceAudio else { return .detach }
        let key = cameraSessionKey(latestUrl)
        guard let attached else { return .attach(hlsUrl: latestUrl) }
        if attached.sessionKey != key { return .attach(hlsUrl: latestUrl) }
        if failed { return .attach(hlsUrl: latestUrl) }
        if now.timeIntervalSince(attached.attachedAt) >= renewAfter {
            return .attach(hlsUrl: latestUrl)
        }
        return .keep
    }
}

// MARK: - The surface

/// One `AVPlayerLayer`, drawn plain. No PiP hookup, no fullscreen, no
/// autoresizing dance across a theater move: the camera never leaves its box.
final class CameraPlayerCanvas: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }

    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }

    var player: AVPlayer? {
        get { playerLayer.player }
        set { playerLayer.player = newValue }
    }
}

/// The camera's rectangle. `fit` is `.resizeAspectFill` in the corner box
/// (a face fills a small circle better than it letterboxes in one) and
/// `.resizeAspect` when the camera IS the stage (`side`, `camera` layouts),
/// mirroring the web's `cameraPipBoxes` fit choice.
struct WatchCameraSurface: UIViewRepresentable {
    let player: AVPlayer?
    var fit: AVLayerVideoGravity = .resizeAspectFill

    func makeUIView(context: Context) -> CameraPlayerCanvas {
        let canvas = CameraPlayerCanvas()
        canvas.backgroundColor = .black
        canvas.playerLayer.videoGravity = fit
        canvas.player = player
        return canvas
    }

    func updateUIView(_ canvas: CameraPlayerCanvas, context: Context) {
        canvas.playerLayer.videoGravity = fit
        if canvas.player !== player { canvas.player = player }
    }
}
