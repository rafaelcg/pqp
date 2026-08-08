import XCTest
@testable import pqp

/// The communities wave's pure rules.
///
/// WHAT IS WORTH ASSERTING HERE is the same thing the web's model tests assert:
/// the decisions a person can get wrong by reading the code and agreeing with
/// it. The category table's totality (a slug with no glyph is a compile error
/// there and would be a blank chip here), the handle mirror agreeing with the
/// server's regex and lists, and the one field that decides whether something
/// private is drawn as public.
final class CommunityCategoryTests: XCTestCase {
    /// The slugs, in `COMMUNITY_CATEGORIES` order.
    ///
    /// ORDER IS ASSERTED, not just membership. The chip row is built from
    /// `allCases`, the web builds its row from the shared constant, and the two
    /// products are supposed to be one — a reordering here would silently give
    /// the phone a different directory from the browser.
    func testSlugsMatchTheSharedConstantExactly() {
        XCTAssertEqual(
            CommunityCategory.allCases.map(\.rawValue),
            [
                "games", "musica", "futebol", "estudos", "anime", "tech",
                "humor", "series-filmes", "corre", "geral",
            ]
        )
    }

    /// Totality: every slug has a glyph and a label, and no two share a glyph.
    ///
    /// The web gets this from a `Record<CommunityCategory, string>` the type
    /// checker refuses to leave incomplete. Swift's exhaustive `switch` gives the
    /// same guarantee for *existence*; what it cannot catch is an empty string or
    /// a copy-pasted duplicate, which is what this covers.
    func testEveryCategoryHasItsOwnGlyphAndALabel() {
        var glyphs = Set<String>()
        for category in CommunityCategory.allCases {
            XCTAssertFalse(category.emoji.isEmpty, "\(category.rawValue) has no glyph")
            XCTAssertFalse(category.label.isEmpty, "\(category.rawValue) has no label")
            XCTAssertTrue(
                glyphs.insert(category.emoji).inserted,
                "\(category.rawValue) reuses \(category.emoji)"
            )
        }
        XCTAssertEqual(glyphs.count, 10)
    }

    /// A slug this build has never heard of lands on the catch-all rather than
    /// dropping the card. `geral` is the escape hatch by design on the server
    /// too, which is what makes it the honest place to land.
    func testAnUnknownSlugFallsBackToTheCatchAll() {
        XCTAssertEqual(CommunityCategory.lenient("games"), .games)
        XCTAssertEqual(CommunityCategory.lenient("series-filmes"), .seriesFilmes)
        XCTAssertEqual(CommunityCategory.lenient("cozinha"), .geral)
        XCTAssertEqual(CommunityCategory.lenient(nil), .geral)
        XCTAssertEqual(CommunityCategory.lenient(""), .geral)
    }

    /// The chip row is "all" plus every category, in order, with the sweep chip
    /// first and no filter attached to it.
    func testChipRowIsTheSweepChipThenEveryCategory() {
        let chips = CommunityFilter.chips
        XCTAssertEqual(chips.count, 11)
        XCTAssertEqual(chips.first, .all)
        XCTAssertNil(chips.first?.slug)
        XCTAssertEqual(chips.dropFirst().map(\.id), CommunityCategory.allCases.map(\.rawValue))
        XCTAssertEqual(chips.last?.slug, "geral")
    }
}

final class CommunityDirectoryTests: XCTestCase {
    private func summary(
        _ id: String, name: String = "Room", members: Int = 5, joined: Bool = false
    ) -> CommunitySummary {
        CommunitySummary(id: id, name: name, memberCount: members, joined: joined)
    }

    func testCardActionFollowsTheServersJoinedFlag() {
        XCTAssertEqual(CommunityDirectory.cardAction(summary("a", joined: false)), .join)
        XCTAssertEqual(CommunityDirectory.cardAction(summary("a", joined: true)), .open)
    }

    /// Two words, two initials — and an emoji-led name must not be sliced in
    /// half, which is exactly what indexing UTF-16 would do to a surrogate pair.
    func testMonogramTakesTheFirstTwoWordsAndSurvivesEmoji() {
        XCTAssertEqual(CommunityDirectory.monogram("Eu odeio acordar cedo"), "EO")
        XCTAssertEqual(CommunityDirectory.monogram("valorant"), "V")
        XCTAssertEqual(CommunityDirectory.monogram("  "), "?")
        XCTAssertEqual(CommunityDirectory.monogram("🎮 gamers"), "🎮G")
    }

    /// Compact, and in the reader's language. `1,2 mil` is what a Brazilian
    /// reads; a hand-rolled `1.2K` is wrong in both the separator and the word.
    func testMemberCountIsCompactAndLocaleCorrect() {
        let brazil = Locale(identifier: "pt_BR")
        // Nothing under a thousand is abbreviated in any locale, so the common
        // case reads as the exact number it is.
        XCTAssertEqual(CommunityDirectory.memberCount(7, locale: brazil), "7")
        XCTAssertEqual(CommunityDirectory.memberCount(842, locale: brazil), "842")

        let twelveHundred = CommunityDirectory.memberCount(1200, locale: brazil)
        XCTAssertTrue(twelveHundred.contains("mil"), twelveHundred)
        XCTAssertTrue(twelveHundred.contains(","), twelveHundred)
        XCTAssertFalse(twelveHundred.contains("K"), twelveHundred)

        let english = CommunityDirectory.memberCount(1200, locale: Locale(identifier: "en_US"))
        XCTAssertEqual(english, "1.2K")
    }

    /// The order key is `member_count` and it moves under the reader, so an
    /// offset-paginated second page can repeat a row. Deduped, last write wins,
    /// server order preserved.
    func testMergeDedupesAndKeepsTheFresherCopyInPlace() {
        let first = [summary("a", members: 10), summary("b", members: 9)]
        let second = [summary("b", members: 11, joined: true), summary("c", members: 8)]

        let merged = CommunityDirectory.merge(first, second)

        XCTAssertEqual(merged.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(merged[1].memberCount, 11)
        XCTAssertTrue(merged[1].joined)
    }

    /// Joining flips the card and bumps the count locally, so the button and the
    /// number do not disagree while the next real load is in flight. Idempotent:
    /// a second application must not count the same person twice.
    func testApplyJoinFlipsOnlyTheOneCardAndOnlyOnce() {
        let list = [summary("a", members: 4), summary("b", members: 9)]

        let once = CommunityDirectory.applyJoin(list, serverId: "a")
        XCTAssertTrue(once[0].joined)
        XCTAssertEqual(once[0].memberCount, 5)
        XCTAssertFalse(once[1].joined)
        XCTAssertEqual(once[1].memberCount, 9)

        let twice = CommunityDirectory.applyJoin(once, serverId: "a")
        XCTAssertEqual(twice[0].memberCount, 5)
    }

    /// The tint has to be the same on every load and every device, or a list you
    /// learned to scan reshuffles its colours behind you.
    func testHueIsStableForAnId() {
        XCTAssertEqual(CommunityDirectory.hue("abc"), CommunityDirectory.hue("abc"))
        XCTAssertNotEqual(CommunityDirectory.hue("abc"), CommunityDirectory.hue("abd"))
    }
}

// MARK: - Wire leniency

final class CommunityWireTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try Coding.decoder.decode(T.self, from: Data(json.utf8))
    }

    /// A payload carrying a category this build has never seen, a field it does
    /// not model, and no images at all still produces a card.
    ///
    /// This is the rule the whole file exists for: an unreadable new field must
    /// never drop a payload.
    func testAnUnknownCategoryAndAnUnknownFieldStillDecode() throws {
        let page = try decode(CommunityPage.self, """
        {
          "communities": [{
            "id": "11111111-1111-1111-1111-111111111111",
            "name": "Cozinha",
            "tagline": null,
            "category": "gastronomia",
            "memberCount": 3,
            "joined": false,
            "createdAt": "2026-07-01T10:00:00.000Z",
            "somethingNewNextMonth": {"nested": true}
          }],
          "hasMore": true
        }
        """)

        XCTAssertEqual(page.communities.count, 1)
        XCTAssertEqual(page.communities[0].category, .geral)
        XCTAssertNil(page.communities[0].iconUrl)
        XCTAssertTrue(page.hasMore)
    }

    /// A server payload from a deployment that predates communities: no
    /// `isCommunity`, no `showOnProfile`, no pictures. It has to keep appearing
    /// in the rail rather than failing the whole `/api/servers` decode.
    func testAServerFromBeforeCommunitiesStillDecodes() throws {
        let server = try decode(Server.self, """
        {
          "id": "22222222-2222-2222-2222-222222222222",
          "name": "Old room",
          "ownerId": "33333333-3333-3333-3333-333333333333",
          "createdAt": "2026-01-01T00:00:00.000Z",
          "messageRetentionDays": null,
          "ssoEmailDomain": null
        }
        """)

        XCTAssertFalse(server.isCommunity)
        // TRUE by default, matching the column: the opt-out is an opt-OUT, and a
        // client that defaulted it false would hide chips the server is showing.
        XCTAssertTrue(server.showOnProfile)
        XCTAssertNil(server.iconUrl)
        XCTAssertNil(server.bannerUrl)
    }

    func testAServerCarriesItsPicturesAndListing() throws {
        let server = try decode(Server.self, """
        {
          "id": "22222222-2222-2222-2222-222222222222",
          "name": "Valorant BR",
          "ownerId": "33333333-3333-3333-3333-333333333333",
          "role": "member",
          "createdAt": "2026-01-01T00:00:00.000Z",
          "messageRetentionDays": null,
          "ssoEmailDomain": null,
          "iconUrl": "/api/servers/22222222-2222-2222-2222-222222222222/icon?v=abcd1234",
          "bannerUrl": "/api/servers/22222222-2222-2222-2222-222222222222/banner?v=abcd1234",
          "isCommunity": true,
          "showOnProfile": false
        }
        """)

        XCTAssertTrue(server.isCommunity)
        XCTAssertFalse(server.showOnProfile)
        // Root-relative, and completed against the API base by the same resolver
        // an avatar goes through.
        XCTAssertNotNil(Avatar.resolve(server.iconUrl))
    }
}

// MARK: - Depoimentos

final class DepoimentoTests: XCTestCase {
    private func depoimento(approved: Date?) -> Depoimento {
        Depoimento(
            id: "d1",
            author: PublicUser(
                id: "u1", displayName: "Bea", username: "bea",
                tag: "bea#0192", avatarUrl: nil
            ),
            body: "conheci essa mulher jogando valorant às 3 da manhã",
            createdAt: Date(timeIntervalSince1970: 1_780_000_000),
            approvedAt: approved
        )
    }

    /// `approvedAt` is the ONE field that says whether something is private.
    /// There is no status string to disagree with it, and this is what stops a
    /// pending depoimento from ever being drawn as published.
    func testStateComesOnlyFromApprovedAt() {
        XCTAssertEqual(Depoimentos.state(depoimento(approved: nil)), .pending)
        XCTAssertEqual(
            Depoimentos.state(depoimento(approved: Date(timeIntervalSince1970: 1_780_100_000))),
            .published
        )
    }

    /// A pending one is stamped with when it was written; a published one with
    /// when it went up — which is the order a profile is in, so it has to be the
    /// date shown.
    func testStampPrefersThePublishedDate() {
        let published = Date(timeIntervalSince1970: 1_780_100_000)
        XCTAssertEqual(Depoimentos.stamp(depoimento(approved: published)), published)
        XCTAssertEqual(
            Depoimentos.stamp(depoimento(approved: nil)),
            Date(timeIntervalSince1970: 1_780_000_000)
        )
    }

    /// Friends only. Half a handshake is deliberately not enough — offering the
    /// composer to somebody mid-request earns them a 403 they cannot explain.
    func testOnlyFriendsMayWriteOne() {
        XCTAssertTrue(Depoimentos.canWrite(.friends))
        for state in [FriendshipState.isSelf, .blocked, .pendingIncoming, .pendingOutgoing, .none] {
            XCTAssertFalse(Depoimentos.canWrite(state), "\(state) should not be offered the composer")
        }
    }

    /// The counter counts the TRIMMED length, because the server trims before
    /// measuring — counting trailing whitespace would show 0 remaining while the
    /// server happily accepted it.
    func testRemainingCountsTheTrimmedLength() {
        XCTAssertEqual(Depoimentos.remaining(""), 500)
        XCTAssertEqual(Depoimentos.remaining("   oi   "), 498)
        XCTAssertEqual(Depoimentos.remaining(String(repeating: "a", count: 501)), -1)
    }

    func testSubmitNeedsSomethingWrittenAndNothingOver() {
        XCTAssertFalse(Depoimentos.canSubmit("   "))
        XCTAssertTrue(Depoimentos.canSubmit("oi"))
        XCTAssertTrue(Depoimentos.canSubmit(String(repeating: "a", count: 500)))
        XCTAssertFalse(Depoimentos.canSubmit(String(repeating: "a", count: 501)))
    }

    /// "+N" is derived from the gap between the capped array and the real total,
    /// so the two numbers cannot disagree.
    func testCommunityOverflowIsTheGapOrNothing() {
        let rooms = (0..<6).map { ProfileCommunity(id: "c\($0)", name: "Room \($0)") }
        XCTAssertNil(Depoimentos.communityOverflow(
            ProfileCommunityList(communities: rooms, total: 6)
        ))
        XCTAssertEqual(
            Depoimentos.communityOverflow(ProfileCommunityList(communities: rooms, total: 11)),
            5
        )
        XCTAssertNil(Depoimentos.communityOverflow(ProfileCommunityList()))
    }

    /// One badge, one promise: somebody is waiting for you to answer something.
    /// Both are answered from the same tab with the same two buttons.
    func testWaitingOnYouAddsBothQueues() {
        XCTAssertEqual(
            Depoimentos.waitingOnYou(friendRequests: 2, pendingDepoimentos: 3), 5
        )
        XCTAssertEqual(
            Depoimentos.waitingOnYou(friendRequests: 0, pendingDepoimentos: 0), 0
        )
    }

    /// A pending depoimento carries an explicit `null` for `approvedAt`, and a
    /// payload with a field this build does not model still decodes.
    func testPendingPayloadDecodes() throws {
        let list = try Coding.decoder.decode(DepoimentoList.self, from: Data("""
        {"depoimentos": [{
          "id": "44444444-4444-4444-4444-444444444444",
          "author": {
            "id": "55555555-5555-5555-5555-555555555555",
            "displayName": "Bea", "username": "bea",
            "tag": "bea#0192", "avatarUrl": null
          },
          "body": "oi",
          "createdAt": "2026-07-01T10:00:00.000Z",
          "approvedAt": null,
          "reactionsSomeday": []
        }]}
        """.utf8))

        XCTAssertEqual(list.depoimentos.count, 1)
        XCTAssertEqual(Depoimentos.state(list.depoimentos[0]), .pending)
    }
}

// MARK: - Handles

/// The mirror of `packages/shared/src/profiles.ts`.
///
/// These are the cases where a client that disagreed with the server would be
/// actively harmful: refusing a name the server would have taken, or promising
/// one it will not.
final class HandleRulesTests: XCTestCase {
    func testNormalizeMatchesTheSharedTransform() {
        XCTAssertEqual(HandleRules.normalize("  @Rafa "), "rafa")
        XCTAssertEqual(HandleRules.normalize("João"), "joao")
        XCTAssertEqual(HandleRules.normalize("Rafa Guglielmi"), "rafa_guglielmi")
        XCTAssertEqual(HandleRules.normalize("ação!!"), "acao")
        XCTAssertEqual(HandleRules.normalize("@@@bea"), "bea")
        XCTAssertEqual(HandleRules.normalize(String(repeating: "a", count: 40)).count, 20)
    }

    /// Stated in the shared file as a property, so it is asserted as one: a
    /// field that normalises on every keystroke must not creep.
    func testNormalizeIsIdempotent() {
        for raw in ["@Rafa", "João da Silva", "  ç  ", "a.b-c_d", "ÀÉÎÕÜ"] {
            let once = HandleRules.normalize(raw)
            XCTAssertEqual(HandleRules.normalize(once), once, raw)
        }
    }

    func testLengthIsThreeToTwenty() {
        XCTAssertEqual(HandleRules.validate("ab"), .length)
        XCTAssertNil(HandleRules.validate("abc"))
        XCTAssertNil(HandleRules.validate(String(repeating: "a", count: 20)))
        XCTAssertEqual(HandleRules.validate(String(repeating: "a", count: 21)), .length)
    }

    /// The pattern's whole job: a handle can never read as punctuation. `.rafa`
    /// is a hidden-file convention in half the tools that will touch this string.
    func testFirstAndLastCharactersMustBeAlphanumeric() {
        XCTAssertEqual(HandleRules.validate(".rafa"), .format)
        XCTAssertEqual(HandleRules.validate("rafa-"), .format)
        XCTAssertEqual(HandleRules.validate("--a--"), .format)
        XCTAssertNil(HandleRules.validate("ra.fa-1_2"))
    }

    func testReservedWordsAreRefused() {
        XCTAssertEqual(HandleRules.validate("suporte"), .reserved)
        XCTAssertEqual(HandleRules.validate("admin"), .reserved)
        XCTAssertEqual(HandleRules.validate("privacidade"), .reserved)
        XCTAssertNil(HandleRules.validate("suportev2"))
    }

    /// Padding a slur with digits and dots must not walk it past the list; a
    /// Brazilian's actual nickname must not be caught by it. `kkk` is laughter,
    /// not a klan, and this audience writes it constantly.
    func testBlocklistFoldsLeetButLeavesOrdinaryWordsAlone() {
        XCTAssertEqual(HandleRules.validate("v.i.a.d.o"), .blocked)
        XCTAssertEqual(HandleRules.validate("n1gg3r_br"), .blocked)
        XCTAssertEqual(HandleRules.validate("macaco"), .blocked)
        // Exact-matched, so a supporters' club and a cat are both fine.
        XCTAssertNil(HandleRules.validate("macacos_fc"))
        XCTAssertNil(HandleRules.validate("kkkkkk"))
        XCTAssertNil(HandleRules.validate("bichano"))
        // pqp is named after an expletive; what is refused is hate, not vulgarity.
        XCTAssertNil(HandleRules.validate("caralho"))
    }

    /// Every rejection has a sentence. A refusal the field cannot word is a
    /// field that silently disables its own button.
    func testEveryRejectionHasWording() {
        for rejection in [HandleRejection.length, .format, .reserved, .blocked] {
            XCTAssertFalse(HandleRules.message(for: rejection).isEmpty, rejection.rawValue)
        }
    }

    /// The FIRST claim is free — the cooldown only applies to moving one you
    /// already hold. Getting this backwards would wall new accounts out of the
    /// feature entirely.
    func testFirstClaimIsFreeAndTheCooldownIsThirtyDays() {
        XCTAssertTrue(HandleRules.canRename(changedAt: nil, currentHandle: nil))
        XCTAssertTrue(HandleRules.canRename(changedAt: Date(), currentHandle: nil))
        XCTAssertNil(HandleRules.renameAvailableAt(changedAt: Date(), currentHandle: nil))

        let claimed = Date(timeIntervalSince1970: 1_780_000_000)
        let available = HandleRules.renameAvailableAt(changedAt: claimed, currentHandle: "rafa")
        XCTAssertEqual(available, claimed.addingTimeInterval(30 * 24 * 3600))

        XCTAssertFalse(HandleRules.canRename(
            changedAt: claimed, currentHandle: "rafa",
            now: claimed.addingTimeInterval(29 * 24 * 3600)
        ))
        XCTAssertTrue(HandleRules.canRename(
            changedAt: claimed, currentHandle: "rafa",
            now: claimed.addingTimeInterval(31 * 24 * 3600)
        ))
    }

    /// One definition of the URL, so the `@` cannot drift between the label, the
    /// clipboard and the share sheet.
    func testTheDisplayFormAndTheShareUrlAgree() {
        XCTAssertEqual(HandleRules.displayUrl("rafa"), "pqp.gg/@rafa")
        XCTAssertEqual(
            HandleRules.shareUrl("rafa")?.absoluteString, "https://pqp.gg/@rafa"
        )
    }
}
