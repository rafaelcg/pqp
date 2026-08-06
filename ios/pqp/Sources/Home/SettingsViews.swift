import SwiftUI

/// Everything about you: profile, notifications, blocked people.
struct AccountSettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss

    @State private var displayName = ""
    @State private var dmPrivacy = "server_members"
    @State private var preferences = UserPreferences()
    @State private var blocked: [PublicUser] = []
    @State private var saving = false
    @State private var saved = false
    @State private var error: String?

    private let privacyOptions = [
        ("everyone", "Anyone"),
        ("server_members", "People I share a server with"),
        ("nobody", "Nobody"),
    ]

    private let levels = [("all", "All messages"), ("mentions", "Only @mentions"), ("none", "Nothing")]

    var body: some View {
        NavigationStack {
            Form {
                Section("Profile") {
                    TextField("Display name", text: $displayName)
                    if let tag = session.currentUser?.tag {
                        LabeledContent("Handle", value: tag)
                    }
                }

                Section("Who can message you") {
                    Picker("Direct messages", selection: $dmPrivacy) {
                        ForEach(privacyOptions, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }

                Section("Notifications") {
                    Picker("Default", selection: Binding(
                        get: { preferences.notifications?.default ?? "all" },
                        set: { value in
                            var notifications = preferences.notifications ?? NotificationPreferences()
                            notifications.default = value
                            preferences.notifications = notifications
                        }
                    )) {
                        ForEach(levels, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    Toggle("Mute microphone when joining voice", isOn: Binding(
                        get: { preferences.muteOnJoin ?? false },
                        set: { preferences.muteOnJoin = $0 }
                    ))
                    Toggle("Show link previews", isOn: Binding(
                        get: { preferences.showLinkEmbeds ?? true },
                        set: { preferences.showLinkEmbeds = $0 }
                    ))
                }

                Section("Blocked") {
                    if blocked.isEmpty {
                        Text("Nobody blocked.").foregroundStyle(Palette.paperMuted)
                    }
                    ForEach(blocked) { user in
                        HStack {
                            Text(user.displayName)
                            Spacer()
                            Button("Unblock") {
                                Task {
                                    try? await session.api.setBlocked(userId: user.id, blocked: false)
                                    blocked.removeAll { $0.id == user.id }
                                }
                            }
                            .foregroundStyle(Palette.signal)
                        }
                    }
                }

                if let error {
                    Section { Text(error).foregroundStyle(Palette.danger) }
                }

                Section {
                    Button(saving ? "Saving…" : (saved ? "Saved" : "Save changes")) {
                        Task { await save() }
                    }
                    .disabled(saving)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.ink)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.tint(Palette.paperMuted)
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        displayName = session.currentUser?.displayName ?? ""
        dmPrivacy = session.currentUser?.dmPrivacy ?? "server_members"
        preferences = (try? await session.api.preferences()) ?? UserPreferences()
        blocked = (try? await session.api.blocks()) ?? []
    }

    private func save() async {
        saving = true
        saved = false
        error = nil
        do {
            // Two calls because the server keeps them apart: the profile is
            // columns, the preferences are one merged JSON blob.
            _ = try await session.api.updateProfile(
                displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
                dmPrivacy: dmPrivacy
            )
            preferences = try await session.api.updatePreferences(preferences)
            await session.refreshCurrentUser()
            saved = true
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        saving = false
    }
}

/// Owner/admin controls for a server.
struct ServerSettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let server: Server
    let onChanged: (Server) -> Void
    let onDeleted: () -> Void

    @State private var name = ""
    @State private var retention: Int?
    @State private var ssoDomain = ""
    @State private var audit: [AuditEntry] = []
    @State private var error: String?
    @State private var confirmingDelete = false
    @State private var deleteConfirmText = ""

    private var isOwner: Bool { server.role == "owner" }

    private let retentionOptions: [(Int?, String)] = [
        (nil, "Keep forever"), (30, "30 days"), (90, "90 days"), (365, "1 year"),
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Server name", text: $name)
                    Button("Rename") { Task { await rename() } }
                        .disabled(!isOwner || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }

                if isOwner {
                    Section("Message retention") {
                        Picker("Delete messages older than", selection: Binding(
                            get: { retention },
                            set: { value in
                                retention = value
                                Task { await setRetention(value) }
                            }
                        )) {
                            ForEach(retentionOptions, id: \.1) { option in
                                Text(option.1).tag(option.0)
                            }
                        }
                        Text("Pinned messages are never touched.")
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    }

                    Section("SSO email domain") {
                        TextField("acme.com", text: $ssoDomain)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        Button("Save domain") { Task { await saveSso() } }
                        Text("Anyone with a verified email at this domain can join without an invite.")
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    }
                }

                Section("Audit log") {
                    if audit.isEmpty {
                        Text("Nothing recorded yet.").foregroundStyle(Palette.paperMuted)
                    }
                    ForEach(audit.prefix(30)) { entry in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(entry.actorName ?? "A departed account") \(AuditLabels.describe(entry.action))")
                                .font(Typography.callout)
                            Text(entry.createdAt, format: .dateTime.day().month().hour().minute())
                                .font(Typography.caption)
                                .foregroundStyle(Palette.paperMuted)
                        }
                    }
                }

                if let error {
                    Section { Text(error).foregroundStyle(Palette.danger) }
                }

                if isOwner {
                    Section {
                        Button("Delete server", role: .destructive) { confirmingDelete = true }
                    } footer: {
                        Text("Every channel, message, and invite is deleted for everyone.")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.ink)
            .navigationTitle("Server settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.tint(Palette.paperMuted)
                }
            }
            .alert("Delete \(server.name)?", isPresented: $confirmingDelete) {
                // Typed confirmation, matching the web client: a destructive
                // action this total should cost more than one tap.
                TextField("Type the server name", text: $deleteConfirmText)
                Button("Cancel", role: .cancel) { deleteConfirmText = "" }
                Button("Delete forever", role: .destructive) {
                    guard deleteConfirmText == server.name else { return }
                    Task { await deleteServer() }
                }
            } message: {
                Text("This cannot be undone. Type \"\(server.name)\" to confirm.")
            }
            .task {
                name = server.name
                retention = server.messageRetentionDays
                ssoDomain = server.ssoEmailDomain ?? ""
                audit = (try? await session.api.auditLog(serverId: server.id)) ?? []
            }
        }
    }

    private func rename() async {
        do {
            onChanged(try await session.api.renameServer(id: server.id, name: name))
        } catch { self.error = message(error) }
    }

    private func setRetention(_ days: Int?) async {
        do {
            onChanged(try await session.api.setRetention(serverId: server.id, days: days))
        } catch { self.error = message(error) }
    }

    private func saveSso() async {
        let trimmed = ssoDomain.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            onChanged(try await session.api.setSsoDomain(
                serverId: server.id, domain: trimmed.isEmpty ? nil : trimmed
            ))
        } catch { self.error = message(error) }
    }

    private func deleteServer() async {
        do {
            try await session.api.deleteServer(id: server.id)
            onDeleted()
            dismiss()
        } catch { self.error = message(error) }
    }

    private func message(_ error: any Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}

/// Audit actions are an enum on the wire; this is the human phrasing.
///
/// Kept in one place because the web client learned the hard way that adding an
/// action without adding its label renders the raw enum string to users.
enum AuditLabels {
    private static let map: [String: String] = [
        "member.kick": "kicked a member",
        "member.ban": "banned a member",
        "member.unban": "unbanned a member",
        "member.role_update": "changed a member's role",
        "member.sso_join": "joined via SSO email domain",
        "channel.create": "created a channel",
        "channel.update": "updated a channel",
        "channel.delete": "deleted a channel",
        "channel.move": "reordered a channel",
        "message.delete": "deleted someone's message",
        "server.update": "renamed the server",
        "server.retention_update": "changed message retention",
        "server.sso_domain_update": "changed the SSO email domain",
        "server.ownership_transfer": "transferred ownership",
        "server.data_export": "exported the server's data",
        "invite.create": "created an invite",
        "invite.delete": "revoked an invite",
        "webhook.create": "created a webhook",
        "webhook.delete": "deleted a webhook",
    ]

    static func describe(_ action: String) -> String {
        map[action] ?? action
    }
}

/// Incoming webhooks for a channel.
struct WebhooksView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    let channel: Channel

    @State private var webhooks: [Webhook] = []
    @State private var name = ""
    @State private var loading = true
    @State private var error: String?
    @State private var copied: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()
                VStack(spacing: 12) {
                    HStack(spacing: 8) {
                        TextField("Build Bot", text: $name)
                            .textFieldStyle(.plain)
                            .foregroundStyle(Palette.paper)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 11)
                            .pqpSurface(cornerRadius: 20)
                        Button("Create") { Task { await create() } }
                            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                            .foregroundStyle(Palette.signal)
                    }
                    .padding(.horizontal, Metrics.hPadding)

                    if let error {
                        Text(error).font(Typography.callout).foregroundStyle(Palette.danger)
                    }

                    if loading {
                        ProgressView().tint(Palette.signal)
                    } else if webhooks.isEmpty {
                        Text("No webhooks yet. Anything that can POST JSON can post here.")
                            .font(Typography.callout)
                            .foregroundStyle(Palette.paperMuted)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }

                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(webhooks) { webhook in
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        Text(webhook.name)
                                            .font(Typography.bodyMedium)
                                            .foregroundStyle(Palette.paper)
                                        Spacer()
                                        Button("Delete", role: .destructive) {
                                            Task { await remove(webhook) }
                                        }
                                        .font(Typography.caption)
                                        .foregroundStyle(Palette.danger)
                                    }
                                    HStack {
                                        Text(fullUrl(webhook))
                                            .font(.system(size: 11, design: .monospaced))
                                            .foregroundStyle(Palette.paperMuted)
                                            .lineLimit(1)
                                        Spacer()
                                        Button(copied == webhook.id ? "Copied" : "Copy") {
                                            UIPasteboard.general.string = fullUrl(webhook)
                                            copied = webhook.id
                                        }
                                        .font(Typography.caption)
                                        .foregroundStyle(Palette.signal)
                                    }
                                }
                                .padding(12)
                                .pqpSurface()
                            }
                        }
                        .padding(.horizontal, Metrics.hPadding)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 8)
            }
            .navigationTitle("Webhooks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.tint(Palette.paperMuted)
                }
            }
            .task { await load() }
        }
    }

    /// The server returns a path, not a URL — it cannot know its own public
    /// origin — so the base is added here.
    private func fullUrl(_ webhook: Webhook) -> String {
        Backend.current.apiBaseURL.absoluteString + webhook.url
    }

    private func load() async {
        loading = true
        do {
            webhooks = try await session.api.webhooks(channelId: channel.id)
            error = nil
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        loading = false
    }

    private func create() async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        name = ""
        do {
            webhooks.append(try await session.api.createWebhook(channelId: channel.id, name: trimmed))
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func remove(_ webhook: Webhook) async {
        do {
            try await session.api.deleteWebhook(id: webhook.id)
            webhooks.removeAll { $0.id == webhook.id }
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
