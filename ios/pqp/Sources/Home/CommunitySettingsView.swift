import SwiftUI

// The "Public access" block of server settings: whether the room is private, a
// public link, or in the directory, and the two switches behind it.
//
// This is a port of `CommunitySettingsSection` on the web, with two things the
// web does not do and a phone must: a CONFIRMATION before either switch goes
// on, and a status line that says in words what the room is right now. The
// room can be opened to strangers from here, so the screen says so before it
// does it, and says so again every time somebody looks.

/// The state behind the block. One per open settings sheet.
@MainActor
@Observable
final class CommunitySettingsModel {
    /// What the switch is about to turn on, held until the owner confirms.
    enum Confirm: Identifiable, Equatable {
        case address
        case directory

        var id: Self { self }
    }

    let serverId: String
    private let api: APIClient
    /// Told after every successful save, so the server header can follow.
    var onSaved: (CommunitySettings) -> Void = { _ in }

    /// `COMMUNITIES_ENABLED` on this deployment. Off hides the block entirely:
    /// the routes underneath answer 404 and a switch that can only fail is
    /// worse than none.
    private(set) var enabled = false
    private(set) var settings: CommunitySettings?
    private(set) var loading = true
    private(set) var loadError: String?
    private(set) var saving = false
    private(set) var failure: CommunitySaveFailure?
    /// The address field. Shown when the address is on, and after a refusal of
    /// the derived one, so there is somewhere to type another.
    var addressDraft = ""
    private(set) var addressFieldForced = false
    var confirm: Confirm?
    private(set) var copied = false

    init(serverId: String, api: APIClient) {
        self.serverId = serverId
        self.api = api
    }

    func load(rules: CommunityEditRules) async {
        loading = true
        loadError = nil
        defer { loading = false }
        enabled = await api.communitiesEnabled()
        guard enabled, rules.canSee else { return }
        do {
            apply(try await api.communitySettings(serverId: serverId))
        } catch {
            loadError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func apply(_ next: CommunitySettings) {
        settings = next
        addressDraft = next.slug ?? ""
        addressFieldForced = false
        failure = nil
    }

    var visibility: CommunityVisibility? { settings.map(CommunityVisibility.init) }

    /// Whether to draw the address field at all.
    var showsAddressField: Bool {
        (settings?.isCommunity ?? false) || addressFieldForced
    }

    /// A different address than the one saved, and not an empty one.
    var addressDraftChanged: Bool {
        let draft = addressDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !draft.isEmpty && draft != (settings?.slug ?? "")
    }

    // MARK: - Switches

    /// Turning ON asks first. Turning OFF does not: closing a door never needs
    /// a second tap.
    func setAddress(_ on: Bool) {
        if on { confirm = .address } else { Task { await save(.init(isCommunity: false)) } }
    }

    func setDirectory(_ on: Bool) {
        if on { confirm = .directory } else { Task { await save(.init(isListed: false)) } }
    }

    /// The confirmation's "yes".
    func confirmed() async {
        guard let pending = confirm else { return }
        confirm = nil
        switch pending {
        case .address:
            let typed = addressFieldForced
                ? addressDraft.trimmingCharacters(in: .whitespacesAndNewlines) : ""
            await save(.init(isCommunity: true, slug: typed.isEmpty ? nil : typed))
        case .directory:
            await save(.init(isListed: true))
        }
    }

    func saveAddress() async {
        let draft = addressDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !draft.isEmpty else { return }
        await save(.init(slug: draft))
    }

    private func save(_ change: CommunitySettingsPatch) async {
        saving = true
        failure = nil
        defer { saving = false }
        do {
            let next = try await api.updateCommunitySettings(serverId: serverId, change)
            apply(next)
            onSaved(next)
        } catch {
            let classified = CommunitySaveFailure.classify(error)
            failure = classified
            if classified.concernsAddress { addressFieldForced = true }
            // A refused write leaves the server where it was; read it back so
            // a lost race shows the truth instead of the switch's own guess.
            if classified.staleView {
                if let fresh = try? await api.communitySettings(serverId: serverId) {
                    settings = fresh
                }
            }
        }
    }

    func copyLink() {
        guard let slug = settings?.slug else { return }
        UIPasteboard.general.string = CommunityAddress.url(slug)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}

// MARK: - The block

/// The Form sections. Draws nothing while the deployment has the feature off
/// or the viewer may not see it.
struct CommunitySettingsSections: View {
    @Bindable var model: CommunitySettingsModel
    let rules: CommunityEditRules
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if model.enabled && rules.canSee {
            Section {
                content
            } header: {
                Text("Public access")
            } footer: {
                Text("The room stays yours: kicks, bans and private channels work the same. But reports about a public community go to the people who run pqp, who can take the page and the listing down.")
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let settings = model.settings, let visibility = model.visibility {
            CommunityStatusRow(visibility: visibility)
                .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: visibility)

            if settings.suspended {
                Text("The people who run pqp took this community down. The room itself has not changed and everyone inside carries on as normal; only the public page and the directory listing are gone.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.warning)
                    .accessibilityIdentifier("community.suspended")
            }

            addressSwitch(settings)
            if model.showsAddressField {
                addressField(settings)
            }
            directorySwitch(settings)

            if let failure = model.failure {
                Text(Self.sentence(for: failure))
                    .font(Typography.caption)
                    .foregroundStyle(Palette.danger)
                    .accessibilityIdentifier("community.error")
            }
        } else if model.loading {
            HStack(spacing: 10) {
                ProgressView()
                Text("Loading…").foregroundStyle(Palette.paperMuted)
            }
        } else if let loadError = model.loadError {
            Text(loadError).font(Typography.caption).foregroundStyle(Palette.danger)
            Button("Try again") { Task { await model.load(rules: rules) } }
        }
    }

    private func addressSwitch(_ settings: CommunitySettings) -> some View {
        let lock = rules.addressLock(settings)
        return VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: Binding(
                get: { settings.isCommunity },
                set: { model.setAddress($0) }
            )) {
                Text("Turn on the public address")
            }
            .disabled(model.saving || lock != nil)
            .accessibilityIdentifier("community.address.toggle")
            Text("Creates pqp.gg/c/… Anyone with the link can join with one tap, no invite.")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
            if lock == .addressHeldByListing {
                Text("This community is in the directory. Only the owner can take it out, so the address cannot be turned off here.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }
        }
    }

    private func addressField(_ settings: CommunitySettings) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 0) {
                Text(verbatim: "\(CommunityAddress.host)/c/")
                    .font(Typography.mono)
                    .foregroundStyle(Palette.paperMuted)
                TextField("your-address", text: $model.addressDraft)
                    .font(Typography.mono)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .accessibilityIdentifier("community.address.field")
            }
            if settings.isCommunity {
                HStack {
                    Button("Save address") { Task { await model.saveAddress() } }
                        .disabled(model.saving || !model.addressDraftChanged)
                        .accessibilityIdentifier("community.address.save")
                    Spacer()
                    if settings.slug != nil {
                        Button {
                            model.copyLink()
                        } label: {
                            Label(
                                model.copied ? "Link copied" : "Copy link",
                                systemImage: model.copied ? "checkmark" : "doc.on.doc"
                            )
                        }
                        .accessibilityIdentifier("community.address.copy")
                    }
                }
                .buttonStyle(.borderless)
                Text("Made from the name when you turn the address on. You can change it here; old links stop working.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            } else {
                Button("Turn on with this address") { model.confirm = .address }
                    .buttonStyle(.borderless)
                    .disabled(model.saving || model.addressDraft
                        .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("community.address.retry")
            }
        }
    }

    private func directorySwitch(_ settings: CommunitySettings) -> some View {
        let lock = rules.listingLock(settings)
        return VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: Binding(
                get: { settings.isListed && settings.isCommunity },
                set: { model.setDirectory($0) }
            )) {
                Text("Show in the pqp directory")
            }
            .disabled(model.saving || lock != nil)
            .accessibilityIdentifier("community.directory.toggle")
            Text("Anyone with an account can find the community and join without an invite. Reports about it go to the people who run pqp.")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
            switch lock {
            case .ownerOnlyListing:
                Text("Only the owner turns the directory on or off. The public address above is yours to edit.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            case .needsAddress:
                Text("Turn the public address on first.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            default:
                EmptyView()
            }
        }
    }

    static func sentence(for failure: CommunitySaveFailure) -> String {
        switch failure {
        case .slugTaken:
            String(localized: "That address is taken. Try another one.")
        case .slugUnusable:
            String(localized: "This name cannot become a web address. Type one below.")
        case .needsAddress:
            String(localized: "Turn the public address on first.")
        case .forbidden(let message), .other(let message):
            message
        }
    }
}

/// What the room is right now, in one glance. Amber when it is public so it
/// cannot be mistaken for a neutral row.
struct CommunityStatusRow: View {
    let visibility: CommunityVisibility

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 32, height: 32)
                .background(tint.opacity(0.16), in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                Text(detail)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
                if let slug = visibility.slug {
                    Text(verbatim: CommunityAddress.display(slug))
                        .font(Typography.mono)
                        .foregroundStyle(Palette.paperSubtle)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("community.status.address")
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("community.status")
    }

    private var title: String {
        switch visibility {
        case .private: String(localized: "Private community")
        case .publicLink: String(localized: "Public link")
        case .listed: String(localized: "In the directory")
        }
    }

    private var detail: String {
        switch visibility {
        case .private:
            String(localized: "Only people you invite can join.")
        case .publicLink:
            String(localized: "Anyone with the link can join with one tap.")
        case .listed:
            String(localized: "Anyone on pqp can find this community and join with one tap.")
        }
    }

    private var symbol: String {
        visibility.isPublic ? "globe" : "lock.fill"
    }

    private var tint: Color {
        visibility.isPublic ? Palette.warning : Palette.paperMuted
    }
}

/// The small flag on the server header, so a public room is never invisible.
struct PublicCommunityBadge: View {
    var compact = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "globe")
                .font(.system(size: compact ? 10 : 11, weight: .semibold))
            if !compact {
                Text("Public")
                    .font(.system(size: 11, weight: .semibold))
            }
        }
        .foregroundStyle(Palette.warning)
        .padding(.horizontal, compact ? 0 : 8)
        .padding(.vertical, compact ? 0 : 3)
        .background {
            if !compact {
                Capsule().fill(Palette.warning.opacity(0.16))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Public community"))
        .accessibilityIdentifier("server.publicBadge")
    }
}
