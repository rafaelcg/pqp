import SwiftUI

/// Paste a discord.new link, see what it becomes, create it.
///
/// Native rather than a web view: the two routes it drives
/// (`/api/import/discord/preview` and `/apply`) are the web import dialog's own,
/// so the room it makes is the same room, with the same invite minted in the
/// same transaction. What a phone shows is trimmed to what fits under a thumb:
/// the counts and the first few channel names, not the web's full plan.
struct DiscordImportForm: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Called once the server exists, with the invite the import minted.
    let onCreated: (DiscordImportResult, _ sourceName: String) -> Void

    @State private var source = ""
    @State private var preview: DiscordImportPreview?
    @State private var busy = false
    @State private var error: String?
    @State private var failures = 0
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let preview {
                previewCard(preview)
            } else {
                howTo
                pasteField
            }

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(FirstRunType.footnote)
                    .foregroundStyle(Palette.danger)
                    .transition(.opacity)
            }
        }
        .sensoryFeedback(.error, trigger: failures)
        .animation(FirstRunMotion.step(reduceMotion), value: preview)
        .animation(.easeInOut(duration: 0.2), value: error)
    }

    private var howTo: some View {
        VStack(alignment: .leading, spacing: 8) {
            step(1, "In Discord, open Server Settings, then Templates.")
            step(2, "Create a template if you do not have one, then copy the link.")
            step(3, "Paste that discord.new link here. Discord itself is not changed.")
        }
    }

    private func step(_ number: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(verbatim: "\(number)")
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(Palette.inkDeep)
                .frame(width: 20, height: 20)
                .background(Circle().fill(Palette.signal.opacity(0.85)))
                .accessibilityHidden(true)
            Text(text)
                .font(FirstRunType.footnote)
                .foregroundStyle(Palette.paperMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var pasteField: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                TextField("discord.new/… or a template code", text: $source)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .focused($focused)
                    .onSubmit { Task { await loadPreview() } }
                    .font(FirstRunType.body)
                    .foregroundStyle(Palette.paper)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 48)
                    .background(
                        RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                            .fill(Palette.inkDeep)
                    )
                    .accessibilityIdentifier("door.import.field")

                PasteButton(payloadType: String.self) { strings in
                    guard let first = strings.first else { return }
                    Task { @MainActor in
                        source = first.trimmingCharacters(in: .whitespacesAndNewlines)
                        await loadPreview()
                    }
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.roundedRectangle(radius: Metrics.cornerRadius))
                .tint(Palette.surfaceRaised)
            }

            Button {
                Task { await loadPreview() }
            } label: {
                HStack(spacing: 8) {
                    if busy { ProgressView().tint(Palette.inkDeep) }
                    Text(busy ? "Reading template…" : "Preview")
                }
            }
            .buttonStyle(PrimaryButtonStyle(isEnabled: canPreview))
            .disabled(!canPreview)
            .accessibilityIdentifier("door.import.preview")
        }
    }

    private var canPreview: Bool {
        !busy && !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func previewCard(_ plan: DiscordImportPreview) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                ServerIconTile(name: plan.serverName, iconUrl: nil, size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text("This is what will be created")
                        .font(FirstRunType.footnote)
                        .foregroundStyle(Palette.paperMuted)
                    Text(plan.serverName)
                        .font(FirstRunType.headline)
                        .foregroundStyle(Palette.paper)
                        .lineLimit(2)
                }
            }

            HStack(spacing: 8) {
                countChip(symbol: "number", count: plan.textCount, label: "text")
                countChip(symbol: "speaker.wave.2", count: plan.voiceCount, label: "voice")
                if !plan.roles.isEmpty {
                    countChip(symbol: "person.2", count: plan.roles.count, label: "roles")
                }
            }

            let names = plan.channels.filter { $0.type != "category" }.prefix(5)
            if !names.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(names.enumerated()), id: \.offset) { _, channel in
                        HStack(spacing: 6) {
                            Image(systemName: channel.type == "voice" ? "speaker.wave.2" : "number")
                                .font(.caption)
                                .foregroundStyle(Palette.paperMuted)
                                .accessibilityHidden(true)
                            Text(verbatim: channel.name)
                                .font(FirstRunType.footnote)
                                .foregroundStyle(Palette.paperSubtle)
                                .lineLimit(1)
                            if channel.isPrivate {
                                Image(systemName: "lock.fill")
                                    .font(.caption2)
                                    .foregroundStyle(Palette.paperMuted)
                                    .accessibilityLabel(Text("Private"))
                            }
                        }
                    }
                }
            }

            if plan.isDirty {
                Text("This template is behind the live Discord server. Sync it in Discord first if you want the latest layout.")
                    .font(FirstRunType.footnote)
                    .foregroundStyle(Palette.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text("People and messages stay on Discord.")
                .font(FirstRunType.footnote)
                .foregroundStyle(Palette.paperMuted)

            HStack(spacing: 10) {
                Button("Back") {
                    preview = nil
                    error = nil
                }
                .buttonStyle(SecondaryButtonStyle())
                .frame(maxWidth: 120)
                .disabled(busy)

                Button {
                    Task { await apply() }
                } label: {
                    HStack(spacing: 8) {
                        if busy { ProgressView().tint(Palette.inkDeep) }
                        Text(busy ? "Creating…" : "Create this community")
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
                .buttonStyle(PrimaryButtonStyle(isEnabled: !busy))
                .disabled(busy)
                .accessibilityIdentifier("door.import.confirm")
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .fill(Palette.inkDeep)
        )
        .transition(.opacity.combined(with: .scale(scale: reduceMotion ? 1 : 0.97)))
    }

    private func countChip(symbol: String, count: Int, label: LocalizedStringKey) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).accessibilityHidden(true)
            Text(verbatim: "\(count)").monospacedDigit()
            Text(label)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Palette.paper)
        .padding(.horizontal, 10)
        .frame(minHeight: 28)
        .background(Capsule().fill(Palette.surfaceRaised))
        .accessibilityElement(children: .combine)
    }

    private func loadPreview() async {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !busy else { return }
        busy = true
        error = nil
        focused = false
        defer { busy = false }
        do {
            preview = try await session.api.previewDiscordImport(source: trimmed)
        } catch {
            self.error = Self.message(for: error, fallback: String(localized: "Could not read that Discord template"))
            failures += 1
        }
    }

    private func apply() async {
        guard let plan = preview, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let result = try await session.api.applyDiscordImport(
                source: source.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            onCreated(result, plan.serverName)
        } catch {
            self.error = Self.message(for: error, fallback: String(localized: "Could not copy that Discord layout"))
            failures += 1
        }
    }

    /// Ours, in the reader's language. The server's sentences are English
    /// only, so they are mapped rather than shown: a 400 is always "that is
    /// not a template link", a 429 is always "wait".
    private static func message(for error: Error, fallback: String) -> String {
        if case APIError.server(let status, _) = error, status == 400 {
            return String(localized: "Paste a discord.new link or a Discord template code.")
        }
        if case APIError.rateLimited = error {
            return String(localized: "Slow down a little and try again in a minute.")
        }
        return fallback
    }
}

/// The Discord door from the hub's checklist: the same form as the wizard's,
/// then the same ready panel, in a sheet.
struct DiscordImportSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The server was made; the hub refreshes and opens it on close.
    let onFinished: (Server) -> Void

    @State private var result: DiscordImportResult?
    @State private var sourceName = ""
    @State private var burst = 0

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let result {
                        StepHeading(
                            eyebrow: Text("Room's ready"),
                            title: Text("Now bring everyone"),
                            description: Text("Discord itself was not changed. Send this invite to the people who should join here."),
                            eyebrowIcon: "sparkles"
                        )
                        ServerReadyPanel(
                            invite: result.invite,
                            inviteFailed: false,
                            retrying: false,
                            onRetry: {},
                            discordServerName: sourceName
                        )
                    } else {
                        StepHeading(
                            eyebrow: Text("Discord layout"),
                            title: Text("Copy Discord layout"),
                            description: Text("Paste a Discord template link. This copies the sidebar, not the people or the messages."),
                            eyebrowIcon: "square.and.arrow.down.on.square"
                        )
                        DiscordImportForm { created, name in
                            sourceName = name
                            withAnimation(FirstRunMotion.step(reduceMotion)) { result = created }
                            burst += 1
                        }
                    }
                }
                .padding(20)
            }
            .background(Palette.ink.ignoresSafeArea())
            .overlay { ConfettiBurst(trigger: burst).ignoresSafeArea() }
            .sensoryFeedback(.success, trigger: burst)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    if let result {
                        Button("Done") {
                            onFinished(result.server)
                            dismiss()
                        }
                        .accessibilityIdentifier("discordSheet.done")
                    } else {
                        Button("Cancel") { dismiss() }
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(Palette.signal)
    }
}
