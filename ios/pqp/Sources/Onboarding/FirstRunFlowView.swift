import SwiftUI
import PhotosUI

/// First run, from the age gate to the room. One shell, up to four steps.
///
/// THE SHAPE (web V2, PR #786, `docs/ONBOARDING.md`):
///
///   1. idade  the 18+ declaration. Its own session phase, drawn in this shell.
///   2. você   name, photo and the @ people type to find you. On an invite
///             link it also shows the room that is waiting, and its button is
///             "Go into {server}".
///   3. sala   cold start only. Three doors: make a room, bring a Discord
///             server, or paste an invite. One opens at a time.
///   4. pronto after making a room. The invite link, the share sheet and the
///             pastes, so an organizer never leaves without the one thing that
///             moves a group.
///
/// ONE CONTINUOUS OBJECT. The mark in the header is the same view as the big
/// one on the welcome screen (matched geometry), the active dot slides rather
/// than blinks, and steps push sideways as one sequence. Under Reduce Motion
/// all of that becomes a cross-fade.
///
/// NOTHING IS REQUIRED past the gate. Every primary button works with zero
/// edits, and "I'll sort it later" closes the wizard from its first real step,
/// which counts as an answer (`onboardedAt` is stamped either way).
struct FirstRunFlowView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let run: FirstRunSession
    let brand: Namespace.ID

    @State private var step: OnboardingScreen = .you
    @State private var created: CreatedRoom?
    @State private var finishing = false
    /// A create, import or join is in flight on the room step. Skipping then
    /// would strand a room that is about to exist, so "Later" waits for it.
    @State private var roomBusy = false

    /// The room step made (or imported), for the ready step.
    struct CreatedRoom: Equatable {
        let server: Server
        var invite: Invite?
        var inviteFailed: Bool
        /// Set after a Discord import: what the server was called over there.
        let discordSourceName: String?
    }

    private var screen: OnboardingScreen {
        session.phase == .ageGate ? .age : step
    }

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()
            FirstRunGlow(screen: screen)

            VStack(spacing: 0) {
                header
                ZStack {
                    content
                        .id(screen)
                        .transition(FirstRunMotion.stepTransition(reduceMotion))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
        }
        .animation(FirstRunMotion.step(reduceMotion), value: screen)
        .sensoryFeedback(.selection, trigger: screen)
        .onChange(of: screen) { _, _ in
            UIAccessibility.post(notification: .screenChanged, argument: nil)
        }
    }

    // MARK: - Header

    private var header: some View {
        let position = Onboarding.position(of: screen, in: run.path)
        return ZStack {
            HStack {
                SpeechMark(size: 30)
                    .matchedGeometryEffect(id: "mark", in: brand)
                    .accessibilityHidden(true)
                Spacer()
                trailingAction
            }
            StepDots(index: position.index, total: position.total)
                .animation(FirstRunMotion.step(reduceMotion), value: position.index)
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .frame(minHeight: 52)
        // The chrome row stays one line at the largest text sizes, so the skip
        // link never runs over the dots. The step content below still scales
        // all the way.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    @ViewBuilder
    private var trailingAction: some View {
        switch screen {
        case .you where run.path == .cold:
            skipButton("I'll sort it later")
        case .room:
            skipButton("Later")
        default:
            EmptyView()
        }
    }

    private func skipButton(_ title: LocalizedStringKey) -> some View {
        Button(title) { finish() }
            .font(.footnote.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(maxWidth: 160, alignment: .trailing)
            .foregroundStyle(Palette.paperMuted)
            .disabled(finishing || roomBusy)
            .accessibilityIdentifier("onboarding.later")
    }

    // MARK: - Steps

    @ViewBuilder
    private var content: some View {
        switch screen {
        case .age:
            AgeStep()
        case .you:
            YouStep(run: run) {
                if run.path == .cold {
                    go(.room)
                } else {
                    finish()
                }
            }
        case .room:
            RoomStep(
                working: $roomBusy,
                onCreated: { room in
                    created = room
                    // Behind the wizard, so "Go into the room" reveals it
                    // already open instead of starting a load.
                    session.requestNavigation(.server(id: room.server.id))
                    go(.ready)
                },
                onJoined: { serverId in
                    run.arrival = .joined(serverId: serverId)
                    session.requestNavigation(.server(id: serverId))
                    finish()
                }
            )
        case .ready:
            ReadyStep(created: $created) { finish() }
        }
    }

    private func go(_ next: OnboardingScreen) {
        withAnimation(FirstRunMotion.step(reduceMotion)) { step = next }
    }

    private func finish() {
        guard !finishing else { return }
        finishing = true
        Task { await session.finishFirstRun() }
    }
}

/// A slow wash of the signal colour that drifts to a new corner per step.
/// Low contrast on purpose: it makes the ground feel lit, and anything louder
/// competes with the copy. Still under Reduce Motion.
private struct FirstRunGlow: View {
    let screen: OnboardingScreen
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var center: UnitPoint {
        switch screen {
        case .age: .topLeading
        case .you: .topTrailing
        case .room: .leading
        case .ready: .top
        }
    }

    var body: some View {
        RadialGradient(
            colors: [Palette.signal.opacity(screen == .ready ? 0.2 : 0.13), .clear],
            center: center,
            startRadius: 10,
            endRadius: 460
        )
        .ignoresSafeArea()
        .animation(reduceMotion ? nil : .easeInOut(duration: 1.2), value: screen)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The footer every step pins above the keyboard: one primary action.
private struct StepFooter<Label: View>: View {
    let enabled: Bool
    let identifier: String
    let action: () -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        Button(action: action, label: label)
            .buttonStyle(PrimaryButtonStyle(isEnabled: enabled))
            .disabled(!enabled)
            .accessibilityIdentifier(identifier)
            .padding(.horizontal, 20)
            .padding(.top, 10)
            .padding(.bottom, 12)
            .background { FooterScrim() }
    }
}

/// Solid ink under a pinned footer, fading upward so content scrolls under
/// it instead of being cut off at a hard edge.
struct FooterScrim: View {
    var body: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [Palette.ink.opacity(0), Palette.ink], startPoint: .top, endPoint: .bottom)
                .frame(height: 18)
                .offset(y: -18)
                .padding(.bottom, -18)
            Palette.ink
        }
        .ignoresSafeArea(edges: .bottom)
        .allowsHitTesting(false)
    }
}

// MARK: - Step 2: você

/// Say who you are, see your @, and (on an invite) see where you are going.
struct YouStep: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let run: FirstRunSession
    let onDone: () -> Void

    /// The web's presets, as PNG: `AsyncImage` does not draw SVG, and the
    /// server stores whichever URL is sent, so both clients render these.
    static let presets = [
        "https://api.dicebear.com/9.x/shapes/png?seed=signal",
        "https://api.dicebear.com/9.x/shapes/png?seed=phosphor",
        "https://api.dicebear.com/9.x/shapes/png?seed=desk",
        "https://api.dicebear.com/9.x/shapes/png?seed=mesh",
        "https://api.dicebear.com/9.x/shapes/png?seed=lobby",
        "https://api.dicebear.com/9.x/shapes/png?seed=relay",
        "https://api.dicebear.com/9.x/bottts-neutral/png?seed=pqp1",
        "https://api.dicebear.com/9.x/bottts-neutral/png?seed=pqp2",
    ]

    @State private var displayName = ""
    @State private var nameTouched = false
    @State private var chosenPreset: String?
    @State private var username = ""
    @State private var editingHandle = false
    @State private var handleError: Onboarding.HandleError?
    @State private var reassignedTag: String?
    @State private var saving = false
    @State private var saveFailed = false
    @State private var failures = 0
    @State private var waitingForJoin = false
    @State private var photoItem: PhotosPickerItem?
    @State private var uploading = false
    @State private var canUpload = false
    @State private var arrivalShown = false
    @State private var seeded = false
    @State private var handleCopies = 0
    @State private var handleCopied = false
    @FocusState private var focus: Field?
    @ScaledMetric(relativeTo: .title) private var avatarSize: CGFloat = 76

    private enum Field: Hashable { case name, username }

    private var user: CurrentUser? { session.currentUser }

    private var joinFailed: Bool { run.path == .invite && run.arrival == .failed }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if run.path == .invite, !joinFailed {
                    arrivalCard
                }

                StepHeading(
                    eyebrow: eyebrow,
                    title: Text("How should people see you?"),
                    description: joinFailed
                        ? Text("Go in anyway and ask whoever invited you for a fresh link.")
                        : Text("A name on your messages and an @ so people find you. Both can change whenever."),
                    eyebrowIcon: joinFailed ? "exclamationmark.triangle" : (run.path == .invite ? "door.left.hand.open" : "hand.wave")
                )

                photoSection
                nameSection
                handleSection

                if saveFailed {
                    Label("Couldn't save that. Try again.", systemImage: "xmark.octagon.fill")
                        .font(FirstRunType.callout)
                        .foregroundStyle(Palette.danger)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            StepFooter(enabled: !saving && !waitingForJoin && !uploading, identifier: "you.next") {
                Task { await submit() }
            } label: {
                HStack(spacing: 8) {
                    if saving || waitingForJoin { ProgressView().tint(Palette.inkDeep) }
                    primaryLabel
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
        }
        .animation(FirstRunMotion.step(reduceMotion), value: editingHandle)
        .animation(.easeInOut(duration: 0.2), value: handleError)
        .animation(.easeInOut(duration: 0.2), value: reassignedTag)
        .animation(FirstRunMotion.pop(reduceMotion), value: run.arrival)
        .sensoryFeedback(.error, trigger: failures)
        .sensoryFeedback(.success, trigger: handleCopies)
        .onAppear(perform: seed)
        .task {
            canUpload = ((try? await session.api.avatarConfig())?.enabled) ?? false
        }
        .task {
            try? await Task.sleep(for: .milliseconds(120))
            withAnimation(FirstRunMotion.pop(reduceMotion)) { arrivalShown = true }
        }
        // Pressed "Go in" while the join behind the wizard was still running:
        // go the moment it lands, or after ten seconds regardless, so a slow
        // network never strands somebody on this screen. A dead link is then
        // the hub's to explain.
        .onChange(of: run.arrival) { _, arrival in
            if waitingForJoin, arrival != .pending { onDone() }
        }
        .task(id: waitingForJoin) {
            guard waitingForJoin else { return }
            try? await Task.sleep(for: .seconds(10))
            if waitingForJoin { onDone() }
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task { await upload(item) }
        }
    }

    // MARK: Pieces

    private var eyebrow: Text {
        if joinFailed { return Text("That invite did not work") }
        if run.path == .invite, let name = run.serverName {
            return Text("\(name) is waiting for you")
        }
        return Text("Welcome in")
    }

    private var primaryLabel: Text {
        if saving { return Text("Saving…") }
        if waitingForJoin { return Text("Going in…") }
        if run.path == .invite, !joinFailed, let name = run.serverName {
            return Text("Go into \(name)")
        }
        return Text("Continue")
    }

    @ViewBuilder
    private var arrivalCard: some View {
        HStack(spacing: 14) {
            ServerIconTile(
                name: run.serverName ?? "pqp",
                iconUrl: run.preview?.iconUrl,
                size: 54
            )
            .overlay(alignment: .bottomTrailing) {
                if run.joinedServerId != nil {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(Palette.success, Palette.inkDeep)
                        .background(Circle().fill(Palette.inkDeep).padding(2))
                        .offset(x: 5, y: 5)
                        .transition(.scale.combined(with: .opacity))
                        .accessibilityHidden(true)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                if let name = run.serverName {
                    Text(verbatim: name)
                        .font(FirstRunType.headline)
                        .foregroundStyle(Palette.paper)
                        .lineLimit(2)
                }
                if run.arrival == .pending {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini).tint(Palette.paperMuted)
                        Text("Saving you a seat…")
                    }
                    .font(FirstRunType.footnote)
                    .foregroundStyle(Palette.paperMuted)
                } else if let count = run.preview?.memberCount {
                    Text("\(count) people inside")
                        .font(FirstRunType.footnote)
                        .foregroundStyle(Palette.paperMuted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .fill(Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .strokeBorder(Palette.signal.opacity(0.35), lineWidth: 1)
        )
        .scaleEffect(arrivalShown || reduceMotion ? 1 : 0.96)
        .offset(y: arrivalShown || reduceMotion ? 0 : 12)
        .opacity(arrivalShown ? 1 : 0)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("you.arrival")
    }

    private var currentAvatar: String? {
        chosenPreset ?? user?.avatarUrl
    }

    private var photoSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            fieldLabel("Photo")
            HStack(spacing: 16) {
                Avatar(
                    name: displayName.isEmpty ? (user?.displayName ?? "?") : displayName,
                    seed: user?.id ?? "me",
                    size: avatarSize,
                    url: currentAvatar
                )
                .id(currentAvatar ?? "none")
                .transition(.scale(scale: 0.85).combined(with: .opacity))
                .overlay {
                    if uploading {
                        Circle().fill(.black.opacity(0.45))
                        ProgressView().tint(Palette.paper)
                    }
                }
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 8) {
                    if canUpload {
                        PhotosPicker(selection: $photoItem, matching: .images) {
                            Label(uploading ? "Uploading…" : "Upload a photo", systemImage: "camera.fill")
                                .font(.callout.weight(.semibold))
                                .foregroundStyle(Palette.paper)
                                .padding(.horizontal, 12)
                                .frame(minHeight: 40)
                                .background(Capsule().fill(Palette.surfaceRaised))
                        }
                        .disabled(uploading)
                        .accessibilityIdentifier("you.upload")
                    }
                    if currentAvatar != nil {
                        Button("Remove") {
                            Task { await clearAvatar() }
                        }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.paperMuted)
                        .disabled(uploading)
                    }
                }
                Spacer(minLength: 0)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 10) {
                    ForEach(Array(Self.presets.enumerated()), id: \.element) { index, url in
                        presetButton(url, index: index)
                    }
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 2)
            }
        }
    }

    private func presetButton(_ url: String, index: Int) -> some View {
        let selected = currentAvatar == url
        return Button {
            withAnimation(FirstRunMotion.pop(reduceMotion)) {
                chosenPreset = selected ? nil : url
            }
        } label: {
            AsyncImage(url: URL(string: url)) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Palette.surfaceRaised
            }
            .frame(width: 46, height: 46)
            .clipShape(Circle())
            .overlay(
                Circle().strokeBorder(selected ? Palette.signal : Palette.border, lineWidth: selected ? 3 : 1)
            )
            .scaleEffect(selected && !reduceMotion ? 1.08 : 1)
        }
        .buttonStyle(PressableStyle())
        .sensoryFeedback(.selection, trigger: selected)
        .accessibilityLabel(Text("Use this avatar"))
        .accessibilityValue(Text(verbatim: "\(index + 1)"))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("you.preset.\(index)")
    }

    private var nameSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            fieldLabel("Name")
            TextField("What people call you", text: $displayName)
                .textContentType(.name)
                .submitLabel(.done)
                .focused($focus, equals: .name)
                .font(FirstRunType.body)
                .foregroundStyle(Palette.paper)
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                .background(fieldBackground(focused: focus == .name))
                .onChange(of: displayName) { _, _ in
                    if seeded { nameTouched = true }
                }
                .accessibilityIdentifier("you.name")

            if !nameTouched, displayName == user?.displayName, !displayName.isEmpty {
                Text("Came from your account. If that is not what people call you, change it.")
                    .font(FirstRunType.footnote)
                    .foregroundStyle(Palette.paperMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var handleSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            fieldLabel("Your @")
            HStack(spacing: 10) {
                Button(action: copyHandle) {
                    HStack(spacing: 8) {
                        Text(verbatim: user?.tag ?? username)
                            .font(FirstRunType.mono)
                            .foregroundStyle(Palette.paper)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Image(systemName: handleCopied ? "checkmark" : "doc.on.doc")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(handleCopied ? Palette.success : Palette.paperMuted)
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 46)
                    .background(
                        Capsule().fill(Palette.surface)
                    )
                    .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 1))
                }
                .buttonStyle(PressableStyle())
                .accessibilityLabel(Text("Copy @"))
                .accessibilityValue(Text(verbatim: user?.tag ?? username))
                .accessibilityIdentifier("you.handle")

                Spacer(minLength: 0)

                Button(editingHandle ? "Keep" : "Change") {
                    withAnimation(FirstRunMotion.step(reduceMotion)) {
                        editingHandle.toggle()
                        handleError = nil
                        if editingHandle {
                            focus = .username
                        } else {
                            username = user?.username ?? ""
                        }
                    }
                }
                .font(.callout.weight(.semibold))
                .foregroundStyle(Palette.signal)
                .accessibilityIdentifier("you.handleChange")
            }

            if handleCopied {
                Text("Copied")
                    .font(FirstRunType.footnote)
                    .foregroundStyle(Palette.success)
                    .transition(.opacity)
            }

            if editingHandle {
                VStack(alignment: .leading, spacing: 8) {
                    fieldLabel("Username")
                    TextField("", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                        .focused($focus, equals: .username)
                        .font(FirstRunType.mono)
                        .foregroundStyle(Palette.paper)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 50)
                        .background(fieldBackground(focused: focus == .username, error: handleError != nil))
                        .onChange(of: username) { _, value in
                            let normalized = Onboarding.normalizeUsername(value)
                            if normalized != value { username = normalized }
                            handleError = nil
                        }
                        .accessibilityLabel(Text("Username"))
                        .accessibilityIdentifier("you.username")

                    Text("Lowercase, numbers and _ only. The number after it comes free.")
                        .font(FirstRunType.footnote)
                        .foregroundStyle(Palette.paperMuted)
                        .fixedSize(horizontal: false, vertical: true)

                    if let handleError {
                        handleErrorText(handleError)
                            .font(FirstRunType.footnote)
                            .foregroundStyle(Palette.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .transition(.asymmetric(
                    insertion: .opacity.combined(with: .offset(y: reduceMotion ? 0 : -6)),
                    removal: .opacity
                ))
            }

            if let reassignedTag {
                Label {
                    Text("Somebody already had that one. You got \(reassignedTag).")
                } icon: {
                    Image(systemName: "info.circle")
                }
                .font(FirstRunType.footnote)
                .foregroundStyle(Palette.warning)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("you.reassigned")
            }
        }
    }

    private func handleErrorText(_ error: Onboarding.HandleError) -> Text {
        switch error {
        case .taken: Text("That name is full, every number behind it is taken. Pick another one.")
        case .invalid: Text("Lowercase, numbers and _ only, between 2 and 32 characters.")
        case .generic: Text("Couldn't save that. Try again.")
        }
    }

    private func fieldLabel(_ text: LocalizedStringKey) -> some View {
        Text(text)
            .font(FirstRunType.eyebrow)
            .textCase(.uppercase)
            .tracking(1)
            .foregroundStyle(Palette.paperMuted)
    }

    private func fieldBackground(focused: Bool, error: Bool = false) -> some View {
        RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
            .fill(Palette.surface)
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                    .strokeBorder(
                        error ? Palette.danger : (focused ? Palette.signal : Palette.border),
                        lineWidth: focused || error ? 1.5 : 1
                    )
            )
    }

    // MARK: Actions

    private func seed() {
        guard !seeded else { return }
        displayName = user?.displayName ?? ""
        username = user?.username ?? ""
        // After the assignment above has been observed, so pre-filling does
        // not count as the person editing.
        DispatchQueue.main.async { seeded = true }
    }

    private func copyHandle() {
        guard let tag = user?.tag, !tag.isEmpty else { return }
        UIPasteboard.general.string = tag
        handleCopies += 1
        withAnimation(FirstRunMotion.pop(reduceMotion)) { handleCopied = true }
        let mine = handleCopies
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            guard mine == handleCopies else { return }
            withAnimation(.easeOut(duration: 0.2)) { handleCopied = false }
        }
    }

    private func submit() async {
        guard let user else {
            advance()
            return
        }
        focus = nil
        saveFailed = false
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let nameChanged = !trimmed.isEmpty && trimmed != user.displayName
        let handleChanged = editingHandle && !username.isEmpty && username != (user.username ?? "")
        let avatarChanged = chosenPreset != nil && chosenPreset != user.avatarUrl

        if handleChanged, !Onboarding.isValidUsername(username) {
            handleError = .invalid
            failures += 1
            return
        }
        // Nothing to save: they read it and kept it, which is a complete answer.
        guard nameChanged || handleChanged || avatarChanged else {
            advance()
            return
        }

        saving = true
        defer { saving = false }
        var updated: CurrentUser?
        if nameChanged || handleChanged {
            do {
                updated = try await session.api.updateMe(
                    displayName: nameChanged ? trimmed : nil,
                    username: handleChanged ? username : nil
                )
            } catch {
                if handleChanged {
                    handleError = Onboarding.handleError(for: error)
                } else {
                    saveFailed = true
                }
                failures += 1
                return
            }
        }
        if avatarChanged, let chosenPreset {
            do {
                updated = try await session.api.setAvatarURL(chosenPreset)
            } catch {
                saveFailed = true
                failures += 1
                if let updated { session.adoptUpdatedUser(updated) }
                return
            }
        }
        if let updated {
            session.adoptUpdatedUser(updated)
        }
        if handleChanged,
           Onboarding.tagWasReassigned(
               requestedUsername: username,
               previousTag: user.tag,
               nextTag: updated?.tag
           ) {
            // Stay and say what happened. Advancing here is how somebody
            // leaves believing in a handle nobody can type.
            reassignedTag = updated?.tag
            editingHandle = false
            username = updated?.username ?? username
            return
        }
        editingHandle = false
        advance()
    }

    private func advance() {
        if run.path == .invite, run.arrival == .pending {
            waitingForJoin = true
            return
        }
        onDone()
    }

    private func upload(_ item: PhotosPickerItem) async {
        uploading = true
        defer {
            uploading = false
            photoItem = nil
        }
        guard let data = try? await item.loadTransferable(type: Data.self),
              let image = UIImage(data: data) else {
            saveFailed = true
            failures += 1
            return
        }
        do {
            let updated = try await AvatarUploader(api: session.api).upload(image)
            session.adoptUpdatedUser(updated)
            chosenPreset = nil
        } catch {
            saveFailed = true
            failures += 1
        }
    }

    private func clearAvatar() async {
        if chosenPreset != nil, chosenPreset != user?.avatarUrl {
            withAnimation { chosenPreset = nil }
            return
        }
        chosenPreset = nil
        guard user?.avatarUrl != nil else { return }
        if let updated = try? await session.api.deleteAvatar() {
            session.adoptUpdatedUser(updated)
        }
    }
}

// MARK: - Step 3: sala

/// Three doors: make a room, bring the Discord one, or use an invite.
///
/// One door opens at a time and the other two collapse to a line, which is
/// what keeps the step on one phone screen. The accent ring is a single shape
/// that slides to whichever door is open.
struct RoomStep: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Binding var working: Bool
    let onCreated: (FirstRunFlowView.CreatedRoom) -> Void
    let onJoined: (String) -> Void

    enum Door: String, CaseIterable, Identifiable {
        case create
        case discord
        case invite

        var id: String { rawValue }

        var symbol: String {
            switch self {
            case .create: "wand.and.stars"
            case .discord: "square.and.arrow.down.on.square"
            case .invite: "envelope.open"
            }
        }

        var title: LocalizedStringKey {
            switch self {
            case .create: "Start from scratch"
            case .discord: "I already have a Discord server"
            case .invite: "Somebody sent me an invite"
            }
        }

        var detail: LocalizedStringKey {
            switch self {
            case .create: "Text and voice come ready. Name it and go."
            case .discord: "Paste the discord.new link and the sidebar comes over as it is. Discord itself does not change."
            case .invite: "Paste the link or the code."
            }
        }
    }

    @State private var open: Door?
    @State private var roomName = ""
    @State private var inviteInput = ""
    @State private var busy = false
    @State private var importBusy = false
    @State private var createFailed = false
    @State private var inviteFailed = false
    @State private var failures = 0
    @FocusState private var fieldFocused: Bool
    @Namespace private var ring
    @ScaledMetric(relativeTo: .headline) private var tileSize: CGFloat = 40

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                StepHeading(
                    eyebrow: Text("Your room"),
                    title: Text("Where does the crew hang out?"),
                    description: Text("Pick one. It takes a minute."),
                    eyebrowIcon: "square.grid.2x2"
                )

                VStack(spacing: 12) {
                    ForEach(Array(Door.allCases.enumerated()), id: \.element) { index, door in
                        doorCard(door, index: index)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        .sensoryFeedback(.selection, trigger: open)
        .sensoryFeedback(.error, trigger: failures)
        .animation(FirstRunMotion.step(reduceMotion), value: open)
        .onChange(of: busy || importBusy) { _, value in working = value }
        .onDisappear { working = false }
    }

    private func doorCard(_ door: Door, index: Int) -> some View {
        let isOpen = open == door
        let collapsed = open != nil && !isOpen
        return VStack(alignment: .leading, spacing: 14) {
            Button {
                open = isOpen ? nil : door
                createFailed = false
                inviteFailed = false
                if open == .create || open == .invite {
                    Task {
                        try? await Task.sleep(for: .milliseconds(300))
                        fieldFocused = true
                    }
                }
            } label: {
                HStack(alignment: collapsed ? .center : .top, spacing: 14) {
                    Image(systemName: door.symbol)
                        .font(.system(size: tileSize * 0.44, weight: .semibold))
                        .foregroundStyle(isOpen ? Palette.inkDeep : Palette.signal)
                        .frame(width: tileSize, height: tileSize)
                        .background(
                            RoundedRectangle(cornerRadius: 11, style: .continuous)
                                .fill(isOpen ? Palette.signal : Palette.signal.opacity(0.12))
                        )
                        .symbolEffect(.bounce, value: isOpen)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(door.title)
                            .font(FirstRunType.headline)
                            .foregroundStyle(Palette.paper)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        if !collapsed {
                            Text(door.detail)
                                .font(FirstRunType.footnote)
                                .foregroundStyle(Palette.paperMuted)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                                .transition(.opacity)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(Palette.paperMuted)
                        .rotationEffect(.degrees(isOpen ? 180 : 0))
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableStyle())
            .accessibilityAddTraits(isOpen ? .isSelected : [])
            .accessibilityHint(isOpen ? Text("") : Text("Opens this option"))
            .accessibilityIdentifier("door.\(door.rawValue)")

            if isOpen {
                doorBody(door)
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .offset(y: reduceMotion ? 0 : -6)),
                        removal: .opacity
                    ))
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                .fill(isOpen ? Palette.surfaceRaised : Palette.surface)
        )
        .overlay {
            ZStack {
                RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                    .strokeBorder(Palette.border, lineWidth: 1)
                if isOpen {
                    RoundedRectangle(cornerRadius: Metrics.cornerRadiusLarge, style: .continuous)
                        .strokeBorder(Palette.signal, lineWidth: 1.5)
                        .matchedGeometryEffect(id: "ring", in: ring)
                }
            }
        }
        .opacity(collapsed ? 0.72 : 1)
    }

    @ViewBuilder
    private func doorBody(_ door: Door) -> some View {
        switch door {
        case .create:
            VStack(alignment: .leading, spacing: 10) {
                TextField("Name it something stupid", text: $roomName)
                    .focused($fieldFocused)
                    .submitLabel(.go)
                    .onSubmit { Task { await create() } }
                    .font(FirstRunType.body)
                    .foregroundStyle(Palette.paper)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 48)
                    .background(
                        RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                            .fill(Palette.inkDeep)
                    )
                    .accessibilityLabel(Text("Room name"))
                    .accessibilityIdentifier("door.create.field")
                if createFailed {
                    Text("Couldn't create that. Try again.")
                        .font(FirstRunType.footnote)
                        .foregroundStyle(Palette.danger)
                }
                Button {
                    Task { await create() }
                } label: {
                    HStack(spacing: 8) {
                        if busy { ProgressView().tint(Palette.inkDeep) }
                        Text(busy ? "Creating…" : "Create")
                    }
                }
                .buttonStyle(PrimaryButtonStyle(isEnabled: canCreate))
                .disabled(!canCreate)
                .accessibilityIdentifier("door.create.action")
            }
        case .discord:
            DiscordImportForm(busyChanged: { importBusy = $0 }) { result, sourceName in
                onCreated(FirstRunFlowView.CreatedRoom(
                    server: result.server,
                    invite: result.invite,
                    inviteFailed: false,
                    discordSourceName: sourceName
                ))
            }
        case .invite:
            VStack(alignment: .leading, spacing: 10) {
                TextField("Invite code or link", text: $inviteInput)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .focused($fieldFocused)
                    .submitLabel(.go)
                    .onSubmit { Task { await join() } }
                    .font(FirstRunType.body)
                    .foregroundStyle(Palette.paper)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 48)
                    .background(
                        RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                            .fill(Palette.inkDeep)
                    )
                    .accessibilityIdentifier("door.invite.field")
                if inviteFailed {
                    Text("That invite doesn't work. Ask for another.")
                        .font(FirstRunType.footnote)
                        .foregroundStyle(Palette.danger)
                }
                Button {
                    Task { await join() }
                } label: {
                    HStack(spacing: 8) {
                        if busy { ProgressView().tint(Palette.inkDeep) }
                        Text(busy ? "Going in…" : "Go in")
                    }
                }
                .buttonStyle(PrimaryButtonStyle(isEnabled: canJoin))
                .disabled(!canJoin)
                .accessibilityIdentifier("door.invite.action")
            }
        }
    }

    private var canCreate: Bool {
        !busy && !roomName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canJoin: Bool {
        !busy && !inviteInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Make the room, then its week-long invite, before moving on, so the ready
    /// step lands with the link already in the box.
    private func create() async {
        let name = roomName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canCreate, !name.isEmpty else { return }
        busy = true
        createFailed = false
        fieldFocused = false
        defer { busy = false }
        let finalName = String(name.prefix(100))
        let server: Server
        do {
            server = try await session.api.createServer(name: finalName)
        } catch {
            // A lost response is not a failed create: if the room exists,
            // carry on with it instead of inviting a second one.
            if case APIError.transport = error,
               let ownerId = session.currentUser?.id,
               let made = await session.api.recentlyCreatedServer(named: finalName, ownerId: ownerId) {
                server = made
            } else {
                createFailed = true
                failures += 1
                return
            }
        }
        let invite = try? await session.api.createInvite(
            serverId: server.id, expiresInHours: Onboarding.inviteLifetimeHours
        )
        onCreated(FirstRunFlowView.CreatedRoom(
            server: server,
            invite: invite,
            inviteFailed: invite == nil,
            discordSourceName: nil
        ))
    }

    private func join() async {
        let code = DeepLink.normalizeInviteCode(inviteInput)
        guard canJoin else { return }
        guard !code.isEmpty else {
            inviteFailed = true
            failures += 1
            return
        }
        busy = true
        inviteFailed = false
        fieldFocused = false
        defer { busy = false }
        do {
            let serverId = try await session.api.joinInvite(code: code)
            onJoined(serverId)
        } catch {
            inviteFailed = true
            failures += 1
        }
    }
}

// MARK: - Step 4: pronto

/// The room exists and the invite is in hand. Confetti, once, for the
/// organizer; the invitee gets theirs on arrival.
struct ReadyStep: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Binding var created: FirstRunFlowView.CreatedRoom?
    let onEnter: () -> Void

    @State private var burst = 0
    @State private var retrying = false
    @State private var entering = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                StepHeading(
                    eyebrow: Text("Room's ready"),
                    title: Text("Now bring everyone"),
                    description: Text("Paste it in the group. Whoever opens it comes in through the browser, nothing to install."),
                    eyebrowIcon: "sparkles"
                )

                if let created {
                    HStack(spacing: 12) {
                        ServerIconTile(name: created.server.name, iconUrl: created.server.iconUrl, size: 44)
                        Text(verbatim: created.server.name)
                            .font(FirstRunType.headline)
                            .foregroundStyle(Palette.paper)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)

                    ServerReadyPanel(
                        invite: created.invite,
                        inviteFailed: created.inviteFailed,
                        retrying: retrying,
                        onRetry: { Task { await retryInvite() } },
                        discordServerName: created.discordSourceName
                    )
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("What you can do in there")
                        .font(FirstRunType.eyebrow)
                        .textCase(.uppercase)
                        .tracking(1)
                        .foregroundStyle(Palette.paperMuted)
                    FeatureMomentList(moments: FeatureMoment.inYourRoom, delay: 0.5)
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            StepFooter(enabled: !entering, identifier: "ready.enter") {
                entering = true
                onEnter()
            } label: {
                Label("Go into the room", systemImage: "arrow.right")
                    .labelStyle(TrailingIconLabelStyle())
            }
        }
        .overlay {
            ConfettiBurst(trigger: burst)
                .ignoresSafeArea()
        }
        .sensoryFeedback(.success, trigger: burst)
        .onAppear {
            // After the step has landed, so the burst reads as the reward for
            // arriving here rather than part of the slide.
            Task {
                try? await Task.sleep(for: .milliseconds(280))
                burst += 1
            }
        }
    }

    private func retryInvite() async {
        guard let serverId = created?.server.id else { return }
        retrying = true
        defer { retrying = false }
        if let invite = try? await session.api.createInvite(
            serverId: serverId, expiresInHours: Onboarding.inviteLifetimeHours
        ) {
            created?.invite = invite
            created?.inviteFailed = false
        }
    }
}

/// Title first, icon after it: "Go into the room →".
struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            configuration.title
            configuration.icon
        }
    }
}
