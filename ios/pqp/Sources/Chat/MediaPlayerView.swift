import SwiftUI
import AVKit

/// Full-screen playback for a video or audio attachment.
///
/// Attachment URLs are presigned and expire (`ATTACHMENT_URL_TTL_SECONDS`), so
/// a message scrolled back to an hour later carries a dead link. The web client
/// refetches the URL once on failure and then gives up; this does the same —
/// once, not in a loop, because a 404 for a deleted attachment would otherwise
/// hammer the API forever.
struct MediaPlayerView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let attachment: Attachment

    @State private var player: AVPlayer?
    @State private var failed = false
    @State private var refetched = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()

            if let player {
                VideoPlayer(player: player)
                    .ignoresSafeArea()
            } else if failed {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 30))
                        .foregroundStyle(Palette.warning)
                    Text("Could not play this file.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.paperMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView().tint(Palette.signal)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            Button {
                player?.pause()
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(Palette.paper, Palette.surfaceRaised)
            }
            .accessibilityLabel("Close")
            .padding(16)
        }
        .task { await start(with: attachment.url) }
        .onDisappear { player?.pause() }
    }

    private func start(with urlString: String) async {
        guard let url = URL(string: urlString) else {
            failed = true
            return
        }
        // The asset is probed before handing it to the player: AVPlayer's own
        // failure surfaces as a status change buried in KVO, and an expired
        // presigned URL needs to be caught *here* so the refetch can happen.
        let asset = AVURLAsset(url: url)
        do {
            let playable = try await asset.load(.isPlayable)
            guard playable else { throw APIError.transport("Not playable") }
            let item = AVPlayerItem(asset: asset)
            let player = AVPlayer(playerItem: item)
            self.player = player
            player.play()
        } catch {
            await refetchOnce()
        }
    }

    /// One retry with a freshly signed URL, then the honest failure state.
    private func refetchOnce() async {
        guard !refetched else {
            failed = true
            return
        }
        refetched = true
        do {
            let fresh = try await session.api.attachmentUrl(id: attachment.id)
            await start(with: fresh)
        } catch {
            failed = true
        }
    }
}
