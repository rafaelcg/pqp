import Foundation

// Wire shapes and pure rules for the communities wave: the public directory
// (`packages/shared/src/communities.ts`), depoimentos and the community badges
// (`packages/shared/src/depoimentos.ts`), and handles
// (`packages/shared/src/profiles.ts`).
//
// SAME TWO RULES THE REST OF THIS LAYER FOLLOWS. Every `?` mirrors a
// `.nullable()` there; every pure helper is a port of the web client's model
// module rather than a reinvention, so the two clients cannot drift on what a
// card says or which handle is refusable.
//
// DECODING IS LENIENT HERE IN THE WAY `Message.thread` IS. These payloads
// travel with a feature flag on the other end of a version skew: the server may
// grow a field, or a category slug, that this build has never heard of, and the
// cost of that must be one missing accessory rather than a dropped card.

// MARK: - Categories

/// The ten category slugs, in `COMMUNITY_CATEGORIES` order.
///
/// ORDER IS THE SHARED CONSTANT'S ORDER, never alphabetical: the slugs are
/// ordered by expected Brazilian pull, and re-sorting them by their translated
/// label would give the chip row a different order in every language for no
/// reason.
///
/// `geral` is last and is the escape hatch — which is also what makes it the
/// right landing place for a slug this build does not know. A future category
/// must cost a card its precise chip, never its existence.
enum CommunityCategory: String, CaseIterable, Codable, Sendable, Hashable, Identifiable {
    case games
    case musica
    case futebol
    case estudos
    case anime
    case tech
    case humor
    case seriesFilmes = "series-filmes"
    case corre
    case geral

    var id: String { rawValue }

    /// One glyph per category, copied from `CATEGORY_EMOJI` in
    /// `client/src/components/communities/communities-model.ts`.
    ///
    /// EMOJI RATHER THAN SF SYMBOLS, for the reason the web file gives: ten
    /// symbols of one weight in one colour scan as texture rather than as ten
    /// different things, and half of these words (humor, corre, futebol) have no
    /// symbol that reads as them to a Brazilian. They are decorative — every
    /// chip carries the label as its accessibility name.
    var emoji: String {
        switch self {
        case .games: "🎮"
        case .musica: "🎧"
        case .futebol: "⚽"
        case .estudos: "📚"
        case .anime: "🌸"
        case .tech: "💻"
        case .humor: "😂"
        case .seriesFilmes: "🍿"
        case .corre: "💸"
        case .geral: "🌎"
        }
    }

    /// The label a person reads. A closed switch rather than a dictionary, so
    /// adding a slug without a label is a compile error — the same guarantee the
    /// web's total `Record` gives.
    var label: String {
        switch self {
        case .games: String(localized: "Games")
        case .musica: String(localized: "Music")
        case .futebol: String(localized: "Football")
        case .estudos: String(localized: "Study")
        case .anime: String(localized: "Anime")
        case .tech: String(localized: "Tech")
        case .humor: String(localized: "Humour")
        case .seriesFilmes: String(localized: "Series & film")
        case .corre: String(localized: "Hustle")
        case .geral: String(localized: "General")
        }
    }

    /// A slug off the wire, or the catch-all. See the type note.
    static func lenient(_ raw: String?) -> CommunityCategory {
        guard let raw, let known = CommunityCategory(rawValue: raw) else { return .geral }
        return known
    }
}

/// The "everything" chip, which has no slug to hang off.
enum CommunityFilter: Hashable, Identifiable, Sendable {
    case all
    case category(CommunityCategory)

    var id: String {
        switch self {
        case .all: "all"
        case .category(let slug): slug.rawValue
        }
    }

    var emoji: String {
        switch self {
        case .all: "✨"
        case .category(let slug): slug.emoji
        }
    }

    var label: String {
        switch self {
        case .all: String(localized: "All")
        case .category(let slug): slug.label
        }
    }

    /// The query parameter, or nil for no filter at all.
    var slug: String? {
        switch self {
        case .all: nil
        case .category(let slug): slug.rawValue
        }
    }

    /// The chip row: "all", then every category in its declared order.
    static var chips: [CommunityFilter] {
        [.all] + CommunityCategory.allCases.map { .category($0) }
    }
}

// MARK: - Directory

/// One directory row — the public projection of a server.
///
/// Deliberately NOT `Server`: that shape carries `ownerId`, the retention policy
/// and the SSO domain, three facts about the inside of a room a stranger
/// browsing has no business reading.
struct CommunitySummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let tagline: String?
    let category: CommunityCategory
    /// From the maintained counter column, approximate by construction and
    /// treated as such: it decorates a card and nothing is authorised by it.
    var memberCount: Int
    /// True when the caller is already inside — the card says "Abrir".
    var joined: Bool
    let createdAt: Date?
    /// Root-relative `/api/servers/:id/icon?v=…`, resolved against the API base
    /// by `Avatar.resolve`. Null where the community set none.
    let iconUrl: String?
    let bannerUrl: String?

    enum CodingKeys: String, CodingKey {
        case id, name, tagline, category, memberCount, joined, createdAt
        case iconUrl, bannerUrl
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        tagline = try c.decodeIfPresent(String.self, forKey: .tagline)
        // A slug this build has never seen costs the chip its precise wording,
        // never the card. See `CommunityCategory.lenient`.
        category = CommunityCategory.lenient(
            try? c.decodeIfPresent(String.self, forKey: .category)
        )
        memberCount = try c.decodeIfPresent(Int.self, forKey: .memberCount) ?? 0
        joined = try c.decodeIfPresent(Bool.self, forKey: .joined) ?? false
        createdAt = (try? c.decodeIfPresent(Date.self, forKey: .createdAt)) ?? nil
        iconUrl = try c.decodeIfPresent(String.self, forKey: .iconUrl)
        bannerUrl = try c.decodeIfPresent(String.self, forKey: .bannerUrl)
    }

    /// For previews and tests; never for anything the server sent.
    init(
        id: String,
        name: String,
        tagline: String? = nil,
        category: CommunityCategory = .geral,
        memberCount: Int = 0,
        joined: Bool = false,
        createdAt: Date? = nil,
        iconUrl: String? = nil,
        bannerUrl: String? = nil
    ) {
        self.id = id
        self.name = name
        self.tagline = tagline
        self.category = category
        self.memberCount = memberCount
        self.joined = joined
        self.createdAt = createdAt
        self.iconUrl = iconUrl
        self.bannerUrl = bannerUrl
    }
}

struct CommunityPage: Decodable, Sendable {
    var communities: [CommunitySummary] = []
    var hasMore: Bool = false

    enum CodingKeys: String, CodingKey { case communities, hasMore }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        communities = try c.decodeIfPresent([CommunitySummary].self, forKey: .communities) ?? []
        hasMore = try c.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
    }

    init(communities: [CommunitySummary], hasMore: Bool) {
        self.communities = communities
        self.hasMore = hasMore
    }
}

/// `GET /api/communities/config`. The one route in the feature that is not
/// flag-gated, so a client can tell "off" from "old server" from "blip" — all
/// three of which it must render identically as nothing here.
struct CommunityConfig: Decodable, Sendable {
    let enabled: Bool
}

/// `POST /api/communities/:id/join`. 200 whether or not a row was written;
/// `joinedNow` is what tells a welcome from a re-entry.
struct CommunityJoinResult: Decodable, Sendable {
    let serverId: String
    let serverName: String?
    let joinedNow: Bool
}

/// The directory's pure logic, out of the view so the rules worth asserting can
/// be asserted without a screen. Ported from `communities-model.ts`.
enum CommunityDirectory {
    /// Same page size the web asks for, and the server's own default.
    static let pageSize = 24

    /// What a card's primary button does. `joined` comes from the server, per
    /// viewer, so this never has to guess from a server list that may not have
    /// loaded.
    static func cardAction(_ community: CommunitySummary) -> CardAction {
        community.joined ? .open : .join
    }

    enum CardAction: String, Sendable { case join, open }

    /// The monogram a community with no icon falls back to.
    ///
    /// First character of the first two words — "Eu odeio acordar cedo" reads as
    /// "EO", which is more distinguishable in a list than one letter. Uses
    /// `Character`s rather than UTF-16 indices because a name that starts with an
    /// emoji (many will) is a surrogate pair, and half of one renders as a
    /// replacement glyph.
    static func monogram(_ name: String) -> String {
        let words = name.split(whereSeparator: { $0.isWhitespace })
        guard !words.isEmpty else { return "?" }
        return words.prefix(2)
            .compactMap { $0.first.map(String.init) }
            .joined()
            .uppercased()
    }

    /// The member count as it is printed on a card.
    ///
    /// COMPACT AND LOCALE-CORRECT, because both alternatives are wrong: "12873"
    /// is a number nobody parses at a glance, and a hand-rolled "12.8k" is wrong
    /// in Portuguese, where the separator is a comma and the word is "mil" —
    /// `1,2 mil`, not `1.2K`. Foundation already knows all of that.
    ///
    /// Below a thousand nothing is abbreviated in any locale, so the common case
    /// — a directory of small rooms — reads as the exact number it is.
    static func memberCount(_ count: Int, locale: Locale = .current) -> String {
        count.formatted(
            .number
                .notation(.compactName)
                .precision(.fractionLength(0...1))
                .locale(locale)
        )
    }

    /// Merge a freshly-loaded page into what is already on screen.
    ///
    /// DEDUPED BY ID, because the directory's order key is `member_count` and it
    /// moves under the reader: somebody joining between "show more" taps shifts
    /// a community up a page, and an offset-paginated second request hands back a
    /// row the first already delivered. Last write wins so the fresher `joined`
    /// and count are the ones kept; insertion order is the server's order.
    static func merge(
        _ existing: [CommunitySummary],
        _ incoming: [CommunitySummary]
    ) -> [CommunitySummary] {
        var order: [String] = []
        var byId: [String: CommunitySummary] = [:]
        for one in existing + incoming {
            if byId[one.id] == nil { order.append(one.id) }
            byId[one.id] = one
        }
        return order.compactMap { byId[$0] }
    }

    /// Reflect a successful join into the list without refetching.
    ///
    /// The count is bumped locally because the card is about to say "Abrir" and a
    /// number that did not move alongside it reads as a stale page. Corrected by
    /// the next real load; nothing is authorised by it.
    static func applyJoin(
        _ communities: [CommunitySummary],
        serverId: String
    ) -> [CommunitySummary] {
        communities.map { one in
            guard one.id == serverId, !one.joined else { return one }
            var updated = one
            updated.joined = true
            updated.memberCount += 1
            return updated
        }
    }

    /// A stable hue for a community, so a list is scannable before any of it is
    /// read. Derived from the id exactly the way `Avatar.hue` derives a person's,
    /// so a community's tint does not move between loads or devices.
    static func hue(_ id: String) -> Double { Avatar.hue(seed: id) }
}

// MARK: - Depoimentos

/// One depoimento, as anybody may read it.
///
/// The AUTHOR travels with it and the subject does not: every read is already
/// scoped to one subject. `approvedAt` is null exactly when the thing is
/// pending, which makes it the one field a client has to look at to know whether
/// it is looking at something private — there is no `status` string to disagree
/// with it.
struct Depoimento: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let author: PublicUser
    let body: String
    let createdAt: Date
    let approvedAt: Date?

    enum CodingKeys: String, CodingKey { case id, author, body, createdAt, approvedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        author = try c.decode(PublicUser.self, forKey: .author)
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        approvedAt = (try? c.decodeIfPresent(Date.self, forKey: .approvedAt)) ?? nil
    }

    init(id: String, author: PublicUser, body: String, createdAt: Date, approvedAt: Date?) {
        self.id = id
        self.author = author
        self.body = body
        self.createdAt = createdAt
        self.approvedAt = approvedAt
    }
}

struct DepoimentoList: Decodable, Sendable {
    var depoimentos: [Depoimento] = []

    enum CodingKeys: String, CodingKey { case depoimentos }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        depoimentos = try c.decodeIfPresent([Depoimento].self, forKey: .depoimentos) ?? []
    }

    init(depoimentos: [Depoimento] = []) { self.depoimentos = depoimentos }
}

/// A community chip on somebody's profile: an icon and a name, nothing more.
struct ProfileCommunity: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
}

struct ProfileCommunityList: Decodable, Sendable, Hashable {
    var communities: [ProfileCommunity] = []
    /// Includes the ones past the cap, so "+N" needs no second request.
    var total: Int = 0

    enum CodingKeys: String, CodingKey { case communities, total }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        communities = try c.decodeIfPresent([ProfileCommunity].self, forKey: .communities) ?? []
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? communities.count
    }

    init(communities: [ProfileCommunity] = [], total: Int = 0) {
        self.communities = communities
        self.total = total
    }
}

/// Whether a depoimento is waiting on its subject or is already on their card.
///
/// Derived from `approvedAt` and from nothing else, so this client cannot end up
/// drawing a "published" row for something the server still considers private.
enum DepoimentoState: String, Sendable, Hashable {
    case pending
    case published
}

/// The depoimento feature's pure logic, ported from `depoimentos-model.ts`.
///
/// Every rule here has a counterpart on the server, and the duplication is on
/// purpose: this copy decides what to DRAW, the server's decides what is
/// ALLOWED, and drawing an affordance the server would refuse is a worse bug
/// than hiding one it would allow.
enum Depoimentos {
    /// 500 characters — `DEPOIMENTO_MAX_LENGTH`.
    static let maxLength = 500
    /// `PROFILE_COMMUNITY_LIMIT`: six chips before the rest collapse into "+N".
    static let communityLimit = 6

    static func state(_ depoimento: Depoimento) -> DepoimentoState {
        depoimento.approvedAt == nil ? .pending : .published
    }

    /// May the viewer write one about this person?
    ///
    /// Friends only, and never yourself — the same gate `areFriendsSql`
    /// enforces. Half a handshake is deliberately not enough: offering the
    /// composer to somebody whose request has not been answered earns them a 403
    /// they cannot explain.
    static func canWrite(_ state: FriendshipState) -> Bool {
        state == .friends
    }

    /// Characters left, signed — negative once they have run over, so a counter
    /// can turn red before the request does. Counts the TRIMMED length because
    /// the server trims before measuring.
    static func remaining(_ body: String) -> Int {
        maxLength - body.trimmingCharacters(in: .whitespacesAndNewlines).count
    }

    static func canSubmit(_ body: String) -> Bool {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= maxLength
    }

    /// What the "+N" chip says, or nil when nothing is hidden. Derived rather
    /// than sent, so the two numbers cannot disagree.
    static func communityOverflow(_ list: ProfileCommunityList) -> Int? {
        let hidden = list.total - list.communities.count
        return hidden > 0 ? hidden : nil
    }

    /// The month-and-year line under a depoimento.
    ///
    /// Month precision, deliberately: "julho de 2026" is what a testimonial
    /// wants to say, and an exact timestamp turns a keepsake into a log entry —
    /// as well as publishing a small fact about when two people were talking
    /// that nobody asked for. The published date when there is one, because that
    /// is the order a profile is in.
    static func stamp(_ depoimento: Depoimento) -> Date {
        depoimento.approvedAt ?? depoimento.createdAt
    }

    /// Everything waiting on the viewer, as one number for one badge.
    ///
    /// Friend requests and pending depoimentos are counted TOGETHER, unlike
    /// unread messages: the badge promises "somebody is waiting for you to answer
    /// something", and both are answered from the same screen with the same two
    /// buttons. Somebody who taps it and finds a depoimento rather than a friend
    /// request has not been misled.
    static func waitingOnYou(friendRequests: Int, pendingDepoimentos: Int) -> Int {
        friendRequests + pendingDepoimentos
    }
}

// MARK: - Handles

/// Why a handle cannot be claimed, or nil when it can.
///
/// A discriminated reason rather than a message, mirroring `HandleRejection` —
/// one enum, and the wording lives at the one place that renders it.
///
/// `taken` is deliberately absent: it is not a property of the string, it is a
/// property of the database at one instant, and only the unique index can say
/// it. The server's sentence is what gets shown for that.
enum HandleRejection: String, Sendable, Hashable {
    case length
    case format
    case reserved
    case blocked
}

/// The handle rules, mirrored from `packages/shared/src/profiles.ts` so the
/// claim field can refuse a name before spending a round trip on it.
///
/// A MIRROR, NOT AN AUTHORITY. The server re-runs every one of these; what this
/// buys is a field that says "that one is reserved" the moment you stop typing
/// rather than after a request, and — for the blocklist in particular — a
/// refusal that never has to travel.
enum HandleRules {
    static let minLength = 3
    static let maxLength = 20
    /// One rename per 30 days. Not a punishment — the anti-squatting rule.
    static let renameCooldownDays = 30

    /// `HANDLE_PATTERN`, and the same expression the database's CHECK carries.
    static let pattern = "^[a-z0-9][a-z0-9_.-]{1,18}[a-z0-9]$"

    /// Names the product needs for itself, plus the ones a stranger holding them
    /// could impersonate something with. The authority group (`suporte`,
    /// `oficial`, `pqp`) is the one worth being generous with: "pqp.gg/@suporte
    /// pediu sua senha" is a working attack that costs one free signup.
    static let reserved: Set<String> = [
        "app", "api", "about", "sobre", "ajuda", "help", "blog", "claim",
        "garanta", "cookies", "docs", "doc", "download", "downloads", "faq",
        "home", "index", "invite", "convite", "legal", "login", "entrar",
        "logout", "sair", "me", "meu", "privacy", "privacidade", "settings",
        "config", "configuracoes", "signin", "signup", "cadastro", "sistema",
        "system", "billing", "pagamento", "pix", "abuse", "denuncia", "report",
        "dmca", "contato", "contact", "imprensa", "press", "jobs", "vagas",
        "team", "dev", "test", "teste", "demo",
        // infrastructure
        "www", "cdn", "mail", "ws", "static", "assets", "img", "media", "status",
        // authority
        "suporte", "support", "admin", "oficial", "official", "moderacao",
        "seguranca", "security", "pqp", "staff", "root",
    ]

    /// Substring-matched: terms with essentially no innocent use. Padding is the
    /// first thing anybody tries, so these have to match anywhere.
    private static let blockedSubstrings: [String] = [
        "nigger", "nigga", "faggot", "viado", "traveco", "sapatao",
        "mongoloide", "retardado", "nazista", "heilhitler", "pedofil",
        "pedophil", "estupr",
    ]

    /// Exact-matched: words that are a slur when they ARE the handle and an
    /// ordinary word inside one. `macacos_fc` is a supporters' club.
    private static let blockedExact: Set<String> = [
        "macaco", "macacos", "crioulo", "negrinho", "bicha", "nazi", "hitler",
        "retard", "rape",
    ]

    /// Leet and separator folding, for blocklist matching ONLY. Never used for
    /// storage or comparison: `r4fa` and `rafa` are two different people and must
    /// stay two different rows.
    static func fold(_ handle: String) -> String {
        var folded = ""
        folded.reserveCapacity(handle.count)
        for character in handle {
            switch character {
            case ".", "_", "-": continue
            case "0": folded.append("o")
            case "1": folded.append("i")
            case "3": folded.append("e")
            case "4": folded.append("a")
            case "5": folded.append("s")
            case "7": folded.append("t")
            case "@": folded.append("a")
            case "$": folded.append("s")
            default: folded.append(character)
            }
        }
        return folded
    }

    /// What somebody typed, as the handle it would become.
    ///
    /// Strips a leading `@` (people type the thing they saw on the page),
    /// lowercases, folds the accents a Brazilian keyboard produces by reflex
    /// (`joão` → `joao`), and turns whitespace into `_`. Everything the character
    /// set cannot hold is DROPPED rather than rejected — this runs on every
    /// keystroke, and a field that erases what you typed because you reached for
    /// `ç` is a field people leave.
    ///
    /// Idempotent: `normalize(normalize(x)) == normalize(x)`.
    static func normalize(_ raw: String) -> String {
        var working = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while working.hasPrefix("@") { working.removeFirst() }
        working = working.lowercased()

        // NFD, then drop the combining marks it split off — the step that turns
        // `ã` into `a`. Done explicitly rather than through
        // `.diacriticInsensitive` folding, which is locale-sensitive and would
        // make the same string normalise differently on two phones.
        var scalars = String.UnicodeScalarView()
        for scalar in working.decomposedStringWithCanonicalMapping.unicodeScalars {
            if (0x0300...0x036F).contains(scalar.value) { continue }
            scalars.append(scalar)
        }

        var out = ""
        out.reserveCapacity(scalars.count)
        for scalar in scalars {
            let character = Character(scalar)
            if character.isWhitespace {
                out.append("_")
            } else if character.isASCII,
                      character.isLetter || character.isNumber
                        || character == "_" || character == "." || character == "-" {
                out.append(character)
            }
        }
        return String(out.prefix(maxLength))
    }

    /// Why an already-normalised candidate cannot be claimed, or nil.
    static func validate(_ candidate: String) -> HandleRejection? {
        if candidate.count < minLength || candidate.count > maxLength {
            return .length
        }
        if candidate.range(of: pattern, options: .regularExpression) == nil {
            return .format
        }
        if reserved.contains(candidate) {
            return .reserved
        }
        let folded = fold(candidate)
        if blockedSubstrings.contains(where: { folded.contains($0) }) {
            return .blocked
        }
        if blockedExact.contains(folded) {
            return .blocked
        }
        return nil
    }

    static func isValid(_ candidate: String) -> Bool { validate(candidate) == nil }

    /// When the account may next change its handle. Nil means "now" — either it
    /// has never claimed one, or the cooldown has run out. The FIRST claim is
    /// free; the cooldown only applies to moving one you already hold.
    static func renameAvailableAt(changedAt: Date?, currentHandle: String?) -> Date? {
        guard let changedAt, let currentHandle, !currentHandle.isEmpty else { return nil }
        return changedAt.addingTimeInterval(Double(renameCooldownDays) * 24 * 3600)
    }

    static func canRename(
        changedAt: Date?,
        currentHandle: String?,
        now: Date = Date()
    ) -> Bool {
        guard let available = renameAvailableAt(changedAt: changedAt, currentHandle: currentHandle)
        else { return true }
        return available <= now
    }

    /// `pqp.gg/@rafa` — the display form, which is what fits on a button. One
    /// definition, so the `@` cannot drift.
    static func displayUrl(_ handle: String) -> String { "pqp.gg/@\(handle)" }

    /// What actually goes on the clipboard and into a share sheet.
    static func shareUrl(_ handle: String) -> URL? {
        URL(string: "https://pqp.gg/@\(handle)")
    }

    /// The wording for a refusal. Kept here rather than at the field so the two
    /// places that can refuse — this mirror and a future one — cannot word the
    /// same rejection differently.
    static func message(for rejection: HandleRejection) -> String {
        switch rejection {
        case .length:
            String(localized: "Between 3 and 20 characters.")
        case .format:
            String(localized: "Letters, numbers, dots, dashes and underscores, starting and ending with a letter or number.")
        case .reserved:
            String(localized: "That one is reserved.")
        case .blocked:
            String(localized: "That handle cannot be used.")
        }
    }
}
