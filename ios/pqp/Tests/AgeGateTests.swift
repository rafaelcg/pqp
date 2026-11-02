import XCTest

@testable import pqp

/// The age gate's read-back, plausibility floor and flag, pinned against the
/// web gate (`client/src/components/user/age-gate-dialog.tsx`) and the server
/// (`POST /api/me/age-check`) that PR #1454 changed. The Kotlin twin is
/// `AgeGateTest.kt`.
final class AgeGateTests: XCTestCase {
    private let pt = Locale(identifier: "pt-BR")
    private let en = Locale(identifier: "en")
    private let es = Locale(identifier: "es")

    /// A fixed "now" so the year range never depends on the day the suite runs.
    private let now = Date(timeIntervalSince1970: 1_793_000_000) // 2026-10-26

    // MARK: - Read-back wording

    func testTheDateIsSaidBackInWordsInTheLanguageOfThePerson() {
        XCTAssertEqual(AgeGate.inWords("2008-12-03", locale: pt), "3 de dezembro de 2008")
        XCTAssertEqual(AgeGate.inWords("2008-12-03", locale: en), "December 3, 2008")
        XCTAssertEqual(AgeGate.inWords("2008-12-03", locale: es), "3 de diciembre de 2008")
    }

    func testADayAndAMonthThatCouldBeSwappedReadBackAsWhatWasTyped() {
        // 3 December and 12 March: the slip the read-back exists to catch.
        XCTAssertEqual(AgeGate.inWords("1990-03-12", locale: pt), "12 de março de 1990")
        XCTAssertEqual(AgeGate.inWords("1990-12-03", locale: pt), "3 de dezembro de 1990")
    }

    func testTheWordsDoNotDependOnTheTimeZoneOfThePhone() {
        // A date of birth is a calendar fact: the same three numbers, any zone.
        let original = NSTimeZone.default
        defer { NSTimeZone.default = original }
        for id in ["Pacific/Kiritimati", "America/Sao_Paulo", "Pacific/Pago_Pago"] {
            NSTimeZone.default = TimeZone(identifier: id)!
            XCTAssertEqual(AgeGate.inWords("2008-12-03", locale: pt), "3 de dezembro de 2008", id)
            XCTAssertEqual(AgeGate.inWords("1990-01-01", locale: en), "January 1, 1990", id)
        }
    }

    func testALeapDayIsARealDayOnlyInALeapYear() {
        XCTAssertEqual(AgeGate.inWords("2000-02-29", locale: en), "February 29, 2000")
        XCTAssertNil(AgeGate.inWords("1900-02-29", locale: en))
        XCTAssertNil(AgeGate.isoDate(day: "29", month: 2, year: "2001", now: now))
        XCTAssertEqual(AgeGate.isoDate(day: "29", month: 2, year: "2000", now: now), "2000-02-29")
    }

    // MARK: - Impossible dates are refused locally

    func testSomethingThatIsNotACalendarDateIsNeverSaidBackAsAnotherDay() {
        XCTAssertNil(AgeGate.inWords("2001-02-31", locale: pt))
        XCTAssertNil(AgeGate.inWords("2001-04-31", locale: pt))
        XCTAssertNil(AgeGate.inWords("not a date", locale: pt))
        XCTAssertNil(AgeGate.inWords("", locale: pt))
        XCTAssertNil(AgeGate.inWords("2001-2-3", locale: pt))
    }

    func testAnImpossibleDateIsRefusedWithOrWithoutTheReadback() {
        for readback in [true, false] {
            XCTAssertEqual(
                AgeGate.continueOutcome(day: "31", month: 2, year: "1990", readback: readback, locale: pt, now: now),
                .badDate
            )
            XCTAssertEqual(
                AgeGate.continueOutcome(day: "3", month: 0, year: "1990", readback: readback, locale: pt, now: now),
                .badDate
            )
            XCTAssertEqual(
                AgeGate.continueOutcome(day: "3", month: 12, year: "1899", readback: readback, locale: pt, now: now),
                .badDate
            )
            XCTAssertEqual(
                AgeGate.continueOutcome(day: "0", month: 12, year: "1990", readback: readback, locale: pt, now: now),
                .badDate
            )
        }
    }

    // MARK: - Continue and the flag

    func testWithTheReadbackOnContinueSaysTheDateBackAndSendsNothing() {
        XCTAssertEqual(
            AgeGate.continueOutcome(day: "3", month: 12, year: "2008", readback: true, locale: pt, now: now),
            .readBack(isoDate: "2008-12-03", inWords: "3 de dezembro de 2008")
        )
    }

    func testWithTheReadbackOffContinueSubmitsDirectly() {
        XCTAssertEqual(
            AgeGate.continueOutcome(day: "3", month: 12, year: "2008", readback: false, locale: pt, now: now),
            .submit(isoDate: "2008-12-03")
        )
    }

    func testTheFlagIsOnOnlyWhenTheServerSaysSo() {
        // The web reads `me.ageGateReadback === true`, and the shared schema
        // says absent reads as off: an API that predates the flag submits
        // directly. Android and iOS agree with that.
        XCTAssertTrue(AgeGate.readbackEnabled(true))
        XCTAssertFalse(AgeGate.readbackEnabled(false))
        XCTAssertFalse(AgeGate.readbackEnabled(nil))
    }

    func testMeCarriesTheFlagFromGetApiMeAndItsAbsence() throws {
        func decode(_ extra: String) throws -> CurrentUser {
            let json = #"{"id":"u1","clerkId":"c1","displayName":"Ana","ageGate":"pending"\#(extra)}"#
            return try Coding.decoder.decode(CurrentUser.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try decode(#","ageGateReadback":true"#).ageGateReadback, true)
        XCTAssertEqual(try decode(#","ageGateReadback":false"#).ageGateReadback, false)
        let silent = try decode("")
        XCTAssertNil(silent.ageGateReadback)
        XCTAssertFalse(AgeGate.readbackEnabled(silent.ageGateReadback))
    }

    // MARK: - The floor and the other refusals

    private func body(_ json: String) -> Data { Data(json.utf8) }

    func testTheFloorIsARecoverableInputErrorNeverTheBlockedState() {
        let floor = body(#"{"error":"That date of birth does not look right. Check the year.","code":"birth_date_implausible"}"#)
        XCTAssertEqual(AgeGate.result(status: 400, body: floor), .failure(.checkYear))
    }

    func testAnyOther400IsAlsoADateToFixWithTheAttemptKept() {
        XCTAssertEqual(
            AgeGate.result(status: 400, body: body(#"{"error":"Enter a valid date of birth.","code":"birth_date_invalid"}"#)),
            .failure(.badDate)
        )
        XCTAssertEqual(AgeGate.result(status: 400, body: body(#"{"error":"Bad request"}"#)), .failure(.badDate))
        XCTAssertEqual(AgeGate.result(status: 400, body: Data()), .failure(.badDate))
        XCTAssertEqual(AgeGate.result(status: 400, body: body("<html>")), .failure(.badDate))
    }

    func testA409IsStaleAndEverythingElseIsAFailedSave() {
        XCTAssertEqual(AgeGate.result(status: 409, body: body(#"{"error":"Already answered"}"#)), .failure(.stale))
        for status in [401, 403, 404, 429, 500, 503] {
            XCTAssertEqual(AgeGate.result(status: status, body: Data()), .failure(.save), "\(status)")
        }
    }

    func testOnlyA200CarriesAVerdict() {
        XCTAssertEqual(AgeGate.result(status: 200, body: body(#"{"ageGate":"passed"}"#)), .verdict("passed"))
        XCTAssertEqual(AgeGate.result(status: 200, body: body(#"{"ageGate":"blocked"}"#)), .verdict("blocked"))
        XCTAssertEqual(AgeGate.result(status: 200, body: body("{}")), .failure(.save))
    }

    // MARK: - Through the store

    override func setUp() {
        super.setUp()
        AgeGateStub.reset()
    }

    @MainActor
    private func makeStore() -> SessionStore {
        let provider = AgeGateToken()
        let store = SessionStore(
            authMode: .devBypass,
            tokenProvider: provider,
            api: APIClient(tokenProvider: provider, protocolClasses: [AgeGateStub.self])
        )
        store.seedPhaseForTesting(.ageGate)
        return store
    }

    @MainActor
    func testTheFloorLeavesTheGateOpenAndTheFieldsToFix() async {
        AgeGateStub.answers["POST /api/me/age-check"] = (
            400, #"{"error":"That date of birth does not look right. Check the year.","code":"birth_date_implausible"}"#
        )
        let store = makeStore()
        let failure = await store.submitAgeDeclaration(dateOfBirth: "2026-06-26")
        XCTAssertEqual(failure, .checkYear)
        XCTAssertEqual(store.phase, .ageGate, "a 400 never blocks")
        XCTAssertEqual(AgeGateStub.count("POST /api/me/age-check"), 1)
        XCTAssertEqual(AgeGateStub.count("GET /api/me"), 0)
    }

    @MainActor
    func testAFailedSaveLeavesTheGateOpen() async {
        AgeGateStub.answers["POST /api/me/age-check"] = (503, #"{"error":"Try later"}"#)
        let store = makeStore()
        let failure = await store.submitAgeDeclaration(dateOfBirth: "1990-03-12")
        XCTAssertEqual(failure, .save)
        XCTAssertEqual(store.phase, .ageGate)
    }

    @MainActor
    func testA409ReReadsMeAndRoutesWhatTheServerRecorded() async {
        AgeGateStub.answers["POST /api/me/age-check"] = (409, #"{"error":"Already answered"}"#)
        AgeGateStub.answers["GET /api/me"] = (
            200, #"{"id":"u1","clerkId":"c1","displayName":"Ana","ageGate":"blocked"}"#
        )
        let store = makeStore()
        let failure = await store.submitAgeDeclaration(dateOfBirth: "1990-03-12")
        XCTAssertNil(failure, "routed onward, nothing left for the gate to say")
        XCTAssertEqual(store.phase, .blocked)
        XCTAssertEqual(AgeGateStub.count("GET /api/me"), 1)
    }

    @MainActor
    func testABlockedVerdictIsTheBlockedScreen() async {
        AgeGateStub.answers["POST /api/me/age-check"] = (200, #"{"ageGate":"blocked"}"#)
        let store = makeStore()
        let failure = await store.submitAgeDeclaration(dateOfBirth: "2010-03-12")
        XCTAssertNil(failure)
        XCTAssertEqual(store.phase, .blocked)
    }

    // MARK: - Contract with the server, and the words of the web

    /// `ios/pqp/Tests/AgeGateTests.swift` up to the repository root.
    private static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private static func read(_ path: String) throws -> String {
        try String(contentsOf: repoRoot.appendingPathComponent(path), encoding: .utf8)
    }

    func testTheCodeTheFlagAndTheFieldAreTheOnesTheServerServes() throws {
        let server = try Self.read("server/src/api/index.ts")
        XCTAssertTrue(server.contains("\"\(AgeGate.implausibleCode)\""))
        XCTAssertTrue(server.contains("ageGateReadback: isEnabled(\"age_gate_readback\")"))
        XCTAssertTrue(try Self.read("server/src/lib/flags.ts").contains("age_gate_readback: {"))
        XCTAssertTrue(try Self.read("packages/shared/src/api.ts").contains("ageGateReadback: z.boolean().optional()"))
        // Absent is off on the web, and iOS has to agree.
        XCTAssertTrue(try Self.read("client/src/App.tsx").contains("setAgeGateReadback(me.ageGateReadback === true)"))
    }

    func testTheBlockedScreenNamesTheSameAppealAddressAndTermsPageAsTheWeb() throws {
        XCTAssertEqual(AgeGate.appealEmail, "contato@pqp.gg")
        let dialog = try Self.read("client/src/components/user/age-gate-dialog.tsx")
        XCTAssertTrue(dialog.contains(AgeGate.appealEmail))
        XCTAssertTrue(dialog.contains("/terms"))
        XCTAssertEqual(AgeGate.termsURL.absoluteString, "https://pqp.gg/terms")
    }

    private struct Catalogue: Decodable {
        struct Entry: Decodable {
            struct Localization: Decodable {
                struct Unit: Decodable { let value: String }
                let stringUnit: Unit? // plural entries carry `variations` instead
            }
            let localizations: [String: Localization]?
        }
        let strings: [String: Entry]
    }

    /// The words are the web's, not a paraphrase: the read-back and the blocked
    /// screen are one product on three clients, and the appeal address is the
    /// point of the blocked screen. Each English literal in the view is also a
    /// key of the catalogue, whose pt-BR is the web's pt-BR.
    func testTheStringsAreTheWebsInEachLanguageTheAppHas() throws {
        let catalogue = try JSONDecoder().decode(
            Catalogue.self, from: Data(try Self.read("ios/pqp/Resources/Localizable.xcstrings").utf8)
        )
        let view = try Self.read("ios/pqp/Sources/Onboarding/AgeGateView.swift")

        func web(_ locale: String) throws -> [String: String] {
            let data = Data(try Self.read("client/src/locales/\(locale)/translation.json").utf8)
            return try JSONDecoder().decode([String: String].self, from: data)
        }
        let en = try web("en")
        let pt = try web("pt-BR")

        /// The web keeps `{date}` and `{age}`; Swift interpolation is `%@` and `%lld`.
        func native(_ text: String) -> String {
            text.replacingOccurrences(of: "{date}", with: "%@").replacingOccurrences(of: "{age}", with: "%lld")
        }
        /// `before [link](url) after`, the way the web composes the three keys.
        func linked(_ table: [String: String], _ kind: String, link: String, url: String) -> String {
            let after = table["ageGate.blocked.\(kind).after"]!
            return table["ageGate.blocked.\(kind).before"]! + " [\(link)](\(url))" + (after == "." ? "" : " ") + after
        }

        var expected: [(en: String, pt: String)] = [
            "error.badDate", "error.save", "error.checkYear",
            "readback.title", "readback.born", "readback.check", "readback.confirm",
            "blocked.eyebrow", "blocked.title", "blocked.body", "blocked.wait",
        ].map { (native(en["ageGate.\($0)"]!), native(pt["ageGate.\($0)"]!)) }
        expected.append((
            linked(en, "contact", link: AgeGate.appealEmail, url: "mailto:\(AgeGate.appealEmail)"),
            linked(pt, "contact", link: AgeGate.appealEmail, url: "mailto:\(AgeGate.appealEmail)")
        ))
        expected.append((
            linked(en, "appeal", link: en["ageGate.blocked.appeal.link"]!, url: AgeGate.termsURL.absoluteString),
            linked(pt, "appeal", link: pt["ageGate.blocked.appeal.link"]!, url: AgeGate.termsURL.absoluteString)
        ))

        for (english, portuguese) in expected {
            let entry = try XCTUnwrap(catalogue.strings[english], "no catalogue key: \(english)")
            XCTAssertEqual(entry.localizations?["pt-BR"]?.stringUnit?.value, portuguese, english)
            // The English in the view is the key; a literal that drifted from the
            // web would be English no catalogue entry translates.
            let literal = english.replacingOccurrences(of: "%@", with: "\\(inWords)")
                .replacingOccurrences(of: "%lld", with: "\\(AgeStep.minimumAge)")
            XCTAssertTrue(view.contains(literal), "the view does not say: \(literal)")
        }

        // "Change it" already means "Trocar" elsewhere, so the read-back's edit
        // button has a key of its own with both languages spelled out.
        let edit = try XCTUnwrap(catalogue.strings["ageGate.readback.edit"])
        XCTAssertEqual(edit.localizations?["en"]?.stringUnit?.value, en["ageGate.readback.edit"])
        XCTAssertEqual(edit.localizations?["pt-BR"]?.stringUnit?.value, pt["ageGate.readback.edit"])
        XCTAssertTrue(view.contains("\"ageGate.readback.edit\", defaultValue: \"Change it\""))
    }
}

// MARK: - Doubles

private struct AgeGateToken: TokenProviding {
    func currentToken() async -> String? { "stub-token" }
    func refreshedToken() async -> TokenRefresh { .token("stub-token") }
}

/// Answers by `"METHOD /path"` and counts what was asked. Static because
/// `URLProtocol` is instantiated by the loading system; every test resets it.
private final class AgeGateStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var answers: [String: (status: Int, body: String)] = [:]
    nonisolated(unsafe) private static var counts: [String: Int] = [:]
    private static let lock = NSLock()

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        answers = [:]
        counts = [:]
    }

    static func count(_ route: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return counts[route] ?? 0
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let route = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        Self.lock.lock()
        Self.counts[route, default: 0] += 1
        let answer = Self.answers[route] ?? (404, #"{"error":"not stubbed"}"#)
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!, statusCode: answer.status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
