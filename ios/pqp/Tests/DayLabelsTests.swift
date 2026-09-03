import XCTest
@testable import pqp

/// The day rows, against the rule in `client/src/lib/utils.ts` (`formatDayLabel`).
final class DayLabelsTests: XCTestCase {
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private var saoPaulo: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Sao_Paulo")!
        return calendar
    }

    private let now = ISO8601DateFormatter().date(from: "2026-09-01T15:00:00Z")!
    private func date(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    private func label(_ iso: String, calendar: Calendar? = nil, locale: Locale = Locale(identifier: "en_US")) -> String {
        DayLabels.label(for: date(iso), now: now, calendar: calendar ?? utc, locale: locale)
    }

    func testTodayAndYesterdayAreWords() {
        XCTAssertEqual(label("2026-09-01T10:00:00Z"), "Today")
        XCTAssertEqual(label("2026-08-31T23:59:59Z"), "Yesterday")
    }

    func testInsideTheLastWeekTheWeekdayIsSpelledOut() {
        let english = label("2026-08-29T12:00:00Z")
        XCTAssertTrue(english.hasPrefix("Saturday"), english)
        XCTAssertTrue(english.contains("29"), english)
        XCTAssertFalse(english.contains("2026"), "No year inside the current year: \(english)")

        let portuguese = label("2026-08-29T12:00:00Z", locale: Locale(identifier: "pt_BR"))
        XCTAssertTrue(portuguese.hasPrefix("Sábado"), portuguese)
        XCTAssertTrue(portuguese.contains("29"), portuguese)
    }

    func testAWeekOrMoreAgoIsAShortDateWithoutTheWeekday() {
        let english = label("2026-08-22T12:00:00Z")
        XCTAssertFalse(english.contains("Saturday"), english)
        XCTAssertTrue(english.contains("Aug"), english)
        XCTAssertTrue(english.contains("22"), english)
        XCTAssertFalse(english.contains("2026"), english)
    }

    func testAnotherYearCarriesTheYear() {
        XCTAssertTrue(label("2025-08-22T12:00:00Z").contains("2025"))
        XCTAssertTrue(label("2025-08-22T12:00:00Z", locale: Locale(identifier: "pt_BR")).contains("2025"))
    }

    func testTheDayIsTheReadersDayNotUTCs() {
        // 01:30 UTC on the 1st is still the evening of the 31st in São Paulo.
        XCTAssertEqual(label("2026-09-01T01:30:00Z", calendar: saoPaulo), "Yesterday")
        XCTAssertEqual(label("2026-09-01T01:30:00Z", calendar: utc), "Today")
    }

    func testSameDayIsDecidedInTheReadersZoneAsWell() {
        let lateEvening = date("2026-08-31T23:30:00Z")
        let justAfterMidnight = date("2026-09-01T00:30:00Z")
        XCTAssertFalse(DayLabels.isSameDay(lateEvening, justAfterMidnight, calendar: utc))
        XCTAssertTrue(DayLabels.isSameDay(lateEvening, justAfterMidnight, calendar: saoPaulo))
    }
}
