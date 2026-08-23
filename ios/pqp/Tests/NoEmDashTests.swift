import XCTest

/**
 No em dash reaches a user, on iOS either.

 THE MIRROR OF `client/src/locales/no-em-dash.test.ts`. "No em dashes" is a
 standing rule for this product's voice, and the web catalogues had broken it
 184 times before anyone counted. A rule nobody can enforce is a preference,
 and a preference loses to whoever is typing that day.

 IT READS TWO PLACES, because the copy lives in two. The English source is
 written inline in SwiftUI (`Text("…")`, `String(localized:)`, `Label`,
 `Button`), so the only place that half can be checked is the source tree,
 which a simulator test can read because `#filePath` is a host path and the
 simulator shares the host filesystem. The Portuguese lives in
 `Resources/Localizable.xcstrings`, which is checked directly.

 The en dash and the horizontal bar are banned too. They are not the character
 the rule names, but they are what a well-meaning search-and-replace reaches
 for next and they read identically at body size. A hyphen is deliberately
 fine: `push-to-talk` and `peer-to-peer` are words, not punctuation.

 WHAT IS NOT SCANNED, and why:

 - **Comments.** This codebase's comments are long, argumentative and full of
   em dashes, which is correct: they are written for whoever reads the code,
   not for whoever uses the app. Scanning them would have made the rule
   unadoptable and it would have been switched off within the week.
 - **`Tests/` and `UITests/`.** An `XCTAssert` message is read by whoever
   broke the build. Same reasoning as comments.

 AND THE STRING CATALOGUE, which is the half that matters most. This app ships
 pt-BR, and a Brazilian user reads the translation rather than the English
 source. Scanning only Swift would have declared the copy clean while six pt-BR
 strings still carried an em dash, which is exactly what happened: the first
 version of this test passed on a catalogue full of them.
 */
final class NoEmDashTests: XCTestCase {
    /// Character, and the name to print when it is found.
    private static let banned: [Character: String] = [
        "\u{2014}": "em dash",
        "\u{2013}": "en dash",
        "\u{2015}": "horizontal bar",
    ]

    /// `ios/pqp`, derived from this file rather than from a bundle: a test
    /// bundle contains compiled code, not the sources being asserted about.
    private static var appRoot: URL {
        URL(fileURLWithPath: #filePath)      // …/ios/pqp/Tests/NoEmDashTests.swift
            .deletingLastPathComponent()     // …/ios/pqp/Tests
            .deletingLastPathComponent()     // …/ios/pqp
    }

    /// Everything that can put words in front of somebody. `Broadcast` is in
    /// because `finishBroadcastWithError` surfaces its message in a system
    /// alert, which is as user-facing as anything in `Sources`.
    private static let scanned = ["Sources", "Broadcast", "ScreenShare"]

    func testTranslatedCopyCarriesNoDashPunctuationEither() throws {
        XCTAssertEqual(try Self.offencesInCatalogue(), [])
    }

    /// The keys are the English source strings, so a key that still contains a
    /// dash is a Swift literal that was never repaired, and a *renamed* key
    /// whose translation is missing is a repair that silently dropped the
    /// Portuguese. Both are caught by scanning the catalogue's own contents.
    func testEveryStringInTheCatalogueIsStillTranslated() throws {
        let catalogue = try Self.catalogue()
        let untranslated = catalogue.strings
            .filter { $0.value.localizations["pt-BR"] == nil }
            .keys
            .sorted()
        XCTAssertLessThanOrEqual(
            untranslated.count, Self.untranslatedAllowance,
            """
            More strings are missing pt-BR than this file's allowance. Editing \
            an English literal RENAMES its catalogue key and orphans the \
            translation, which shows a Brazilian user English with no error \
            anywhere. Move the translation across rather than leaving it \
            behind. Missing: \(untranslated)
            """
        )
    }

    /// Every string in the catalogue currently has its pt-BR, so the allowance
    /// is zero and any orphan is a failure. Raise it only to record a backlog
    /// somebody has decided to accept, never to get a red run to go green.
    private static let untranslatedAllowance = 0

    func testUserFacingCopyCarriesNoDashPunctuation() throws {
        let offences = try Self.offencesInAppSources()
        XCTAssertEqual(
            offences, [],
            """
            Dash punctuation in user-facing copy. Repair it per sentence, the way \
            the web fix did: a comma where the dash fenced an appositive, a middle \
            dot where it separated two labels, a full stop where the second half \
            stands alone as its own sentence.
            """
        )
    }

    /// Guards the guard: an assertion that only ever sees clean input is not
    /// evidence that it would notice dirty input.
    func testTheScannerWouldCatchOneComingBack() {
        XCTAssertEqual(
            Self.offences(in: #"Text("before \#u{2014} after")"#, path: "x.swift"),
            ["x.swift:1 (em dash): \"before \u{2014} after\""]
        )
        XCTAssertEqual(Self.offences(in: #"Text("push-to-talk stays")"#, path: "x.swift"), [])
        // A comment is not copy, however emphatic it is.
        XCTAssertEqual(Self.offences(in: "// this \u{2014} is fine", path: "x.swift"), [])
        // Neither is code that merely sits beside a string.
        XCTAssertEqual(Self.offences(in: "let x = 1 // \u{2014}", path: "x.swift"), [])
        // A trailing comment must not hide a real offence earlier on the line.
        XCTAssertEqual(
            Self.offences(in: "Text(\"a \u{2014} b\") // note", path: "x.swift").count, 1
        )
    }

    // MARK: - The string catalogue

    /// Only the shape this test asks about. Decoding the whole `.xcstrings`
    /// schema would be a second thing to keep in step with Xcode for no gain.
    struct Catalogue: Decodable {
        struct Entry: Decodable {
            struct Localization: Decodable {
                struct Unit: Decodable { let value: String }
                let stringUnit: Unit?
            }
            let localizations: [String: Localization]

            // Absent on a key with no translations at all, which is a valid
            // catalogue and has to decode rather than throw.
            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                localizations = try container.decodeIfPresent(
                    [String: Localization].self, forKey: .localizations
                ) ?? [:]
            }

            enum CodingKeys: String, CodingKey { case localizations }
        }
        let strings: [String: Entry]
    }

    static func catalogue() throws -> Catalogue {
        let url = appRoot
            .appendingPathComponent("Resources")
            .appendingPathComponent("Localizable.xcstrings")
        return try JSONDecoder().decode(Catalogue.self, from: Data(contentsOf: url))
    }

    private static func offencesInCatalogue() throws -> [String] {
        var found: [String] = []
        for (key, entry) in try catalogue().strings {
            for (character, name) in banned where key.contains(character) {
                found.append("key (\(name)): \(key)")
            }
            for (language, localization) in entry.localizations {
                guard let value = localization.stringUnit?.value else { continue }
                for (character, name) in banned where value.contains(character) {
                    found.append("\(language) (\(name)): \(value)")
                }
            }
        }
        return found.sorted()
    }

    // MARK: - Scanning

    private static func offencesInAppSources() throws -> [String] {
        let manager = FileManager.default
        var found: [String] = []
        for directory in scanned {
            let root = appRoot.appendingPathComponent(directory)
            var isDirectory: ObjCBool = false
            guard manager.fileExists(atPath: root.path, isDirectory: &isDirectory),
                  isDirectory.boolValue
            else {
                XCTFail("No \(directory) directory at \(root.path). Has the layout moved?")
                continue
            }
            guard let walker = manager.enumerator(atPath: root.path) else { continue }
            for case let relative as String in walker where relative.hasSuffix(".swift") {
                let file = root.appendingPathComponent(relative)
                let source = try String(contentsOf: file, encoding: .utf8)
                found += offences(in: source, path: "\(directory)/\(relative)")
            }
        }
        return found.sorted()
    }

    /// Every banned character that sits inside a string literal, with where.
    ///
    /// Deliberately line-based and deliberately naive about interpolation: the
    /// question is only "is this character inside quotes", and a scanner that
    /// tried to parse Swift properly would be a second thing to be wrong.
    static func offences(in source: String, path: String) -> [String] {
        var found: [String] = []
        for (index, line) in source.split(separator: "\n", omittingEmptySubsequences: false)
            .enumerated() {
            let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
            // `///`, `//`, and the `*` continuing a `/* */` block.
            if trimmed.hasPrefix("//") || trimmed.hasPrefix("*") || trimmed.hasPrefix("/*") {
                continue
            }
            for literal in stringLiterals(in: String(line)) {
                for (character, name) in banned where literal.contains(character) {
                    found.append("\(path):\(index + 1) (\(name)): \(literal)")
                }
            }
        }
        return found
    }

    /// The quoted spans of one line, with a trailing `//` comment removed.
    ///
    /// The comment has to be found by the same pass, not stripped first: a
    /// `//` inside a string ("https://…") is not a comment, and cutting on the
    /// first one would silently stop scanning half the URLs in the app.
    private static func stringLiterals(in line: String) -> [String] {
        var literals: [String] = []
        var current = ""
        var inString = false
        var escaped = false
        var previous: Character?

        for character in line {
            if inString {
                current.append(character)
                if escaped {
                    escaped = false
                } else if character == "\\" {
                    escaped = true
                } else if character == "\"" {
                    literals.append(current)
                    inString = false
                }
            } else if character == "\"" {
                inString = true
                current = "\""
            } else if character == "/", previous == "/" {
                break
            }
            previous = character
        }
        return literals
    }
}
