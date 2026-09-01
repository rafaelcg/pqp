import Foundation

/// The day rows of a transcript, kept the same as the web's `formatDayLabel`
/// in `client/src/lib/utils.ts`.
///
/// The rule there: "Today", "Yesterday", the weekday for anything inside the
/// last seven days, and a short date beyond that with the year only when it is
/// not this year. Pure, and reading the calendar and the clock from the caller,
/// so the one place it can be wrong (a message sent at 23:58 read at 00:02) is
/// pinned by a test rather than by whoever is awake at midnight.
enum DayLabels {
    /// Whether two instants fall on the same calendar day for this reader.
    static func isSameDay(_ a: Date, _ b: Date, calendar: Calendar = .current) -> Bool {
        calendar.isDate(a, inSameDayAs: b)
    }

    static func label(
        for date: Date,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        let start = calendar.startOfDay(for: date)
        let today = calendar.startOfDay(for: now)
        let daysAgo = calendar.dateComponents([.day], from: start, to: today).day ?? 0

        if daysAgo == 0 { return String(localized: "Today") }
        if daysAgo == 1 { return String(localized: "Yesterday") }

        // `< 7`, not `2...6`: the web spells out the weekday for anything less
        // than a week old, which includes a clock slightly ahead of the server's.
        // Fields, not a preset: `.abbreviated` would carry the year every time,
        // and the year is the one part that is conditional.
        var style = Date.FormatStyle(date: .omitted, time: .omitted, locale: locale, calendar: calendar)
            .month(.abbreviated)
            .day()
        if daysAgo < 7 { style = style.weekday(.wide) }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        if !sameYear { style = style.year() }
        let text = date.formatted(style)
        // Portuguese weekday and month names are lowercase in CLDR. A row that
        // stands on its own reads better with a capital, the way the web's
        // rendering of the same string does.
        return text.prefix(1).uppercased(with: locale) + text.dropFirst()
    }
}
