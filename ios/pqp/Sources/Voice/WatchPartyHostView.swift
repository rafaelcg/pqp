import SwiftUI

/**
 The host's own controls on a `watch_party` channel's call screen -- "Criar
 watch party", the setup card's "Ir ao vivo", and the live card's "Encerrar".

 THE SEATED HALF. Before a seat, the host's card is on the stage above the
 transcript (`WatchPartyStageHostView`, decided by `watchPartyStageHostCard`):
 Create, the setup card and Go live all work there with no seat, and going
 live is what takes one. This view is what the host has once seated.

 LIVES IN `VoiceView`, NOT `WatchStageView`. `WatchStageView` (the audience
 picture above the transcript) draws nothing at all once this account is
 seated (`if !isSeated { stage }`) -- exactly the moment a host needs
 controls most. `VoiceView`, the full-screen call cover every voice channel
 already presents once joined, is where this account actually lands, so
 that is where hosting belongs. This mirrors Android's `WatchPane` carrying
 `hostControls` as a slot inside the SAME surface the picture and the call
 both render on; iOS has two surfaces instead of one, and the host's is this
 one. `WatchPartyHostController` (app-scoped, alongside `VoiceModel`) is
 what makes `party` available on both without either screen owning it.

 NO SEPARATE "start capture" BUTTON. `VoiceView.controls` already draws a
 real, working `ScreenShareControlButton` for any channel where
 `VoiceModel.offersScreenShare` is true, which for a `watch_party` channel
 already means START_WATCH_PARTY. Duplicating that control here would be a
 second, parallel door to the same broadcast extension, and the
 once-per-host-per-server disclosure only means anything if EVERY door to
 the capture is behind it -- so instead this view gates the EXISTING button:
 `shareCleared` is `nil` while the ack lookup is in flight, `false` while the
 disclosure is still owed, `true` once it is clear, and `VoiceView` only
 draws the real system-picker button once it reads `true`. See
 `shareCleared`'s own binding and `VoiceView.swift`'s `controls`.

 NO PREVIEW BY DESIGN (Rafael, 2026-09-25). `RPSystemBroadcastPickerView` is
 a system sheet this app does not control, and frames only start arriving
 once the host has already used it -- there is no `getDisplayMedia`
 equivalent on iOS to preview before committing. So the setup card says so
 plainly, and once live, the only feedback is the status line below and the
 real button's own icon flipping (`ScreenShareControlButton`, driven by
 `ScreenShareController.isSharing`).
 */
struct WatchPartyHostControls: View {
    @Environment(SessionStore.self) private var session
    @Environment(VoiceModel.self) private var voice
    @Environment(CallRatingModel.self) private var ratings
    @Environment(WatchPartyHostController.self) private var host

    let channel: Channel
    /// `nil` while the ack lookup has not run or is in flight. Read by
    /// `VoiceView.controls` to decide whether the real screen-share button
    /// may render at all for this channel.
    @Binding var shareCleared: Bool?

    @State private var liveHlsConfig: LiveHlsConfigPayload = .off
    @State private var showCreateDialog = false
    @State private var draftName = ""
    @State private var showAckDialog = false
    @State private var ackFailed = false
    @State private var lowLatency = false
    @State private var showMicPrompt = false

    /// This channel's party as `WatchPartyHostController` currently knows
    /// it -- `.unknown` before the first fetch/frame lands, or if that
    /// controller is tracking a different channel. See its own doc.
    private var partyKnowledge: WatchPartyKnowledge {
        host.partyKnowledge(for: channel.id)
    }

    /// The resolved payload, for the setup/live cards below, which only
    /// ever render once `gate.canManage` is already true -- by then the
    /// party is known and not terminal, so unwrapping `.known` here is safe;
    /// `nil` is still the honest answer for `.unknown` or "no active party".
    private var party: WatchPartyPayload? {
        if case .known(let party) = partyKnowledge { return party }
        return nil
    }

    private var canStartWatchParty: Bool {
        voice.status == .connected && voice.channelId == channel.id && voice.canStream
    }

    private var gate: WatchPartyHostGate {
        watchPartyHostGate(
            isWatchPartyChannel: channel.isWatchParty,
            serverWatchPartyEnabled: liveHlsConfig.enabled,
            canStartWatchParty: canStartWatchParty,
            party: partyKnowledge
        )
    }

    private var isLiveManaging: Bool {
        gate.canManage && canEndParty(party)
    }

    var body: some View {
        Group {
            if gate.canCreate {
                createRow
            }
            if gate.canManage, let party {
                if canGoLiveWith(party) {
                    setupCard(party: party)
                } else if canEndParty(party) {
                    liveCard(party: party)
                }
            }
        }
        .task(id: channel.serverId) {
            guard let serverId = channel.serverId else { return }
            liveHlsConfig = await session.api.liveHlsConfig(serverId: serverId)
        }
        .task(id: channel.id) {
            host.open(channelId: channel.id, session: session)
        }
        .task(id: isLiveManaging) {
            guard isLiveManaging, shareCleared == nil else { return }
            await checkAckGate()
        }
        .onChange(of: host.busy) { was, now in
            // The go-live mic prompt: once a share has gone live and the mic
            // is off, offer to turn it on. Keyed on the busy transition
            // rather than `isMuted` itself, so this fires once per go-live
            // and not on every recomposition while muted.
            if was == .goingLive, now == .none, host.error == nil, voice.isMuted {
                showMicPrompt = true
            }
        }
        .alert("Before you go live", isPresented: $showAckDialog) {
            Button("Got it") { confirmAck() }
            Button("Cancel", role: .cancel) {}
        } message: {
            if ackFailed {
                Text("You're responsible for what you stream. No pirated content or anything that breaks someone else's rights.")
                    + Text(verbatim: "\n\n")
                    + Text("Couldn't save that. Try again.")
            } else {
                Text("You're responsible for what you stream. No pirated content or anything that breaks someone else's rights.")
            }
        }
        .alert("Turn on your mic?", isPresented: $showMicPrompt) {
            Button("Turn on mic") { voice.isMuted = false }
            Button("Stay muted", role: .cancel) {}
        } message: {
            Text("Your screen is live. Your microphone is still off, so the room cannot hear you talk over it.")
        }
        .alert(
            "Watch party",
            isPresented: Binding(get: { host.error != nil }, set: { if !$0 { host.dismissError() } })
        ) {
            Button("Got it") { host.dismissError() }
        } message: {
            Text(host.error ?? "")
        }
        .sheet(isPresented: $showCreateDialog) {
            createDialog
        }
    }

    // MARK: - Idle: create

    private var createRow: some View {
        Button {
            draftName = ""
            showCreateDialog = true
        } label: {
            Label("Create watch party", systemImage: "movieclapper.fill")
        }
        .accessibilityIdentifier("watchPartyHost.create")
    }

    private var createDialog: some View {
        NavigationStack {
            Form {
                TextField("Saturday session", text: $draftName)
                    .accessibilityIdentifier("watchPartyHost.createName")
            }
            .navigationTitle("Name your watch party")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showCreateDialog = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        host.create(channelId: channel.id, name: draftName, session: session)
                        showCreateDialog = false
                    }
                    .disabled(draftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("watchPartyHost.createSubmit")
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - Setup: go live

    private func setupCard(party: WatchPartyPayload) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(party.name)
                .font(Typography.label)
                .foregroundStyle(Palette.paper)
            if liveHlsConfig.lowLatency.available {
                Toggle("Low latency (beta)", isOn: $lowLatency)
                    .font(Typography.caption)
                    .accessibilityIdentifier("watchPartyHost.lowLatency")
            }
            Text("There is no preview before you go live. What you share is what your audience sees.")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
            Button {
                // Already seated here, so the join inside is a reopen and the
                // microphone is whatever this seat already has; passed anyway
                // so both doors to Go live ask the same question.
                host.goLive(
                    channel: channel, serverName: nil, partyId: party.id,
                    lowLatency: lowLatency,
                    microphone: watchPartyHostSeatMicrophone(voiceEnabled: party.voiceEnabled),
                    session: session, voice: voice, ratings: ratings
                )
            } label: {
                if host.busy == .goingLive {
                    ProgressView()
                } else {
                    Label("Go live", systemImage: "dot.radiowaves.left.and.right")
                }
            }
            .disabled(host.busy == .goingLive)
            .accessibilityIdentifier("watchPartyHost.goLive")
        }
        .padding(.bottom, 6)
    }

    // MARK: - Live: end

    private func liveCard(party: WatchPartyPayload) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("You're live")
                    .font(Typography.label)
                    .foregroundStyle(Palette.signal)
                Spacer()
                Button {
                    host.end(channelId: channel.id, partyId: party.id, session: session, voice: voice)
                } label: {
                    if host.busy == .ending {
                        ProgressView()
                    } else {
                        Text("End")
                    }
                }
                .disabled(host.busy == .ending)
                .accessibilityIdentifier("watchPartyHost.end")
            }
            if shareCleared == true, !voice.screenShare.isSharing {
                Text("Not sharing your screen yet. Tap to share.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }
            if shareCleared == false {
                Button {
                    showAckDialog = true
                } label: {
                    Label("Share your screen", systemImage: "rectangle.on.rectangle")
                }
                .accessibilityIdentifier("watchPartyHost.ackGate")
            }
        }
        .padding(.bottom, 6)
    }

    // MARK: - The streaming-responsibility ack

    /// Runs whenever the live card first appears with the ack not yet
    /// resolved. Fails CLOSED by way of `hostAckNeedsShowing`'s own
    /// contract; `try?` here only ever discards a `CancellationError` from
    /// this `.task` being torn down with the view, which needs no message
    /// since there is nobody left to show one to.
    private func checkAckGate() async {
        guard let serverId = channel.serverId else {
            shareCleared = true
            return
        }
        let needs = (try? await hostAckNeedsShowing {
            try await session.api.needsHlsHostAck(serverId: serverId)
        }) ?? true
        shareCleared = !needs
    }

    private func confirmAck() {
        guard let serverId = channel.serverId else { return }
        Task {
            let confirmed = (try? await hostAckConfirmed {
                try await session.api.confirmHlsHostAck(serverId: serverId)
            }) ?? false
            if confirmed {
                ackFailed = false
                shareCleared = true
            } else {
                // FAILS CLOSED: `shareCleared` stays `false`, and the real
                // picker never renders. Re-opening the same dialog is the
                // retry path -- there is no separate "try again" control.
                ackFailed = true
                showAckDialog = true
            }
        }
    }
}
