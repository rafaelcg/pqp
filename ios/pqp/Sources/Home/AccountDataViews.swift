import SwiftUI

/// The two rights the privacy policy promises, as buttons.
///
/// THE APP STORE REQUIRES THE SECOND ONE. Guideline 5.1.1(v): an app that
/// supports account creation must let the account be deleted from inside the
/// app, and a submission without it is rejected. The web client has had both
/// since the policy promised them; until now the only route on a phone was to
/// email an address and wait for somebody to run SQL by hand.
///
/// Its own file rather than more lines in `SettingsViews`, and its own section
/// rather than a footer at the end of a scroll: the right to leave belongs
/// somewhere a person can find it on purpose.
struct YourDataSection: View {
    @Environment(SessionStore.self) private var session

    /// The finished export, for whoever owns the screen to hand to the share
    /// sheet, and the request to confirm a deletion.
    ///
    /// NEITHER SHEET IS PRESENTED FROM HERE, and that is not style. A `Form` is
    /// a collection view: its sections are built and destroyed as they scroll,
    /// and a `.sheet` attached to one is torn down with it. The export sheet
    /// was attached to a section and it worked whenever the section happened to
    /// still be on screen and silently did nothing when it was not, which is
    /// the worst kind of intermittent. Both now hang off the screen's own body,
    /// which exists for as long as the screen does.
    @Binding var exportFile: URL?
    let onRequestDelete: () -> Void

    @State private var exporting = false
    @State private var exportError: String?

    var body: some View {
        Section {
            Button(exporting ? "Preparing…" : "Download my data") {
                Task { await download() }
            }
            .disabled(exporting)
            .accessibilityIdentifier("settings.data.export")

            if let exportError {
                Text(exportError)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.danger)
            }
        } header: {
            Text("Your data")
        } footer: {
            Text("It includes your profile, your settings, every message you wrote, the communities you are in, and who you have blocked. It does not include messages other people wrote, including their side of your direct messages. Those are their words, not your data, and you can still read them here in the app.")
        }

        Section {
            Button("Delete my account", role: .destructive) { onRequestDelete() }
                .accessibilityIdentifier("settings.data.delete")
        } footer: {
            Text("Permanent. There is no undo and no backup to restore from.")
        }
    }

    /// The web client mints a blob URL and clicks an invisible link. A phone
    /// has nowhere to "download" to, so the bytes go to a temp file and then to
    /// the share sheet, which is how a file leaves an iOS app. Same arrangement
    /// as the community export two screens away.
    private func download() async {
        exporting = true
        exportError = nil
        defer { exporting = false }
        do {
            let data = try await session.api.exportMyData()
            let stamp = Date.now.formatted(.iso8601.year().month().day())
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("pqp-my-data-\(stamp).json")
            try data.write(to: url)
            exportFile = url
        } catch let failure {
            exportError = (failure as? APIError)?.errorDescription
                ?? String(localized: "Could not build your export")
        }
    }
}

/// The confirmation itself.
///
/// Deliberately not an `alert` with a Delete button, and deliberately not one
/// tap. The user has to read what goes and what stays, and then type their own
/// tag, which `AccountDeletion.confirmationMatches` checks with the same rule
/// the server refuses on, so the button being enabled and the request being
/// accepted can never disagree.
///
/// IT STATES WHAT SURVIVES as plainly as what is destroyed. A deletion screen
/// that lists only what disappears is quietly misleading: audit entries, bans
/// this account issued, and reports filed about it all remain, and somebody
/// deleting their account specifically to erase a moderation record deserves to
/// learn that here rather than afterwards.
struct DeleteAccountView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    /// Called once the account is really gone. The caller signs out; this view
    /// deliberately does not, because the screen underneath it has to come
    /// down in the same breath.
    let onDeleted: () -> Void

    @State private var typed = ""
    @State private var busy = false
    @State private var error: String?
    @State private var blocking: [BlockingOwnedServer] = []

    private var expected: String {
        AccountDeletion.expectedConfirmation(tag: session.currentUser?.tag)
    }

    private var confirmed: Bool {
        AccountDeletion.confirmationMatches(typed, tag: session.currentUser?.tag)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("This cannot be undone. We keep no backup you can be restored from, and nobody at pqp can bring your account back.")
                }

                Section("What is deleted") {
                    Text("Your profile, handle, avatar and settings.")
                    Text("Every message you have written, everywhere, including in direct messages. Other people will see gaps where your messages were.")
                    Text("Your files and images, and the reactions you left.")
                    Text("Your memberships, your conversations, and the list of people you blocked.")
                    Text("Your sign-in. You will not be able to log back in.")
                    Text("Any community you own on your own, with nobody else in it.")
                }

                Section {
                    Text("Moderation records of actions you took in other people's communities, with your name removed. Deleting an account must not erase the record of how it was used to moderate somebody else.")
                    Text("Bans you issued. Removing them would let everybody you banned back into communities you no longer have anything to do with.")
                    Text("Reports other people filed about you, with your name removed. We are not able to let an account be deleted as a way of clearing its own record.")
                } header: {
                    Text("What is kept, and why")
                } footer: {
                    Text("All of these are pruned on their own schedule. The privacy policy explains them in full.")
                }

                if !blocking.isEmpty {
                    Section {
                        ForEach(blocking) { server in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: server.name)
                                Text(memberLine(server))
                                    .font(Typography.caption)
                                    .foregroundStyle(Palette.paperMuted)
                            }
                        }
                    } header: {
                        Text("Do one of these first, for each community you own")
                    } footer: {
                        Text("Other people are still in these communities, so we will not delete them out from under them. In each community's settings, either hand it to another member or delete the community yourself.")
                    }
                }

                Section("Type your handle to confirm") {
                    // `verbatim` on purpose: this is a value to copy, not words
                    // to read. The fallback phrase is English even in
                    // Portuguese because the server compares against that exact
                    // string.
                    Text(verbatim: expected)
                        .font(Typography.mono)
                        .foregroundStyle(Palette.signal)
                        .textSelection(.enabled)
                    TextField("", text: $typed)
                        .font(Typography.mono)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityLabel(Text("Type your handle to confirm"))
                        .accessibilityIdentifier("settings.delete.field")
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(Palette.danger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.ink)
            .navigationTitle("Delete your account")
            .navigationBarTitleDisplayMode(.inline)
            // A stray tap must not dismiss the one screen in the app whose next
            // action cannot be undone, so the drag-to-dismiss gesture goes and
            // leaving is an explicit button.
            .interactiveDismissDisabled(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Keep my account") { dismiss() }
                        .tint(Palette.paperMuted)
                        .disabled(busy)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(busy ? "Deleting…" : "Delete for ever") {
                        Task { await submit() }
                    }
                    .tint(Palette.danger)
                    .disabled(!confirmed || busy)
                    .accessibilityIdentifier("settings.delete.confirm")
                }
            }
        }
    }

    private func memberLine(_ server: BlockingOwnedServer) -> String {
        server.otherMemberCount == 1
            ? String(localized: "1 other member")
            : String(localized: "\(server.otherMemberCount) other members")
    }

    private func submit() async {
        guard confirmed, !busy else { return }
        busy = true
        error = nil
        blocking = []
        defer { busy = false }
        do {
            try await session.api.deleteMyAccount(confirm: typed)
            onDeleted()
        } catch let refusal as AccountDeletionBlocked {
            // Not an error message: a list of things to go and do, each with
            // two remedies, which the section above renders by name.
            blocking = refusal.servers
        } catch let failure {
            error = (failure as? APIError)?.errorDescription
                ?? String(localized: "Could not delete your account")
        }
    }
}
