import SwiftUI

struct ChannelListView: View {
    @Environment(SessionStore.self) private var session
    let server: Server

    @State private var channels: [Channel] = []
    @State private var unread: [String: UnreadEntry] = [:]
    @State private var isLoading = true
    @State private var error: String?

    private var textChannels: [Channel] { channels.filter(\.isText) }
    private var voiceChannels: [Channel] { channels.filter(\.isVoice) }

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            if isLoading && channels.isEmpty {
                ProgressView().tint(Palette.signal)
            } else if let error {
                EmptyState(
                    icon: "exclamationmark.triangle",
                    title: "Could not load channels",
                    message: error,
                    actionTitle: "Try again",
                    action: { Task { await load() } }
                )
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        if !textChannels.isEmpty {
                            SectionLabel(text: "Text")
                                .padding(.horizontal, 4)
                                .padding(.top, 4)
                            ForEach(textChannels) { channel in
                                NavigationLink {
                                    ChatView(channelId: channel.id, title: "#\(channel.name)")
                                } label: {
                                    ChannelRow(channel: channel, unread: unread[channel.id])
                                }
                                .buttonStyle(.plain)
                            }
                        }

                        if !voiceChannels.isEmpty {
                            SectionLabel(text: "Voice")
                                .padding(.horizontal, 4)
                                .padding(.top, 12)
                            ForEach(voiceChannels) { channel in
                                // Voice is a later phase. Shown, but honest
                                // about not being connectable yet rather than
                                // hidden — the channels exist on the server and
                                // pretending otherwise is more confusing.
                                ChannelRow(channel: channel, unread: nil, isDisabled: true)
                            }
                        }
                    }
                    .padding(.horizontal, Metrics.hPadding)
                    .padding(.top, 8)
                }
                .refreshable { await load() }
            }
        }
        .navigationTitle(server.name)
        .navigationBarTitleDisplayMode(.large)
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        error = nil
        do {
            channels = try await session.api.channels(serverId: server.id)
            // Unread is a separate call and failing it must not blank the
            // channel list — badges are a nicety, the list is the screen.
            if let entries = try? await session.api.unread(serverId: server.id) {
                unread = Dictionary(uniqueKeysWithValues: entries.map { ($0.channelId, $0) })
            }
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }
}

struct ChannelRow: View {
    let channel: Channel
    let unread: UnreadEntry?
    var isDisabled: Bool = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: channel.isVoice ? "speaker.wave.2.fill" : "number")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(isDisabled ? Palette.paperMuted.opacity(0.5) : Palette.paperMuted)
                .frame(width: 20)

            Text(channel.name)
                .font(Typography.bodyMedium)
                .foregroundStyle(isDisabled ? Palette.paperMuted : Palette.paper)
                .lineLimit(1)

            if channel.isPrivate {
                Image(systemName: "lock.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.paperMuted)
            }

            Spacer()

            if isDisabled {
                Text("SOON")
                    .font(Typography.label)
                    .tracking(1)
                    .foregroundStyle(Palette.paperMuted)
            } else if let unread, unread.count > 0 {
                UnreadBadge(count: unread.count, isMention: unread.mentions > 0)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
        .opacity(isDisabled ? 0.65 : 1)
    }
}
