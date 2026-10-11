import SwiftUI
import WebRTC
import LiveKit

/// One video track, from whichever transport the room runs on.
///
/// The mesh hands the UI an `RTCVideoTrack`; a LiveKit room hands it one of
/// the SDK's `VideoTrack`s, and the two are drawn by two different renderers
/// from two different WebRTC builds. Everything above the renderer (the stage,
/// the tiles, the fullscreen share) cares only that there is a picture, so this
/// is the one type it sees.
///
/// `@unchecked Sendable` for the same reason `UncheckedBox` exists: both
/// payloads are reference types whose *identity* is the value (it is what a
/// renderer attaches to), handed from a transport actor to the main actor once
/// and only read there.
enum VideoFeed: @unchecked Sendable, Equatable {
    case mesh(RTCVideoTrack)
    case livekit(VideoTrack)

    static func == (lhs: VideoFeed, rhs: VideoFeed) -> Bool {
        switch (lhs, rhs) {
        case (.mesh(let a), .mesh(let b)): a === b
        case (.livekit(let a), .livekit(let b)): a === b
        default: false
        }
    }
}

/// Draws one video track.
///
/// Picks the renderer that matches the track's transport; the two never mix,
/// because a room has exactly one transport. Both branches follow the same
/// rule, which is the whole job here: attach on appear and, crucially,
/// *detach* on disappear, because a track keeps a strong reference to every
/// renderer added to it. Leave one attached and the view outlives the call,
/// still decoding frames.
struct VideoSurface: View {
    let track: VideoFeed?
    /// `.scaleAspectFill` crops to fill (right for a self-preview tile),
    /// `.scaleAspectFit` letterboxes (the only honest way to show a shared
    /// screen, whose aspect ratio is not ours to choose).
    var contentMode: UIView.ContentMode = .scaleAspectFill
    /// Mirrored, like every self-view on a phone. Never applied to a remote
    /// track: you are the only person you see reversed in real life.
    var mirrored: Bool = false
    /// The picture's size once it is the right way up, whenever it changes.
    /// For a caller that chooses fill or fit by the picture's shape
    /// (`cameraStageShouldFill`); nil for everyone else.
    var onVideoSize: (@MainActor (CGSize) -> Void)?

    var body: some View {
        switch track {
        case .mesh(let track):
            MeshVideoSurface(
                track: track, contentMode: contentMode, mirrored: mirrored,
                onVideoSize: onVideoSize
            )
        case .livekit(let track):
            LiveKitVideoSurface(
                track: track, contentMode: contentMode, mirrored: mirrored,
                onVideoSize: onVideoSize
            )
        case nil:
            Color.clear
        }
    }
}

/// The mesh renderer.
///
/// `RTCMTLVideoView` rather than `RTCEAGLVideoView`: the GL view is deprecated
/// and, on a call showing two streams at once, noticeably hotter. It is a plain
/// `UIView` subclass that implements `RTCVideoRenderer`.
private struct MeshVideoSurface: UIViewRepresentable {
    let track: RTCVideoTrack
    var contentMode: UIView.ContentMode
    var mirrored: Bool
    var onVideoSize: (@MainActor (CGSize) -> Void)?

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView(frame: .zero)
        view.videoContentMode = contentMode
        view.backgroundColor = .clear
        view.delegate = context.coordinator
        context.coordinator.onVideoSize = onVideoSize
        // The renderer is attached in updateUIView, which SwiftUI always calls
        // right after make, so keeping attach/detach in one place means one rule
        // to get right instead of two.
        context.coordinator.attach(track: track, to: view)
        return view
    }

    func updateUIView(_ view: RTCMTLVideoView, context: Context) {
        context.coordinator.onVideoSize = onVideoSize
        view.videoContentMode = contentMode
        view.transform = mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
        context.coordinator.attach(track: track, to: view)
    }

    static func dismantleUIView(_ view: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.detach(from: view)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Holds the currently-rendered track so a re-render with the same track is
    /// a no-op rather than a detach/attach flicker.
    ///
    /// Also the view's delegate, for the frame size. WebRTC's renderer adapter
    /// reports it already swapped for the frame's rotation, so a phone on its
    /// side reads as landscape here, which is the shape a person sees.
    @MainActor
    final class Coordinator: NSObject, RTCVideoViewDelegate {
        private var attached: RTCVideoTrack?
        var onVideoSize: (@MainActor (CGSize) -> Void)?

        // `RTCMTLVideoView.setSize:` hops to the main queue before calling.
        nonisolated func videoView(_ videoView: RTCVideoRenderer, didChangeVideoSize size: CGSize) {
            MainActor.assumeIsolated {
                self.onVideoSize?(size)
            }
        }

        func attach(track: RTCVideoTrack?, to view: RTCMTLVideoView) {
            guard attached !== track else { return }
            attached?.remove(view)
            attached = track
            track?.add(view)
        }

        func detach(from view: RTCMTLVideoView) {
            attached?.remove(view)
            attached = nil
        }
    }
}

/// The LiveKit renderer: the SDK's own `VideoView`, which takes the track as a
/// property and does its own attaching, so the job here is only to hand it the
/// right track and to take it away when the view goes.
private struct LiveKitVideoSurface: UIViewRepresentable {
    let track: VideoTrack
    var contentMode: UIView.ContentMode
    var mirrored: Bool
    var onVideoSize: (@MainActor (CGSize) -> Void)?

    func makeUIView(context: Context) -> LiveKit.VideoView {
        let view = LiveKit.VideoView(frame: .zero)
        view.backgroundColor = .clear
        apply(to: view)
        context.coordinator.onVideoSize = onVideoSize
        context.coordinator.watch(track)
        return view
    }

    func updateUIView(_ view: LiveKit.VideoView, context: Context) {
        context.coordinator.onVideoSize = onVideoSize
        apply(to: view)
        context.coordinator.watch(track)
    }

    static func dismantleUIView(_ view: LiveKit.VideoView, coordinator: Coordinator) {
        view.track = nil
        coordinator.watch(nil)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// The SDK's track knows its rendered size (rotation applied, set by the
    /// `VideoView` drawing it) and announces changes to its delegates, from
    /// whichever queue it is on. Only listened to while a caller asked.
    final class Coordinator: NSObject, TrackDelegate, @unchecked Sendable {
        @MainActor var onVideoSize: (@MainActor (CGSize) -> Void)?
        @MainActor private var watched: VideoTrack?

        @MainActor
        func watch(_ track: VideoTrack?) {
            guard watched !== track else { return }
            watched?.remove(delegate: self)
            watched = track
            guard let track else { return }
            track.add(delegate: self)
            if let dimensions = track.dimensions {
                report(dimensions)
            }
        }

        @MainActor
        private func report(_ dimensions: Dimensions) {
            onVideoSize?(CGSize(width: Int(dimensions.width), height: Int(dimensions.height)))
        }

        nonisolated func track(_ track: VideoTrack, didUpdateDimensions dimensions: Dimensions?) {
            guard let dimensions else { return }
            Task { @MainActor [weak self] in
                guard let self, self.watched === track else { return }
                self.report(dimensions)
            }
        }
    }

    private func apply(to view: LiveKit.VideoView) {
        view.layoutMode = contentMode == .scaleAspectFit ? .fit : .fill
        // `.auto` mirrors any local camera track, which is exactly the rule the
        // mesh surface applies by hand. `.off` is for remote tracks that must
        // never be flipped.
        view.mirrorMode = mirrored ? .mirror : .off
        if view.track !== track {
            view.track = track
        }
    }
}

/// A video tile with the app's ground behind it, so a track that has not
/// produced its first frame reads as "connecting" rather than a hole.
struct VideoTile: View {
    let track: VideoFeed?
    var contentMode: UIView.ContentMode = .scaleAspectFill
    var mirrored: Bool = false
    var onVideoSize: (@MainActor (CGSize) -> Void)?

    var body: some View {
        ZStack {
            Palette.inkDeep
            if let track {
                VideoSurface(
                    track: track, contentMode: contentMode, mirrored: mirrored,
                    onVideoSize: onVideoSize
                )
            }
        }
    }
}
