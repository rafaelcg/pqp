import SwiftUI

/// What saving the staged order came to, once the channel list has applied it.
enum ChannelLayoutSaveOutcome {
    case saved
    /// Somebody else changed the list first. The list now draws theirs; the
    /// organizer starts again from it.
    case stale(SidebarLayout<Channel>, version: Int)
    /// The server is not in the mixed list any more. The old list is drawn.
    case off
    /// Nothing was saved. The staged order stays, with this sentence.
    case failed(String)
}

/**
 ORGANIZAR CANAIS: AN EXPLICIT MODE, NOT A LONG-PRESS DRAG.

 Long press already opens a channel's menu on the list, and a list people
 mostly tap should not rearrange by accident. So reordering is a screen of its
 own: every row and header gets the system's reorder handle, a header carries
 its channels with it, a channel belongs to the nearest header above where it
 lands. Nothing is sent until Concluir, which sends the whole order in one
 `PUT`; Cancelar throws the staged order away.

 VoiceOver cannot drag, so every row and header also carries Mover para cima /
 Mover para baixo as accessibility actions (`ChannelOrganizer.step`), which
 cross category borders the same way the web's menu does.
 */
struct ChannelOrganizerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var organizer: ChannelOrganizer<Channel>
    /// The list version this staged order was read at. Bumped only by this
    /// screen's own writes (a category created or renamed from here), so a
    /// change somebody else made meanwhile still comes back as a 409.
    @State private var baseVersion: Int
    @State private var saving = false
    @State private var notice: String?
    @State private var renaming: Channel?
    @State private var renameText = ""
    @State private var creatingCategory = false
    @State private var categoryName = ""

    let save: @MainActor (SidebarLayout<Channel>, Int) async -> ChannelLayoutSaveOutcome
    /// Creates a category on the server. Returns it and the list version
    /// after the write, when that could be read.
    let createCategory: @MainActor (String) async throws -> (Channel, Int?)
    /// Renames a category on the server, with the version after the write.
    let renameCategory: @MainActor (Channel, String) async throws -> (Channel, Int?)

    init(
        layout: SidebarLayout<Channel>,
        baseVersion: Int,
        save: @escaping @MainActor (SidebarLayout<Channel>, Int) async -> ChannelLayoutSaveOutcome,
        createCategory: @escaping @MainActor (String) async throws -> (Channel, Int?),
        renameCategory: @escaping @MainActor (Channel, String) async throws -> (Channel, Int?)
    ) {
        _organizer = State(initialValue: ChannelOrganizer(layout: layout))
        _baseVersion = State(initialValue: baseVersion)
        self.save = save
        self.createCategory = createCategory
        self.renameCategory = renameCategory
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(organizer.items) { item in
                    row(item)
                        .listRowBackground(Palette.ink)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 0, leading: Metrics.hPadding, bottom: 0, trailing: 8))
                }
                .onMove { source, destination in
                    withAnimation(.channelList(reduceMotion: reduceMotion)) {
                        _ = organizer.move(from: source, to: destination)
                    }
                }

                footer
                    .listRowBackground(Palette.ink)
                    .listRowSeparator(.hidden)
                    .moveDisabled(true)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Palette.ink)
            .environment(\.editMode, .constant(.active))
            .navigationTitle(Text("Organize channels"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.ink, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .tint(Palette.paper)
                        .disabled(saving)
                        .accessibilityIdentifier("organize.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView().tint(Palette.signal)
                    } else {
                        Button { Task { await commit() } } label: {
                            Text("organize.done").fontWeight(.semibold)
                        }
                        .tint(Palette.signal)
                        .accessibilityIdentifier("organize.done")
                    }
                }
            }
        }
        .interactiveDismissDisabled(organizer.hasChanges || saving)
        .alert(notice ?? "", isPresented: Binding(
            get: { notice != nil },
            set: { if !$0 { notice = nil } }
        )) {
            Button("Got it") { notice = nil }
        }
        .alert("Rename category", isPresented: Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )) {
            TextField("Category name", text: $renameText)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Rename") {
                let target = renaming
                let name = renameText
                Task { await commitRename(target, name: name) }
            }
            .disabled(CategoryName.normalized(renameText) == nil)
        }
        .alert("Create category", isPresented: $creatingCategory) {
            TextField("Voice rooms", text: $categoryName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let name = categoryName
                Task { await commitCreate(name) }
            }
            .disabled(CategoryName.normalized(categoryName) == nil)
        }
    }

    // MARK: - Rows

    @ViewBuilder
    private func row(_ item: OrganizerItem<Channel>) -> some View {
        switch item {
        case .header(let category):
            header(category)
        case .channel(let channel):
            ChannelRow(channel: channel)
                .accessibilityElement(children: .combine)
                .accessibilityActions { stepActions(channel.id, name: channel.name) }
                .accessibilityIdentifier("organize.row.\(channel.name)")
        case .empty:
            Text("Empty. Drag a channel here.")
                .font(.system(size: 14).italic())
                .foregroundStyle(Palette.paperMuted)
                .padding(.leading, 12)
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Palette.border).frame(width: 1)
                }
                .moveDisabled(true)
        }
    }

    private func header(_ category: Channel) -> some View {
        HStack(spacing: 8) {
            Text(category.name.uppercased())
                .font(Typography.label)
                .tracking(1.2)
                .lineLimit(1)
                .foregroundStyle(Palette.paperMuted)
            Button {
                renameText = category.name
                renaming = category
            } label: {
                Image(systemName: "pencil")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Palette.paperMuted)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(Text("Rename category"))
            Spacer(minLength: 0)
        }
        .padding(.top, 10)
        .frame(minHeight: 40)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityActions {
            stepActions(category.id, name: category.name)
            Button("Rename category") {
                renameText = category.name
                renaming = category
            }
        }
        .accessibilityIdentifier("organize.header.\(category.name)")
    }

    @ViewBuilder
    private func stepActions(_ id: String, name: String) -> some View {
        if organizer.canStep(id, direction: -1) {
            Button("Move up") { step(id, name: name, direction: -1) }
        }
        if organizer.canStep(id, direction: 1) {
            Button("Move down") { step(id, name: name, direction: 1) }
        }
    }

    private var footer: some View {
        VStack(spacing: 14) {
            Button {
                categoryName = ""
                creatingCategory = true
            } label: {
                Label("Create category", systemImage: "plus")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Palette.paper)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .overlay(
                        RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous)
                            .strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("organize.createCategory")

            Text("Hold ≡ and drag a channel or a category. Nothing is saved until you tap Done.")
                .font(.system(size: 13))
                .foregroundStyle(Palette.paperMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
        .padding(.top, 16)
        .padding(.bottom, 24)
    }

    // MARK: - Actions

    private func step(_ id: String, name: String, direction: Int) {
        var target: LayoutTarget?
        withAnimation(.channelList(reduceMotion: reduceMotion)) {
            target = organizer.step(id, direction: direction)
        }
        guard let target, let location = ChannelLayoutRules.locate(organizer.layout, id: id) else { return }
        let position = location.index + 1
        let announcement: String
        if location.isCategory {
            announcement = String(localized: "\(name) moved to position \(position) of \(location.total).")
        } else if let parentId = target.parentId,
                  let category = organizer.layout.categories.first(where: { $0.category.id == parentId }) {
            announcement = String(
                localized: "\(name) moved to \(category.category.name), position \(position) of \(location.total)."
            )
        } else {
            announcement = String(localized: "\(name) is outside the categories, position \(position) of \(location.total).")
        }
        AccessibilityNotification.Announcement(announcement).post()
    }

    private func commit() async {
        guard organizer.hasChanges else {
            dismiss()
            return
        }
        saving = true
        let outcome = await save(organizer.layout, baseVersion)
        saving = false
        switch outcome {
        case .saved, .off:
            dismiss()
        case .stale(let fresh, let version):
            withAnimation(.channelList(reduceMotion: reduceMotion)) { organizer.reset(to: fresh) }
            baseVersion = version
            notice = String(localized: "Couldn't move it. The list changed, try again.")
        case .failed(let message):
            notice = message
        }
    }

    private func commitCreate(_ raw: String) async {
        guard let name = CategoryName.normalized(raw) else { return }
        do {
            let (category, version) = try await createCategory(name)
            withAnimation(.channelList(reduceMotion: reduceMotion)) { organizer.appendCategory(category) }
            if let version { baseVersion = version }
        } catch {
            if let shown = error.userFacingMessage { notice = shown }
        }
    }

    private func commitRename(_ target: Channel?, name raw: String) async {
        guard let target, let name = CategoryName.normalized(raw), name != target.name else { return }
        do {
            let (category, version) = try await renameCategory(target, name)
            organizer.replaceCategory(category)
            if let version { baseVersion = version }
        } catch {
            if let shown = error.userFacingMessage { notice = shown }
        }
    }
}
