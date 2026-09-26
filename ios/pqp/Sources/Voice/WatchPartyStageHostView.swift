import SwiftUI

/**
 The host's side of the watch-party stage, above the transcript, before any
 seat is taken: Create, the setup card with Go live, or a live party this
 account runs and is not in the room for.

 THE WEB'S ORDER OF OPERATIONS. On the web the setup card lives on the stage
 and nothing about it needs the room; Ir ao vivo is the one press that
 changes the party's state, takes the seat and puts the capture on the stage
 (`handleWatchPartyGoLive` in `client/src/App.tsx`). This is the same shape:
 opening the channel shows the card, and `WatchPartyHostController.goLive`
 is where media starts. Before this, the card only existed on the call
 screen, so reaching it took a seat, and a seat asked for the microphone.

 Which card, if any, is `watchPartyStageHostCard`'s decision; this file only
 draws it. Every card is its own small view so no one body carries the whole
 switch (the type checker times out on the big ones).
 */
struct WatchPartyStageHostView: View {
    let channel: Channel
    let serverName: String?
    let card: WatchPartyStageHostCard
    let lowLatencyAvailable: Bool

    var body: some View {
        switch card {
        case .hidden:
            EmptyView()
        case .create:
            WatchPartyStageCreateRow(channel: channel)
        case .setup(let party):
            WatchPartyStageSetupCard(
                channel: channel, serverName: serverName, party: party,
                lowLatencyAvailable: lowLatencyAvailable
            )
        case .live(let party):
            WatchPartyStageLiveCard(channel: channel, serverName: serverName, party: party)
        }
    }
}

// MARK: - Idle: create

private struct WatchPartyStageCreateRow: View {
    @Environment(SessionStore.self) private var session
    @Environment(WatchPartyHostController.self) private var host

    let channel: Channel
    @State private var showDialog = false
    @State private var draftName = ""

    var body: some View {
        // The error line matters here too: a Go live that failed and ended
        // its party lands back on this row, and the reason has to come with it.
        VStack(alignment: .leading, spacing: 8) {
            row
            WatchPartyHostErrorLine()
        }
        .watchPartyStageCard()
        .sheet(isPresented: $showDialog) {
            WatchPartyNameSheet(name: $draftName) {
                host.create(channelId: channel.id, name: draftName, session: session)
                showDialog = false
            } onCancel: {
                showDialog = false
            }
        }
    }

    private var row: some View {
        HStack(spacing: 12) {
            Image(systemName: "movieclapper.fill")
                .font(.system(size: 18, weight: .light))
                .foregroundStyle(Palette.paperMuted)
            VStack(alignment: .leading, spacing: 2) {
                Text("Watch party")
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                Text("Nobody is streaming yet.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
            }
            Spacer()
            Button("Create") {
                draftName = ""
                showDialog = true
            }
            .font(Typography.callout)
            .foregroundStyle(Palette.signal)
            .disabled(host.busy == .creating)
            .accessibilityIdentifier("watchPartyStage.create")
        }
    }
}

/// "Name your watch party", the one field a new party needs. The same copy
/// and the same rule as `WatchPartyHostControls`' own dialog.
private struct WatchPartyNameSheet: View {
    @Binding var name: String
    let onCreate: () -> Void
    let onCancel: () -> Void

    private var isBlank: Bool {
        name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Saturday session", text: $name)
                    .accessibilityIdentifier("watchPartyStage.createName")
            }
            .navigationTitle("Name your watch party")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create", action: onCreate)
                        .disabled(isBlank)
                        .accessibilityIdentifier("watchPartyStage.createSubmit")
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - Setup: go live

private struct WatchPartyStageSetupCard: View {
    @Environment(SessionStore.self) private var session
    @Environment(VoiceModel.self) private var voice
    @Environment(CallRatingModel.self) private var ratings
    @Environment(WatchPartyHostController.self) private var host

    let channel: Channel
    let serverName: String?
    let party: WatchPartyPayload
    let lowLatencyAvailable: Bool
    @State private var lowLatency = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(party.name)
                .font(Typography.bodyMedium)
                .foregroundStyle(Palette.paper)
            WatchPartyVoiceLine(voiceEnabled: party.voiceEnabled)
            if lowLatencyAvailable {
                Toggle("Low latency (beta)", isOn: $lowLatency)
                    .font(Typography.caption)
                    .accessibilityIdentifier("watchPartyStage.lowLatency")
            }
            Text("There is no preview before you go live. What you share is what your audience sees.")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
            goLiveButton
            WatchPartyHostErrorLine()
        }
        .watchPartyStageCard()
    }

    private var goLiveButton: some View {
        Button {
            host.goLive(
                channel: channel, serverName: serverName, partyId: party.id,
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
        .foregroundStyle(Palette.signal)
        .disabled(host.busy == .goingLive)
        .accessibilityIdentifier("watchPartyStage.goLive")
    }
}

/// What Go live will do about the microphone, said before it happens: with
/// voice off nothing asks for one, with voice on it joins muted.
private struct WatchPartyVoiceLine: View {
    let voiceEnabled: Bool

    private var title: LocalizedStringKey {
        voiceEnabled
            ? "Voice is on. Your microphone joins muted."
            : "Voice is off. Your screen goes out, your microphone does not."
    }

    var body: some View {
        Label(title, systemImage: voiceEnabled ? "mic.slash" : "speaker.slash")
        .font(Typography.caption)
        .foregroundStyle(Palette.paperMuted)
    }
}

// MARK: - Live, with no seat

private struct WatchPartyStageLiveCard: View {
    @Environment(SessionStore.self) private var session
    @Environment(VoiceModel.self) private var voice
    @Environment(CallRatingModel.self) private var ratings
    @Environment(WatchPartyHostController.self) private var host

    let channel: Channel
    let serverName: String?
    let party: WatchPartyPayload

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("You're live")
                    .font(Typography.label)
                    .foregroundStyle(Palette.signal)
                Spacer()
                endButton
            }
            Text("You left the room, so your screen is not going out. Rejoin to keep presenting.")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
            Button(action: rejoin) {
                Label("Rejoin", systemImage: "dot.radiowaves.left.and.right")
            }
            .foregroundStyle(Palette.signal)
            .accessibilityIdentifier("watchPartyStage.rejoin")
            WatchPartyHostErrorLine()
        }
        .watchPartyStageCard()
    }

    private var endButton: some View {
        Button {
            host.end(channelId: channel.id, partyId: party.id, session: session, voice: voice)
        } label: {
            if host.busy == .ending {
                ProgressView()
            } else {
                Text("End")
            }
        }
        .foregroundStyle(Palette.danger)
        .disabled(host.busy == .ending)
        .accessibilityIdentifier("watchPartyStage.end")
    }

    /// Back into the room of a party that is already live: no state change,
    /// the same microphone rule as Go live.
    private func rejoin() {
        voice.isCollapsed = false
        Task {
            await voice.join(
                channel: channel, session: session, ratings: ratings, serverName: serverName,
                microphone: watchPartyHostSeatMicrophone(voiceEnabled: party.voiceEnabled)
            )
        }
    }
}

// MARK: - Shared pieces

/// The last host action that did not land, said where the host pressed it.
/// Inline rather than an alert: `VoiceView`'s controls raise one for the same
/// `host.error`, and two alerts for one error from two stacked screens is one
/// too many.
private struct WatchPartyHostErrorLine: View {
    @Environment(WatchPartyHostController.self) private var host

    var body: some View {
        if let error = host.error {
            Text(error)
                .font(Typography.caption)
                .foregroundStyle(Palette.danger)
                .accessibilityIdentifier("watchPartyStage.error")
        }
    }
}

private extension View {
    func watchPartyStageCard() -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Metrics.hPadding)
            .padding(.vertical, 12)
            .background(Palette.surface)
    }
}
