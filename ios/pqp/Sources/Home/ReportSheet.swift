import SwiftUI

/// What is being reported. The server keys the two shapes on `subjectType`;
/// this is the same discriminated union with Swift's spelling.
enum ReportTarget: Identifiable, Hashable {
    case message(id: String, authorName: String)
    case user(id: String, displayName: String, serverId: String?)
    /// A whole community, reported off its directory card by somebody who has
    /// not gone inside — which is the point of it. This one does NOT reach the
    /// server's own moderators: `resolveServerSubject` routes a community report
    /// to the instance queue, because a complaint about a room is not something
    /// its owner should be the judge of.
    case community(serverId: String, name: String)

    var id: String {
        switch self {
        case .message(let id, _): "message-\(id)"
        case .user(let id, _, _): "user-\(id)"
        case .community(let serverId, _): "server-\(serverId)"
        }
    }
}

/// One report flow for both subjects: pick a reason, optionally say more,
/// submit. A duplicate report answers 200 and reads as success here too —
/// "we already have this" is not a failure the reporter can act on.
struct ReportSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let target: ReportTarget

    @State private var reason: ReportReason?
    @State private var details = ""
    @State private var submitting = false
    @State private var sent = false
    @State private var error: String?

    private var subjectLine: String {
        switch target {
        case .message(_, let authorName):
            String(localized: "Report a message by \(authorName)")
        case .user(_, let displayName, _):
            String(localized: "Report \(displayName)")
        case .community(_, let name):
            String(localized: "Report the community \(name)")
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()

                if sent {
                    VStack(spacing: 12) {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 40))
                            .foregroundStyle(Palette.success)
                        Text("Report sent")
                            .font(Typography.title(20))
                            .foregroundStyle(Palette.paper)
                        Text("The moderators will take a look. You won't be named to the person you reported.")
                            .font(Typography.callout)
                            .foregroundStyle(Palette.paperMuted)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 300)
                        Button("Done") { dismiss() }
                            .buttonStyle(PrimaryButtonStyle())
                            .padding(.horizontal, 24)
                            .padding(.top, 8)
                    }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            Text(subjectLine)
                                .font(Typography.bodyMedium)
                                .foregroundStyle(Palette.paper)

                            SectionLabel(text: String(localized: "Why?"))

                            VStack(spacing: 6) {
                                ForEach(ReportReason.allCases) { choice in
                                    Button {
                                        reason = choice
                                    } label: {
                                        HStack {
                                            Text(choice.label)
                                                .font(Typography.body)
                                                .foregroundStyle(Palette.paper)
                                            Spacer()
                                            if reason == choice {
                                                Image(systemName: "checkmark.circle.fill")
                                                    .foregroundStyle(Palette.signal)
                                            }
                                        }
                                        .padding(12)
                                        .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }

                            SectionLabel(text: String(localized: "Anything else? (optional)"))

                            TextField("What happened?", text: $details, axis: .vertical)
                                .lineLimit(3...6)
                                .font(Typography.body)
                                .foregroundStyle(Palette.paper)
                                .padding(12)
                                .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)

                            if let error {
                                Text(error)
                                    .font(Typography.callout)
                                    .foregroundStyle(Palette.danger)
                            }

                            Button(submitting ? "Sending…" : "Send report") {
                                Task { await submit() }
                            }
                            .buttonStyle(PrimaryButtonStyle(isEnabled: reason != nil))
                            .disabled(reason == nil || submitting)
                            .padding(.top, 6)
                        }
                        .padding(.horizontal, Metrics.hPadding)
                        .padding(.top, 12)
                    }
                }
            }
            .navigationTitle("Report")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.tint(Palette.paperMuted)
                }
            }
        }
    }

    private func submit() async {
        guard let reason else { return }
        submitting = true
        error = nil
        let trimmed = details.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            switch target {
            case .message(let id, _):
                try await session.api.reportMessage(
                    messageId: id, reason: reason.rawValue,
                    details: trimmed.isEmpty ? nil : trimmed
                )
            case .user(let id, _, let serverId):
                try await session.api.reportUser(
                    userId: id, serverId: serverId, reason: reason.rawValue,
                    details: trimmed.isEmpty ? nil : trimmed
                )
            case .community(let serverId, _):
                try await session.api.reportCommunity(
                    serverId: serverId, reason: reason.rawValue,
                    details: trimmed.isEmpty ? nil : trimmed
                )
            }
            sent = true
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        submitting = false
    }
}
