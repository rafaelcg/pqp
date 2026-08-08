import PhotosUI
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
        ("server_members", "People I share a community with"),
        ("nobody", "Nobody"),
    ]

    private let levels = [("all", "All messages"), ("mentions", "Only @mentions"), ("none", "Nothing")]

    var body: some View {
        NavigationStack {
            Form {
                Section("Profile") {
                    AvatarRow()
                    TextField("Display name", text: $displayName)
                    if let tag = session.currentUser?.tag {
                        // `name#1234`, which is how somebody adds you INSIDE the
                        // app. Deliberately labelled apart from the public link
                        // below: two name fields in one form is a design smell,
                        // so each has to say what it is for.
                        LabeledContent("Tag", value: tag)
                    }
                    HandleRow()
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

/// The public handle — `pqp.gg/@rafa` — claimed, copied and shared.
///
/// ITS OWN VIEW, AND ITS OWN SAVE, for the same reason `AvatarRow` is: this does
/// not share the form's save cycle. A handle claim is the one field here that
/// can fail for a reason nothing else can — somebody else already holds it — and
/// a collision must never be swept into a retry of the whole profile. The
/// server's PATCH handler splits it for exactly that reason; this is the client
/// half of the same split.
///
/// WHAT IS DRAWN DEPENDS ON WHETHER ONE IS HELD. With a handle it is a LINK: a
/// piece of text you own, with Copy and Share beside it. Without one it is a
/// FIELD: a thing you are editing, which you can abandon. Collapsing the two
/// would mean a copy button that copies a draft.
private struct HandleRow: View {
    @Environment(SessionStore.self) private var session

    @State private var typed = ""
    @State private var busy = false
    @State private var error: String?
    @State private var copied = false

    private var handle: String? {
        guard let held = session.currentUser?.handle, !held.isEmpty else { return nil }
        return held
    }

    /// Nil while the account has never claimed one, or once the window is over.
    private var renameAvailableAt: Date? {
        guard !HandleRules.canRename(
            changedAt: session.currentUser?.handleChangedDate,
            currentHandle: handle
        ) else { return nil }
        return HandleRules.renameAvailableAt(
            changedAt: session.currentUser?.handleChangedDate,
            currentHandle: handle
        )
    }

    /// The mirror's verdict on what is typed, or nil while it is too short to
    /// judge — nagging somebody who has entered two characters of a name they
    /// have not finished is noise, not help.
    private var localRefusal: String? {
        guard typed.count >= HandleRules.minLength else { return nil }
        return HandleRules.validate(typed).map(HandleRules.message(for:))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let handle {
                // A plain row rather than `LabeledContent`: that container
                // rewrites its value view into the row's own accessibility
                // element, which swallows the identifier and leaves the link
                // unaddressable from a UI test.
                VStack(alignment: .leading, spacing: 3) {
                    Text("Public link")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                    Text(HandleRules.displayUrl(handle))
                        .font(Typography.mono)
                        .foregroundStyle(Palette.signal)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("settings.handle.url")
                }

                HStack(spacing: 16) {
                    Button(copied ? "Copied" : "Copy") {
                        UIPasteboard.general.string =
                            HandleRules.shareUrl(handle)?.absoluteString
                        copied = true
                    }
                    .font(Typography.caption)
                    .foregroundStyle(Palette.signal)
                    .accessibilityIdentifier("settings.handle.copy")

                    if let url = HandleRules.shareUrl(handle) {
                        // The point of a handle is that it travels — by
                        // WhatsApp, by screenshot, by being read aloud. On a
                        // phone the share sheet IS how a link leaves the app.
                        ShareLink(item: url) {
                            Text("Share")
                                .font(Typography.caption)
                                .foregroundStyle(Palette.signal)
                        }
                        .accessibilityIdentifier("settings.handle.share")
                    }
                }

                if let available = renameAvailableAt {
                    // The anti-squatting rule, stated as a date rather than as a
                    // refusal: without it, one account can hold every desirable
                    // handle in rotation.
                    Text("You can change it again from \(available, format: .dateTime.day().month(.wide).year()).")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.warning)
                } else {
                    claimField(label: String(localized: "Change it"))
                }
            } else {
                Text("Claim a public link. Anyone can open it, even without an account.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                claimField(label: String(localized: "Claim your link"))
            }

            if let message = error ?? localRefusal {
                Text(message)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.danger)
            }
        }
        .onChange(of: copied) { _, isCopied in
            guard isCopied else { return }
            Task {
                try? await Task.sleep(for: .seconds(2))
                copied = false
            }
        }
    }

    @ViewBuilder
    private func claimField(label: String) -> some View {
        HStack(spacing: 0) {
            Text("pqp.gg/@")
                .font(Typography.mono)
                .foregroundStyle(Palette.paperMuted)
            TextField("seunome", text: $typed)
                .font(Typography.mono)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("settings.handle.field")
                .accessibilityLabel(Text(label))
                // Normalised on every keystroke rather than validated on submit:
                // `ç` and a capital letter become the handle they meant instead
                // of an error message, which is the difference between a field
                // people finish and one they leave.
                .onChange(of: typed) { _, value in
                    let normalised = HandleRules.normalize(value)
                    if normalised != value { typed = normalised }
                    error = nil
                }
            Button(busy ? "Saving…" : "Save") { Task { await claim() } }
                .font(Typography.caption)
                .foregroundStyle(Palette.signal)
                .disabled(busy || localRefusal != nil || typed.count < HandleRules.minLength)
                .accessibilityIdentifier("settings.handle.save")
        }
    }

    private func claim() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            _ = try await session.api.claimHandle(typed)
            await session.refreshCurrentUser()
            typed = ""
        } catch {
            // VERBATIM. "That handle is taken" is not a property of the string —
            // only the unique index can say it — so the local mirror cannot
            // produce this sentence and must not paraphrase it.
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// Pick, upload and clear the account's profile picture.
///
/// Its own view rather than lines in `AccountSettingsView` because it does not
/// share that screen's save cycle at all: an upload writes the avatar the
/// moment it lands, and "Save changes" below has nothing of its to apply.
/// Folding the two together would put an avatar behind a button that does not
/// govern it.
///
/// The whole control is absent on a deployment with no object storage — the
/// same shape the attach button and the GIF button take — rather than present
/// and answering 503. There is no URL field here, unlike the web client's
/// picker: typing a URL on a phone is not a thing anybody does, and the
/// server keeps accepting one from any other client regardless.
private struct AvatarRow: View {
    @Environment(SessionStore.self) private var session

    @State private var canUpload = false
    @State private var picked: PhotosPickerItem?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 14) {
                Avatar(
                    name: session.currentUser?.displayName ?? "?",
                    seed: session.currentUser?.id ?? "self",
                    size: 56,
                    url: session.currentUser?.avatarUrl
                )
                if canUpload {
                    VStack(alignment: .leading, spacing: 6) {
                        PhotosPicker(
                            selection: $picked,
                            matching: .images,
                            photoLibrary: .shared()
                        ) {
                            Text(busy ? "Uploading…" : "Choose a photo")
                                .font(Typography.bodyMedium)
                                .foregroundStyle(Palette.signal)
                        }
                        .disabled(busy)
                        .accessibilityIdentifier("settings.avatar.pick")

                        if session.currentUser?.avatarUrl != nil {
                            Button("Remove", role: .destructive) {
                                Task { await clear() }
                            }
                            .font(Typography.caption)
                            .disabled(busy)
                            .accessibilityIdentifier("settings.avatar.remove")
                        }
                    }
                } else {
                    Text("Photo uploads are off here.")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                }
            }
            if let error {
                Text(error)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.danger)
            }
        }
        .task {
            canUpload = ((try? await session.api.avatarConfig())?.enabled) ?? false
        }
        .onChange(of: picked) { _, item in
            guard let item else { return }
            Task { await upload(item) }
        }
    }

    private func upload(_ item: PhotosPickerItem) async {
        busy = true
        error = nil
        defer {
            busy = false
            // Cleared so choosing the same photo again after a failure still
            // fires `onChange`.
            picked = nil
        }
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data) else {
                error = "That photo could not be read."
                return
            }
            let uploader = AvatarUploader(api: session.api)
            _ = try await uploader.upload(image)
            // From the server rather than from the response, so the account in
            // memory matches every other field it holds.
            await session.refreshCurrentUser()
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func clear() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            _ = try await session.api.deleteAvatar()
            await session.refreshCurrentUser()
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
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
    @State private var exporting = false
    @State private var exportSummary: String?
    @State private var transferCandidates: [ServerMember] = []
    @State private var transferTo = ""
    @State private var shareURL: URL?

    private var isOwner: Bool { server.role == "owner" }

    private let retentionOptions: [(Int?, String)] = [
        (nil, "Keep forever"), (30, "30 days"), (90, "90 days"), (365, "1 year"),
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Community name", text: $name)
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
                    Section("Data") {
                        Button(exporting ? "Exporting…" : "Export community data") {
                            Task { await export() }
                        }
                        .disabled(exporting)
                        if let exportSummary {
                            Text(exportSummary)
                                .font(Typography.caption)
                                .foregroundStyle(Palette.paperMuted)
                        }
                    }

                    Section("Transfer ownership") {
                        if transferCandidates.isEmpty {
                            Text("Nobody else is in this community.")
                                .foregroundStyle(Palette.paperMuted)
                        } else {
                            Picker("New owner", selection: $transferTo) {
                                Text("Choose someone").tag("")
                                ForEach(transferCandidates) { member in
                                    Text(member.displayName).tag(member.id)
                                }
                            }
                            Button("Transfer", role: .destructive) {
                                Task { await transfer() }
                            }
                            .disabled(transferTo.isEmpty)
                        }
                    }

                    Section {
                        Button("Delete community", role: .destructive) { confirmingDelete = true }
                    } footer: {
                        Text("Every channel, message, and invite is deleted for everyone.")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.ink)
            .navigationTitle("Community settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.tint(Palette.paperMuted)
                }
            }
            .sheet(item: Binding(
                get: { shareURL.map { ShareItem(url: $0) } },
                set: { if $0 == nil { shareURL = nil } }
            )) { item in
                ShareSheet(url: item.url)
            }
            .alert("Delete \(server.name)?", isPresented: $confirmingDelete) {
                // Typed confirmation, matching the web client: a destructive
                // action this total should cost more than one tap.
                TextField("Type the community name", text: $deleteConfirmText)
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
                transferCandidates = ((try? await session.api.members(serverId: server.id)) ?? [])
                    .filter { $0.id != session.currentUser?.id }
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

    /// The export is a JSON download. On a phone there is nowhere useful to
    /// "download" to, so it is written to a temp file and handed to the share
    /// sheet — which is how a file leaves an iOS app.
    private func export() async {
        exporting = true
        exportSummary = nil
        do {
            let data = try await session.api.exportServer(id: server.id)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(server.name)-export.json")
            try data.write(to: url)
            exportSummary = "Saved \(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file))"
            shareURL = url
        } catch { self.error = message(error) }
        exporting = false
    }

    private func transfer() async {
        do {
            onChanged(try await session.api.transferOwnership(serverId: server.id, to: transferTo))
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
        "server.update": "renamed the community",
        "server.retention_update": "changed message retention",
        "server.sso_domain_update": "changed the SSO email domain",
        "server.ownership_transfer": "transferred ownership",
        "server.data_export": "exported the community's data",
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


private struct ShareItem: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

/// UIKit's share sheet, which SwiftUI has no direct equivalent for when the
/// thing being shared is a file on disk.
private struct ShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
