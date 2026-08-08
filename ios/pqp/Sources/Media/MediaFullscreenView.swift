import AVKit
import SwiftUI

/// Fullscreen native viewer for one attachment: pinch-zoom and interactive
/// swipe-down-to-dismiss for images and GIFs (which keep animating), AVKit
/// playback for video.
///
/// `QLPreviewController` was the first thing tried here — it is the obvious
/// "free" native widget for exactly this (zoom, swipe-to-dismiss, video
/// controls, all for nothing). It was dropped for one specific reason: Quick
/// Look renders an animated GIF as its first frame only, same as SwiftUI's
/// own `Image`. That is precisely the bug this file exists to fix, so a
/// framework that reintroduces it for the fullscreen case specifically was a
/// non-starter. A hand-rolled `UIScrollView` (`ZoomableMediaView`) gets real
/// pinch zoom without that trade-off, and shares the same GIF player
/// (`AnimatingImageView`) used inline in chat and in the GIF picker, so the
/// decode-and-animate path is identical everywhere it matters.
struct MediaFullscreenView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let attachment: Attachment

    @State private var phase: Phase = .loading
    @State private var refetched = false
    @State private var dragProgress: CGFloat = 0
    @State private var player: AVPlayer?
    @State private var videoDragOffset: CGFloat = 0

    private enum Phase {
        case loading
        case image(UIImage)
        case gif(frames: [GIFFrame], key: String)
        case video(URL)
        case failed
    }

    var body: some View {
        ZStack {
            Color.black
                .opacity(1 - dragProgress * 0.6)
                .ignoresSafeArea()

            content

            closeButton
                .opacity(1 - dragProgress)
        }
        .statusBarHidden()
        .task { await load() }
        .onDisappear { player?.pause() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            ProgressView().tint(Palette.signal)
        case .failed:
            VStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 30))
                    .foregroundStyle(Palette.warning)
                Text("Could not load this file.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
            }
        case .image(let image):
            ZoomableMedia(
                payload: .image(image),
                onDragProgress: { dragProgress = $0 },
                onDismiss: { dismiss() }
            )
        case .gif(let frames, let key):
            ZoomableMedia(
                payload: .gif(frames: frames, key: key),
                onDragProgress: { dragProgress = $0 },
                onDismiss: { dismiss() }
            )
        case .video:
            videoContent
        }
    }

    @ViewBuilder
    private var videoContent: some View {
        if let player {
            VideoPlayer(player: player)
                .ignoresSafeArea()
                .offset(y: videoDragOffset)
                .opacity(1 - dragProgress)
                .gesture(videoDismissGesture)
        }
    }

    /// Video has no zoom, so the swipe-to-dismiss can stay a plain SwiftUI
    /// drag gesture instead of `ZoomableMediaView`'s scroll-view-aware pan —
    /// there is no scroll view here to fight over touches with.
    private var videoDismissGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                guard value.translation.height > 0 else { return }
                videoDragOffset = value.translation.height
                dragProgress = min(value.translation.height / 280, 1)
            }
            .onEnded { value in
                if value.translation.height > 140 || value.predictedEndTranslation.height > 400 {
                    player?.pause()
                    dismiss()
                } else {
                    withAnimation(Motion.standard) {
                        videoDragOffset = 0
                        dragProgress = 0
                    }
                }
            }
    }

    private var closeButton: some View {
        VStack {
            HStack {
                Spacer()
                Button {
                    player?.pause()
                    dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(Palette.paper, Palette.surfaceRaised.opacity(0.9))
                }
                .accessibilityLabel("Close")
                .padding(16)
            }
            Spacer()
        }
    }

    // MARK: - Loading

    private func load() async {
        guard let url = URL(string: attachment.url) else {
            phase = .failed
            return
        }
        if attachment.isVideo {
            await loadVideo(url: url)
        } else {
            await loadImageOrGif(url: url)
        }
    }

    private func loadImageOrGif(url: URL) async {
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw APIError.transport("Bad response")
            }
            if attachment.isGif {
                let frames = await AnimatedImageCache.shared.decodeAndStore(data: data, key: url.absoluteString)
                if frames.isEmpty {
                    phase = .failed
                } else {
                    phase = .gif(frames: frames, key: url.absoluteString)
                }
            } else if let image = UIImage(data: data) {
                phase = .image(image)
            } else {
                phase = .failed
            }
        } catch {
            await refetchOnce()
        }
    }

    /// Probes playability before handing the asset to `AVPlayer`, same as
    /// `MediaPlayerView`: an expired presigned URL needs to be caught here so
    /// the one-time refetch can run, rather than surfacing as a KVO status
    /// change with no obvious next step.
    private func loadVideo(url: URL) async {
        let asset = AVURLAsset(url: url)
        do {
            let playable = try await asset.load(.isPlayable)
            guard playable else { throw APIError.transport("Not playable") }
            let item = AVPlayerItem(asset: asset)
            let newPlayer = AVPlayer(playerItem: item)
            player = newPlayer
            phase = .video(url)
            newPlayer.play()
        } catch {
            await refetchOnce()
        }
    }

    /// One retry with a freshly signed URL, then an honest failure state —
    /// matches the rest of the app's presigned-URL refresh convention.
    private func refetchOnce() async {
        guard !refetched else {
            phase = .failed
            return
        }
        refetched = true
        do {
            let fresh = try await session.api.attachmentUrl(id: attachment.id)
            guard let url = URL(string: fresh) else {
                phase = .failed
                return
            }
            if attachment.isVideo {
                await loadVideo(url: url)
            } else {
                await loadImageOrGif(url: url)
            }
        } catch {
            phase = .failed
        }
    }
}
