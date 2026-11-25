import PhotosUI
import SwiftUI

/// EDIT A SONG: its name, its artist and its cover photo, in one sheet
/// (`jam-edit-sheet.tsx`). Opened from the song's menu and the header's pencil
/// for the people the server lets edit it (the song's author or a moderator, flag
/// on); the server decides again on every write, and a 403 here is said in
/// words and the song's permissions are read again.
///
/// The picture on top is the tile, live: what is edited is shown the way the
/// song will look in the list. The photo goes up when it is picked and counts
/// when Save is pressed.
struct JamEditSongSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    @State private var model: JamEditSongModel
    @State private var picked: PhotosPickerItem?
    @State private var confirmingDiscard = false
    @FocusState private var focus: Field?

    private enum Field { case title, artist }

    init(song: JamSongModel) {
        _model = State(initialValue: JamEditSongModel(song: song))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    preview
                    photoControls
                    fields
                    if let failure = model.failure { failureRow(failure) }
                }
                .padding(Metrics.hPadding)
                .animation(.jam(reduceMotion: reduceMotion), value: model.failure)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Palette.ink.ignoresSafeArea())
            .navigationTitle("Edit song")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.ink, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { requestClose() }
                        .tint(Palette.paper)
                        .disabled(model.saving)
                        .accessibilityIdentifier("jam.edit.cancel")
                }
                ToolbarItem(placement: .confirmationAction) { saveButton }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Palette.ink)
        .interactiveDismissDisabled(model.isDirty || model.saving)
        .confirmationDialog("Discard your changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("You changed this song and have not saved.")
        }
        .onChange(of: picked) { _, item in
            guard let item else { return }
            model.pick(item, api: session.api)
            // Cleared so choosing the same photo again after a failure still fires.
            picked = nil
        }
        .onDisappear { model.close() }
    }

    private func requestClose() {
        if model.isDirty { confirmingDiscard = true } else { dismiss() }
    }

    // MARK: The picture

    private var preview: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("How it shows in the list")
                .font(JamFont.text(12, .bold)).foregroundStyle(Palette.paperMuted)
                .textCase(.uppercase).tracking(1)
                .accessibilityAddTraits(.isHeader)
            JamEditPreviewTile(
                model: model,
                title: (try? JamText.title(model.title).get()) ?? JamBidi.clean(model.current.title),
                artist: (try? JamText.artist(model.artist).get()) ?? nil
            )
            .frame(maxWidth: 260)
            .frame(maxWidth: .infinity)
        }
    }

    private var photoControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                PhotosPicker(selection: $picked, matching: .images, photoLibrary: .shared()) {
                    Label(model.hasPhoto ? "Change photo" : "Add a photo", systemImage: "photo.badge.plus")
                        .font(JamFont.text(14, .bold))
                        .foregroundStyle(Palette.paper)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .background(Capsule().fill(Palette.surfaceRaised))
                        .overlay(Capsule().strokeBorder(Palette.border, lineWidth: 1))
                        .contentShape(Capsule())
                }
                .disabled(model.saving || model.isUploading)
                .accessibilityIdentifier("jam.edit.photo")
                if model.hasPhoto {
                    Button {
                        Haptics.selection()
                        model.removePhoto()
                    } label: {
                        Image(systemName: "trash")
                            .font(JamFont.text(16, .semibold))
                            .foregroundStyle(Palette.paperSubtle)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(model.saving)
                    .accessibilityLabel(Text("Remove photo"))
                    .accessibilityIdentifier("jam.edit.removePhoto")
                }
                Spacer(minLength: 0)
            }
            noteLine
        }
    }

    @ViewBuilder
    private var noteLine: some View {
        switch model.upload {
        case .failed(let problem):
            Text(Self.message(for: problem))
                .font(JamFont.text(12)).foregroundStyle(Palette.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("jam.edit.photoError")
        case .uploading:
            Text("Sending the photo")
                .font(JamFont.text(12)).foregroundStyle(Palette.paperMuted)
        case .idle:
            switch model.note {
            case .ready:
                Text("It only counts once you save.")
                    .font(JamFont.text(12)).foregroundStyle(Palette.paperMuted)
                    .accessibilityIdentifier("jam.edit.photoNote")
            case .removed:
                Text("It only goes away once you save.")
                    .font(JamFont.text(12)).foregroundStyle(Palette.paperMuted)
                    .accessibilityIdentifier("jam.edit.photoNote")
            case nil:
                EmptyView()
            }
        }
    }

    /// The web's `jam.edit.photo*` lines, said for a phone.
    static func message(for problem: JamCoverRules.Problem) -> LocalizedStringKey {
        switch problem {
        case .type: "Pick a JPG, PNG or WebP image."
        case .small(let width, let height):
            "That photo is too small (\(width) x \(height)). Pick one at least \(JamCoverRules.minSide) px on each side."
        case .unreadable: "This phone cannot open that image. Try another one."
        case .tooLarge: "That photo came out too large to send (the limit is 4 MB). Pick a smaller one."
        case .failed: "The photo did not go up. Pick it again."
        }
    }

    // MARK: The words

    private var fields: some View {
        VStack(alignment: .leading, spacing: 16) {
            field(
                "Song name", text: Binding(get: { model.title }, set: { model.titleEdit = $0 }),
                prompt: "e.g. In Bloom", id: "jam.edit.title", field: .title
            )
            if model.showsTitleProblem, let problem = model.titleProblem {
                Text(Self.message(for: problem))
                    .font(JamFont.text(12)).foregroundStyle(Palette.danger)
                    .accessibilityIdentifier("jam.edit.titleError")
            }
            field(
                "Artist", text: Binding(get: { model.artist }, set: { model.artistEdit = $0 }),
                prompt: "Leave empty if it is yours", id: "jam.edit.artist", field: .artist
            )
            if model.showsArtistProblem {
                Text("That artist has nothing to read. Use letters or numbers, or leave it empty.")
                    .font(JamFont.text(12)).foregroundStyle(Palette.danger)
                    .accessibilityIdentifier("jam.edit.artistError")
            }
        }
    }

    private func field(
        _ title: LocalizedStringKey, text: Binding<String>, prompt: LocalizedStringKey, id: String, field: Field
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(JamFont.text(13, .bold)).foregroundStyle(Palette.paperMuted)
            TextField("", text: text, prompt: Text(prompt).foregroundStyle(Palette.paperMuted))
                .focused($focus, equals: field)
                .textInputAutocapitalization(.sentences)
                .submitLabel(field == .title ? .next : .done)
                .onSubmit { focus = field == .title ? .artist : nil }
                .font(JamFont.text(17))
                .foregroundStyle(Palette.paper)
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                .background(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).fill(Palette.surface))
                .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).strokeBorder(Palette.border, lineWidth: 1))
                .accessibilityLabel(Text(title))
                .accessibilityIdentifier(id)
        }
    }

    private func failureRow(_ failure: JamEditFailure) -> some View {
        Text(Self.message(for: failure))
            .font(JamFont.text(13, .semibold))
            .foregroundStyle(Palette.paper)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous).fill(Palette.surfaceRaised))
            .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous).strokeBorder(Palette.danger, lineWidth: 1))
            .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("jam.edit.error")
    }

    /// What is wrong with the name, in the web's words (`jam.start.*`).
    static func message(for problem: JamText.Problem) -> LocalizedStringKey {
        switch problem {
        case .empty: "Give the song a name."
        case .invisible: "That name has nothing to read. Use letters or numbers."
        case .long: "The name can be \(JamText.titleMax) characters at most."
        }
    }

    static func message(for failure: JamEditFailure) -> LocalizedStringKey {
        switch failure {
        case .denied: "You cannot edit this song."
        case .invalid: "Some of the text has nothing to read: the song's name or the artist. Go back and fix it."
        case .kind(let kind): JamEditCopy.message(for: kind)
        }
    }

    private var saveButton: some View {
        Button {
            Task { if await model.save(api: session.api) { dismiss() } }
        } label: {
            ZStack {
                if model.saving {
                    ProgressView().controlSize(.small).tint(Palette.inkDeep)
                } else {
                    Text("Save")
                        .font(JamFont.text(15, .bold))
                        .foregroundStyle(model.canSave ? Palette.inkDeep : Palette.paperMuted)
                }
            }
            .padding(.horizontal, 16)
            .frame(minWidth: 64, minHeight: 36)
            .background(Capsule().fill(model.canSave || model.saving ? Palette.signal : Palette.surfaceRaised))
        }
        .buttonStyle(.plain)
        .disabled(!model.canSave)
        .animation(.jamQuick(reduceMotion: reduceMotion), value: model.canSave)
        .accessibilityLabel(Text("Save"))
        .accessibilityIdentifier("jam.edit.save")
    }
}

// MARK: - The tile, live

/// The song's card as the wall draws it, live: the picture (clean, square), and
/// under it the name and artist as they are typed. A photo that is going up
/// stays under a progress ring; a fresh one lands with a small pop (none under
/// Reduce Motion). The text goes through `JamBidi`, as on the wall.
private struct JamEditPreviewTile: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let model: JamEditSongModel
    let title: String
    let artist: String?

    private var tint: Color { (JamWho.instruments(of: model.current).first ?? .other).color }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            picture
                .aspectRatio(1, contentMode: .fit)
                .frame(maxWidth: .infinity)
                .clipped()
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: JamBidi.clean(title))
                    .font(JamFont.text(15, .bold)).foregroundStyle(Palette.paper)
                    .lineLimit(2)
                Text(verbatim: artist.map(JamBidi.clean) ?? String(localized: "Original"))
                    .font(JamFont.text(12)).foregroundStyle(Palette.paperMuted)
                    .lineLimit(1)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface)
        }
        .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous).strokeBorder(Palette.border, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: JamBidi.clean([title, artist].compactMap { $0 }.joined(separator: ", "))))
        .accessibilityIdentifier("jam.edit.tile")
    }

    @ViewBuilder
    private var picture: some View {
        ZStack {
            tint
            if let local = model.shownLocal {
                Color.clear.overlay {
                    Image(uiImage: local).resizable().scaledToFill()
                }
                .clipped()
                .brightness(model.isUploading ? -0.35 : 0)
                .id(model.upload == .idle ? "landed" : "going")
                .transition(reduceMotion ? .opacity : .scale(scale: 0.96).combined(with: .opacity))
            } else if model.showsCurrentCover {
                JamCoverImage(songId: model.current.id, cover: model.current.cover)
            } else {
                // The art a song has without a cover: its colour and the shape of its sound.
                JamWaveform(
                    values: model.current.previewPeaks ?? [],
                    color: Palette.ink, barWidth: 4, gap: 3
                )
                .frame(height: 72)
                .padding(.horizontal, 18)
            }
            if case .uploading(let fraction) = model.upload {
                ZStack {
                    Circle().stroke(Palette.border, lineWidth: 4)
                    Circle().trim(from: 0, to: max(0.02, fraction))
                        .stroke(Palette.signal, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: 44, height: 44)
                .padding(10)
                .background(Circle().fill(Palette.inkDeep))
                .accessibilityLabel(Text("Sending the photo"))
                .accessibilityValue(Text(verbatim: "\(Int(fraction * 100))%"))
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: model.upload == .idle)
        .clipped()
    }
}
