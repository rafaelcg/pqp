import Foundation

// THE CHANNEL LIST, AS ONE SET OF RULES FOR EVERY CLIENT.
//
// A Swift port of `packages/shared/src/channel-layout.ts`. A server's list is
// categories and the channels inside them, plus the channels in no category
// ("loose"), which sit above the first category with no header. With the
// mixed list on (`GET /api/servers/:id/channel-layout` says `mixed`), every
// type mixes in one order per parent. With it off, loose channels keep the
// old split: text and forums, then voice, then watch party rooms.
//
// `packages/shared/fixtures/channel-layout-cases.json` pins these functions,
// and `ChannelLayoutTests` runs that same file here, so the web, iOS and
// Android cannot drift apart again (they had: Android drew a category's text
// half before its voice half).

/// The fields the layout reads. `Channel` has them all.
protocol LayoutChannel: Sendable {
    var id: String { get }
    var type: String { get }
    var parentId: String? { get }
    var position: Int { get }
}

extension Channel: LayoutChannel {}

struct SidebarCategory<T: LayoutChannel>: Sendable {
    var category: T
    var children: [T]
}

struct SidebarLayout<T: LayoutChannel>: Sendable {
    /// Channels in no category, above the first category, no header.
    var loose: [T]
    var categories: [SidebarCategory<T>]

    /// The layout as ids only: what tests compare, and what tells the
    /// organizer whether anything moved.
    var ids: LayoutIds {
        LayoutIds(
            loose: loose.map(\.id),
            categories: categories.map { LayoutIds.Category(id: $0.category.id, children: $0.children.map(\.id)) }
        )
    }
}


/// A layout written as ids, in display order. The fixture's `expect` shape.
struct LayoutIds: Equatable, Decodable {
    struct Category: Equatable, Decodable {
        var id: String
        var children: [String]
    }

    var loose: [String]
    var categories: [Category]
}

/// Where a channel lands: a parent (nil = loose) and an index in it.
struct LayoutTarget: Equatable, Decodable {
    let parentId: String?
    let index: Int
}

/// Where a channel or a category sits now.
struct LayoutLocation: Equatable {
    let parentId: String?
    let index: Int
    let total: Int
    let isCategory: Bool
}

/// `PUT /api/servers/:id/channel-layout`, see `channelLayoutSchema`.
struct ChannelLayoutPayload: Codable, Equatable, Sendable {
    struct Group: Codable, Equatable, Sendable {
        let parentId: String?
        let channelIds: [String]

        private enum CodingKeys: String, CodingKey { case parentId, channelIds }

        // `parentId` goes out as an explicit null for the loose group: the
        // synthesized encoder would drop the key, and the server's schema
        // requires it.
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(parentId, forKey: .parentId)
            try container.encode(channelIds, forKey: .channelIds)
        }
    }

    let baseVersion: Int
    let categoryIds: [String]
    let groups: [Group]
}

enum ChannelLayoutRules {
    /// Old split order for loose channels: text and forums, voice, watch party.
    static func legacyTypeRank(_ type: String) -> Int {
        switch type {
        case "text", "forum": 0
        case "voice": 1
        default: 2
        }
    }

    private static func byPosition(_ a: some LayoutChannel, _ b: some LayoutChannel) -> Bool {
        if a.position != b.position { return a.position < b.position }
        return a.id < b.id
    }

    private static func byTypeThenPosition(_ a: some LayoutChannel, _ b: some LayoutChannel) -> Bool {
        let rank = legacyTypeRank(a.type) - legacyTypeRank(b.type)
        return rank != 0 ? rank < 0 : byPosition(a, b)
    }

    /// The list, from a server's channels as the API returns them. Threads are
    /// dropped. A channel whose category is not in the list is loose, so
    /// nothing ever vanishes.
    static func build<T: LayoutChannel>(_ channels: [T], mixed: Bool, hideWatchParty: Bool = false) -> SidebarLayout<T> {
        let rows = channels.filter { $0.type != "thread" && !(hideWatchParty && $0.type == "watch_party") }
        let categories = rows.filter { $0.type == "category" }.sorted(by: byPosition)
        let categoryIds = Set(categories.map(\.id))
        var children: [String: [T]] = [:]
        var loose: [T] = []
        for channel in rows where channel.type != "category" {
            if let parentId = channel.parentId, categoryIds.contains(parentId) {
                children[parentId, default: []].append(channel)
            } else {
                loose.append(channel)
            }
        }
        loose.sort(by: mixed ? byPosition : byTypeThenPosition)
        return SidebarLayout(
            loose: loose,
            categories: categories.map { category in
                SidebarCategory(category: category, children: (children[category.id] ?? []).sorted(by: byPosition))
            }
        )
    }

    static func locate<T>(_ layout: SidebarLayout<T>, id: String) -> LayoutLocation? {
        if let index = layout.categories.firstIndex(where: { $0.category.id == id }) {
            return LayoutLocation(parentId: nil, index: index, total: layout.categories.count, isCategory: true)
        }
        if let index = layout.loose.firstIndex(where: { $0.id == id }) {
            return LayoutLocation(parentId: nil, index: index, total: layout.loose.count, isCategory: false)
        }
        for entry in layout.categories {
            if let index = entry.children.firstIndex(where: { $0.id == id }) {
                return LayoutLocation(
                    parentId: entry.category.id, index: index, total: entry.children.count, isCategory: false
                )
            }
        }
        return nil
    }

    /// Move one channel to `target.index` of `target.parentId` (nil = loose),
    /// or one category to `target.index` among categories (its parent must be
    /// nil: categories never nest). The index is read with the moved row
    /// already taken out, and clamped. Anything impossible returns nil.
    static func move<T>(_ layout: SidebarLayout<T>, id: String, to target: LayoutTarget) -> SidebarLayout<T>? {
        guard let from = locate(layout, id: id) else { return nil }
        var next = layout
        if from.isCategory {
            guard target.parentId == nil else { return nil }
            let moved = next.categories.remove(at: from.index)
            next.categories.insert(moved, at: clamp(target.index, next.categories.count))
            return next
        }
        let destinationCategory: Int?
        if let parentId = target.parentId {
            guard let index = next.categories.firstIndex(where: { $0.category.id == parentId }) else { return nil }
            destinationCategory = index
        } else {
            destinationCategory = nil
        }
        let moved: T
        if let parentId = from.parentId,
           let source = next.categories.firstIndex(where: { $0.category.id == parentId }) {
            moved = next.categories[source].children.remove(at: from.index)
        } else {
            moved = next.loose.remove(at: from.index)
        }
        if let destinationCategory {
            let length = next.categories[destinationCategory].children.count
            next.categories[destinationCategory].children.insert(moved, at: clamp(target.index, length))
        } else {
            next.loose.insert(moved, at: clamp(target.index, next.loose.count))
        }
        return next
    }

    private static func clamp(_ index: Int, _ length: Int) -> Int {
        max(0, min(index, length))
    }

    /// One step up (-1) or down (+1), crossing category borders, so an
    /// accessibility action reaches every slot a drag can. A channel at the
    /// top of a category moving up lands at the end of the previous one (or
    /// of the loose area); at the bottom moving down, at the start of the
    /// next. A category swaps with its neighbour. Nil when there is nowhere
    /// to go.
    static func step<T>(_ layout: SidebarLayout<T>, id: String, direction: Int) -> (layout: SidebarLayout<T>, target: LayoutTarget)? {
        guard let from = locate(layout, id: id), direction == 1 || direction == -1 else { return nil }
        var target: LayoutTarget?
        let index = from.index + direction
        if index >= 0 && index < from.total {
            target = LayoutTarget(parentId: from.parentId, index: index)
        } else if !from.isCategory {
            let groups: [String?] = [nil] + layout.categories.map { Optional($0.category.id) }
            if let groupIndex = groups.firstIndex(of: from.parentId) {
                let neighbourIndex = groupIndex + direction
                if neighbourIndex >= 0 && neighbourIndex < groups.count {
                    let neighbour = groups[neighbourIndex]
                    if direction == -1 {
                        let length = neighbour.flatMap { id in
                            layout.categories.first { $0.category.id == id }?.children.count
                        } ?? layout.loose.count
                        target = LayoutTarget(parentId: neighbour, index: length)
                    } else {
                        target = LayoutTarget(parentId: neighbour, index: 0)
                    }
                }
            }
        }
        guard let target, let next = move(layout, id: id, to: target) else { return nil }
        return (next, target)
    }

    /// The full order the server stores, as the PUT body.
    static func payload<T>(_ layout: SidebarLayout<T>, baseVersion: Int) -> ChannelLayoutPayload {
        ChannelLayoutPayload(
            baseVersion: baseVersion,
            categoryIds: layout.categories.map(\.category.id),
            groups: [ChannelLayoutPayload.Group(parentId: nil, channelIds: layout.loose.map(\.id))]
                + layout.categories.map {
                    ChannelLayoutPayload.Group(parentId: $0.category.id, channelIds: $0.children.map(\.id))
                }
        )
    }
}

extension ChannelLayoutRules {
    /// Rewrites `parentId` and `position` on every channel the layout holds,
    /// so a list saved with a `null` read-back draws the order that was sent.
    /// Channels the layout does not hold (threads, watch party rooms, types
    /// this build cannot draw) come back as they were.
    static func apply(_ layout: SidebarLayout<Channel>, to channels: [Channel]) -> [Channel] {
        var placed: [String: (parentId: String?, position: Int)] = [:]
        for (index, entry) in layout.categories.enumerated() {
            placed[entry.category.id] = (nil, index)
            for (childIndex, child) in entry.children.enumerated() {
                placed[child.id] = (entry.category.id, childIndex)
            }
        }
        for (index, channel) in layout.loose.enumerated() {
            placed[channel.id] = (nil, index)
        }
        return channels.map { channel in
            guard let place = placed[channel.id] else { return channel }
            var copy = channel
            copy.parentId = place.parentId
            copy.position = place.position
            return copy
        }
    }
}

// MARK: - Organizar canais

/// One row of the organizer's flat list: headers and channels in one
/// `ForEach`, so `onMove` can carry a row across a category border.
enum OrganizerItem<T: LayoutChannel>: Identifiable {
    case header(T)
    case channel(T)
    /// "Vazia. Arrasta um canal pra cá." under an empty category. Never moves.
    case empty(categoryId: String)

    var id: String {
        switch self {
        case .header(let category): "h:\(category.id)"
        case .channel(let channel): "c:\(channel.id)"
        case .empty(let categoryId): "e:\(categoryId)"
        }
    }

    var isHeader: Bool {
        if case .header = self { return true }
        return false
    }
}

/// The staged order in Organizar canais. Every move edits this copy only;
/// Concluir sends it in one PUT and Cancelar throws it away, so a whole
/// reorganisation is one request and at most one 409.
struct ChannelOrganizer<T: LayoutChannel> {
    private(set) var layout: SidebarLayout<T>
    private(set) var original: LayoutIds

    init(layout: SidebarLayout<T>) {
        self.layout = layout
        self.original = layout.ids
    }

    var hasChanges: Bool { layout.ids != original }

    /// Start again from a fresh list (after a 409, or a category created
    /// mid-session), keeping nothing staged.
    mutating func reset(to layout: SidebarLayout<T>) {
        self.layout = layout
        self.original = layout.ids
    }

    /// A category created from inside the mode. It already exists on the
    /// server, so it is part of the starting order rather than a staged move.
    mutating func appendCategory(_ category: T) {
        layout.categories.append(SidebarCategory(category: category, children: []))
        original.categories.append(LayoutIds.Category(id: category.id, children: []))
    }

    /// A category renamed from inside the mode: same id, same place.
    mutating func replaceCategory(_ category: T) {
        guard let index = layout.categories.firstIndex(where: { $0.category.id == category.id }) else { return }
        layout.categories[index].category = category
    }

    var items: [OrganizerItem<T>] {
        var out: [OrganizerItem<T>] = layout.loose.map { .channel($0) }
        for entry in layout.categories {
            out.append(.header(entry.category))
            if entry.children.isEmpty {
                out.append(.empty(categoryId: entry.category.id))
            } else {
                out.append(contentsOf: entry.children.map { .channel($0) })
            }
        }
        return out
    }

    /// `List.onMove`: `destination` is an index in `items` before the row
    /// is taken out. A header carries its channels and lands among the other
    /// categories; a channel belongs to the nearest header above where it was
    /// dropped (none: loose). Returns whether anything changed.
    @discardableResult
    mutating func move(from source: IndexSet, to destination: Int) -> Bool {
        let rows = items
        guard let from = source.first, rows.indices.contains(from) else { return false }
        let target: LayoutTarget
        let id: String
        switch rows[from] {
        case .empty:
            return false
        case .header(let category):
            id = category.id
            let before = rows[..<min(destination, rows.count)].enumerated().filter { offset, item in
                item.isHeader && offset != from
            }.count
            target = LayoutTarget(parentId: nil, index: before)
        case .channel(let channel):
            id = channel.id
            var rest = rows
            rest.remove(at: from)
            let insertAt = min(destination > from ? destination - 1 : destination, rest.count)
            var parentId: String?
            var index = 0
            for item in rest[..<insertAt].reversed() {
                if case .header(let category) = item {
                    parentId = category.id
                    break
                }
                if case .channel = item { index += 1 }
            }
            target = LayoutTarget(parentId: parentId, index: index)
        }
        guard let next = ChannelLayoutRules.move(layout, id: id, to: target) else { return false }
        let changed = next.ids != layout.ids
        layout = next
        return changed
    }

    /// The accessibility actions Mover para cima / Mover para baixo.
    @discardableResult
    mutating func step(_ id: String, direction: Int) -> LayoutTarget? {
        guard let result = ChannelLayoutRules.step(layout, id: id, direction: direction) else { return nil }
        layout = result.layout
        return result.target
    }

    func canStep(_ id: String, direction: Int) -> Bool {
        ChannelLayoutRules.step(layout, id: id, direction: direction) != nil
    }
}

// MARK: - The config the server answers

/// `GET /api/servers/:id/channel-layout`. Draw the mixed list only when
/// `mixed`; an older server answers 404, which the client reads as the old
/// list. `version` goes back as the PUT's `baseVersion`.
struct ChannelLayoutConfig: Codable, Equatable, Sendable {
    let mixed: Bool
    let version: Int

    static let legacy = ChannelLayoutConfig(mixed: false, version: 0)
}

/// What a `PUT …/channel-layout` came back with.
enum ChannelLayoutSaveResult: Sendable {
    /// Saved. `channels` nil means the server could not read the list back:
    /// keep the order that was drawn.
    case saved(channels: [Channel]?, version: Int)
    /// Somebody else changed the list first. Adopt both, say so, try again.
    case stale(channels: [Channel], version: Int)
    /// The server is not in the mixed list (any more): draw the old one.
    case off
    /// The server refused the body. Its sentence, shown as is.
    case invalid(String)
}

// MARK: - Category names

/// A category is a label, not a slug: "Salas de voz" is fine. The server's
/// `categoryNameSchema`: trimmed, 1 to 32 characters (counted the way
/// JavaScript counts them, in UTF-16 units), no control characters.
enum CategoryName {
    static let maxLength = 32

    /// The name to send, or nil when the server would refuse it.
    static func normalized(_ raw: String) -> String? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= maxLength else { return nil }
        let refused = name.unicodeScalars.contains {
            CharacterSet.controlCharacters.contains($0) || $0 == "\u{2028}" || $0 == "\u{2029}"
        }
        return refused ? nil : name
    }
}

// MARK: - Which list this device drew last

/// The last `mixed` answer this device saw for a server, so a server in the
/// mixed list opens straight into it instead of flashing the old one while
/// `GET …/channel-layout` is in flight. The version is never remembered: a
/// save made before the fresh answer lands sends 0 and gets a 409 with the
/// real one, which is the safe direction.
struct ChannelLayoutMemory {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private func key(_ serverId: String) -> String { "pqp.channelLayout.mixed.\(serverId)" }

    func load(serverId: String) -> ChannelLayoutConfig {
        defaults.bool(forKey: key(serverId)) ? ChannelLayoutConfig(mixed: true, version: 0) : .legacy
    }

    func save(_ config: ChannelLayoutConfig, serverId: String) {
        if config.mixed {
            defaults.set(true, forKey: key(serverId))
        } else {
            defaults.removeObject(forKey: key(serverId))
        }
    }
}

// MARK: - One channel refresh at a time

/// Serialises the quiet re-reads of the channel list (a `channels-update`, a
/// return to the foreground). While one runs, any number of further requests
/// collapse into ONE follow-up that starts when it ends, so a burst of N
/// frames costs at most two reads, and a slow older answer can never land on
/// top of a newer one: two reads never overlap.
@MainActor
final class ChannelRefreshGate {
    private var running = false
    private var again = false

    /// True when this call ran [body] itself; false when a read was already in
    /// flight and the call only queued the follow-up.
    @discardableResult
    func run(_ body: @MainActor () async -> Void) async -> Bool {
        if running {
            again = true
            return false
        }
        running = true
        defer { running = false }
        repeat {
            again = false
            await body()
        } while again
        return true
    }
}
