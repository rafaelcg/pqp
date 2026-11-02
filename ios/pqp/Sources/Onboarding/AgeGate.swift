import Foundation

/// The decisions of the age gate that are not drawing: what Continue does,
/// what a refusal from `POST /api/me/age-check` means, and how a date is said
/// back. Kept apart from `AgeStep` so they are pinned without a simulator.
///
/// The web gate (`client/src/components/user/age-gate-dialog.tsx`) is the
/// reference, and Android's `onboarding/AgeGate.kt` is the same file in Kotlin.
enum AgeGate {
    /// Where an account blocked by mistake writes, from the account's own
    /// email address.
    static let appealEmail = "contato@pqp.gg"

    /// The Terms page, where the appeal and the account deletion are explained.
    static let termsURL = URL(string: "https://pqp.gg/terms")!

    /// The server's stable `code` on a 400 for a real date nobody answering
    /// this could have (a birth under the plausibility floor).
    static let implausibleCode = "birth_date_implausible"

    // MARK: - The read-back flag

    /// Whether the gate says the date back in words before sending it, from
    /// `ageGateReadback` on `GET /api/me` (the `age_gate_readback` kill switch,
    /// which the server serves only while the gate is pending).
    ///
    /// ABSENT READS AS OFF, which is what the web does (`me.ageGateReadback ===
    /// true` in `client/src/App.tsx`) and what `packages/shared/src/api.ts`
    /// documents: an API that predates the flag keeps the direct submit it
    /// always had. The server always sends it while the gate is pending, so
    /// absent only ever means an old server.
    static func readbackEnabled(_ served: Bool?) -> Bool { served == true }

    // MARK: - Reading the fields

    /// `YYYY-MM-DD` for what is typed, or nil when it is not a real calendar
    /// date. Strict: 31 February is nil, never quietly 3 March, because the
    /// read-back would then confirm a day the person never typed. `month` is 1
    /// to 12, 0 meaning none chosen.
    static func isoDate(day: String, month: Int, year: String, now: Date = Date()) -> String? {
        guard let dayValue = Int(day), let yearValue = Int(year),
              (1...12).contains(month), (1...31).contains(dayValue),
              (1900...gregorian.component(.year, from: now)).contains(yearValue)
        else { return nil }
        guard calendarDate(year: yearValue, month: month, day: dayValue) != nil else { return nil }
        return String(format: "%04d-%02d-%02d", yearValue, month, dayValue)
    }

    /// A calendar fact has no zone: every calendar and formatter here is pinned
    /// to UTC, so the same three numbers read back as the same day on a phone
    /// in any time zone. No clock is read to say a date.
    private static let gregorian: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    /// The day at noon UTC, or nil when the three numbers are not a real day.
    /// `Calendar.date(from:)` is lenient (31 February comes back as 3 March), so
    /// the result is read back into components and must match what went in.
    private static func calendarDate(year: Int, month: Int, day: Int) -> Date? {
        var parts = DateComponents()
        parts.year = year
        parts.month = month
        parts.day = day
        parts.hour = 12
        guard let date = gregorian.date(from: parts) else { return nil }
        let back = gregorian.dateComponents([.year, .month, .day], from: date)
        return back.year == year && back.month == month && back.day == day ? date : nil
    }

    /// A date of birth spelled out for the read-back ("3 de dezembro de
    /// 2008"), in `locale`'s long date style. Nil when `isoDate` is not a real
    /// calendar date.
    static func inWords(_ isoDate: String, locale: Locale) -> String? {
        let pieces = isoDate.split(separator: "-", omittingEmptySubsequences: false)
        guard pieces.count == 3, pieces[0].count == 4, pieces[1].count == 2, pieces[2].count == 2,
              let year = Int(pieces[0]), let month = Int(pieces[1]), let day = Int(pieces[2])
        else { return nil }
        guard let date = calendarDate(year: year, month: month, day: day) else { return nil }
        let formatter = DateFormatter()
        formatter.calendar = gregorian
        formatter.timeZone = gregorian.timeZone
        formatter.locale = locale
        formatter.dateStyle = .long
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    /// The language the screen is written in, which is not always
    /// `Locale.current` (that is the region format: a phone set to English with
    /// a Brazilian region would say the date in the wrong language beside
    /// Portuguese copy). The app ships `en` and `pt-BR`.
    static var interfaceLocale: Locale {
        Locale(identifier: Bundle.main.preferredLocalizations.first ?? "en")
    }

    // MARK: - What Continue does

    enum ContinueOutcome: Equatable {
        /// Not a date we can read: say so, keep the fields, send nothing.
        case badDate
        /// The switch is off: send it, as the gate always did.
        case submit(isoDate: String)
        /// Say `inWords` back first. Only "Está certo" sends `isoDate`.
        case readBack(isoDate: String, inWords: String)
    }

    static func continueOutcome(
        day: String, month: Int, year: String,
        readback: Bool, locale: Locale, now: Date = Date()
    ) -> ContinueOutcome {
        guard let iso = isoDate(day: day, month: month, year: year, now: now) else { return .badDate }
        if !readback { return .submit(isoDate: iso) }
        guard let words = inWords(iso, locale: locale) else { return .badDate }
        return .readBack(isoDate: iso, inWords: words)
    }

    // MARK: - What the server said

    /// Why `POST /api/me/age-check` did not give a verdict, as the gate has to
    /// react to it.
    enum Failure: Equatable, Sendable {
        /// 400 `birth_date_implausible`: a real date under the plausibility
        /// floor (the year of today, a default, a slip). The attempt is NOT
        /// spent. Back to the fields, values kept, "Check the year", cursor in
        /// the year.
        case checkYear
        /// Any other 400: not a date the server can read. Also not spent: back
        /// to the fields.
        case badDate
        /// 409: this account already answered (another device). Re-read
        /// `/api/me`.
        case stale
        /// Anything else (offline, a 5xx): nothing was decided, try again.
        case save
    }

    /// The two things an answer can be: a verdict (the 200, which carries
    /// `passed` or `blocked`), or a refusal that is not one.
    enum Answer: Equatable, Sendable {
        case verdict(String)
        case failure(Failure)
    }

    /// A 400 is always recoverable input and never the blocked state: blocked
    /// comes only from a 200 whose `ageGate` is `blocked`. Split out of the
    /// API call so the mapping is pinned without a server.
    static func result(status: Int, body: Data) -> Answer {
        struct Verdict: Decodable { let ageGate: String }
        struct Refusal: Decodable { let code: String? }
        switch status {
        case 200..<300:
            guard let verdict = try? JSONDecoder().decode(Verdict.self, from: body) else {
                return .failure(.save)
            }
            return .verdict(verdict.ageGate)
        case 400:
            let code = (try? JSONDecoder().decode(Refusal.self, from: body))?.code
            return .failure(code == implausibleCode ? .checkYear : .badDate)
        case 409:
            return .failure(.stale)
        default:
            return .failure(.save)
        }
    }
}
