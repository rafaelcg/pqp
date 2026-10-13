import SwiftUI

/// BOT and BETA beside a server bot's name. The native v1 mark: a bot's
/// messages and its member row say what it is, and that it is in beta.
struct ServerBotTags: View {
    var body: some View {
        HStack(spacing: 4) {
            Text("Bot")
                .font(.system(size: 9, weight: .bold))
                .textCase(.uppercase)
                .tracking(0.6)
                .foregroundStyle(Palette.signal)
                .padding(.horizontal, 4)
                .padding(.vertical, 1.5)
                .background(Capsule().fill(Palette.signal.opacity(0.16)))
                .accessibilityIdentifier("bot.tag")
            Text("Beta")
                .font(.system(size: 9, weight: .semibold))
                .textCase(.uppercase)
                .tracking(0.6)
                .foregroundStyle(Palette.paperMuted)
                .padding(.horizontal, 4)
                .padding(.vertical, 1.5)
                .background(Capsule().fill(Palette.border.opacity(0.6)))
                .accessibilityIdentifier("bot.beta")
        }
        .accessibilityElement(children: .combine)
    }
}

/// What a server bot is doing, in place of "is typing": its name with the
/// tags, and "Thinking…" or the tool it is running.
struct BotActivityRows: View {
    let work: [BotWork]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(work, id: \.userId) { bot in
                HStack(spacing: 8) {
                    TypingDots()
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(verbatim: bot.name)
                                .font(Typography.caption)
                                .fontWeight(.bold)
                                .foregroundStyle(Palette.paper)
                            ServerBotTags()
                        }
                        Text(verbatim: bot.line)
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    }
                    Spacer()
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("chat.botActivity")
            }
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.bottom, 4)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }
}

/// The limit notice, above the composer and only on this member's screen.
struct BotNoticeRow: View {
    let notice: BotNotice
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "clock")
                .font(.system(size: 12))
                .foregroundStyle(Palette.paperMuted)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: notice.text())
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paper)
                HStack(spacing: 4) {
                    Image(systemName: "eye.slash").font(.system(size: 10))
                    Text("Only you can see this.")
                }
                .font(.system(size: 11))
                .foregroundStyle(Palette.paperMuted)
            }
            Spacer()
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Palette.paperMuted)
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 8)
        .background(Palette.surfaceRaised)
        .accessibilityIdentifier("chat.botNotice")
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
