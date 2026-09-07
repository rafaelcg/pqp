import SwiftUI

/// The strip a tucked-away voice channel leaves behind.
///
/// One tap brings the stage back; the two controls a person reaches for
/// without looking, mute and leave, are on it directly. Drawn once, from the
/// app root, at the bottom of whatever screen is up; the DM call's
/// `CallCollapsedBanner` lives on its own thread instead, because a DM call
/// has exactly one thread and a voice room does not.
struct VoiceCollapsedBanner: View {
    @Environment(VoiceModel.self) private var voice

    var body: some View {
        @Bindable var voice = voice

        return Button {
            voice.isCollapsed = false
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "speaker.wave.2.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Palette.inkDeep)
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(Palette.signal))

                VStack(alignment: .leading, spacing: 1) {
                    Text(voice.channelName ?? String(localized: "Voice"))
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paper)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.system(size: 10))
                        .foregroundStyle(subtitleColor)
                        .lineLimit(1)
                }

                Spacer()

                Button {
                    voice.isMuted.toggle()
                } label: {
                    Image(systemName: voice.isMuted ? ServerMute.selfMutedGlyph : "mic.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(voice.isMuted ? Palette.danger : Palette.paper)
                        .frame(width: 26, height: 26)
                        .background(Circle().fill(Palette.surfaceRaised))
                }
                .buttonStyle(.plain)
                .disabled(!voice.canToggleMute)
                .accessibilityIdentifier("voice.bannerMute")
                .accessibilityLabel(voice.isMuted ? "Unmute" : "Mute")

                Button {
                    Task { await voice.leave() }
                } label: {
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.inkDeep)
                        .frame(width: 26, height: 26)
                        .background(Circle().fill(Palette.danger))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("voice.bannerLeave")
                .accessibilityLabel("Leave")
            }
            .padding(.horizontal, Metrics.hPadding)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .fill(Palette.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                            .strokeBorder(Palette.border, lineWidth: 1)
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("voice.expand")
        .accessibilityLabel("Back to the voice channel")
    }

    private var subtitle: String {
        switch voice.status {
        case .idle: String(localized: "Not connected")
        case .joining: String(localized: "Connecting…")
        case .connected:
            voice.peers.isEmpty
                ? String(localized: "You're the only one here")
                : String(localized: "\(voice.participantCount) in this channel")
        case .failed(let message): message
        }
    }

    private var subtitleColor: Color {
        if case .failed = voice.status { return Palette.danger }
        return Palette.paperMuted
    }
}
