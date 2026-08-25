import XCTest

/**
 The pt-BR the catalogue promises is the pt-BR the bundle hands back.

 THIS IS THE THIRD CHECK on the same fact, and each one sees something the
 others cannot:

 - `NoEmDashTests.testEveryStringInTheCatalogueIsStillTranslated` reads the JSON
   and finds keys whose translation was dropped.
 - The `Check localisation coverage` build phase (`Scripts/check-localization.py`)
   reads the compiler's own `.stringsdata` and finds English literals that never
   reached the catalogue at all. That was worth 126 strings the first time it
   ran: the whole Friends screen, the whole DM call UI, threads, the audit log.
 - This file reads the **compiled** `pt-BR.lproj` out of the built app. A String
   Catalogue that is present in the repo and absent from the bundle looks
   identical to both of the above and is English on the phone, which is how the
   app once shipped with no localizations at all.

 It is a spot check by design. Asserting every key here would only restate the
 JSON, which the first check already does; what this asks is whether the
 pipeline from `.xcstrings` to `Bundle` works, using copy from the surfaces that
 were English the longest.
 */
final class LocalizationCoverageTests: XCTestCase {
    /// The app's Portuguese, as compiled and shipped.
    private func brazilianBundle() throws -> Bundle {
        let path = try XCTUnwrap(
            Bundle.main.path(forResource: "pt-BR", ofType: "lproj"),
            "The app bundle has no pt-BR.lproj. The catalogue is not being compiled in."
        )
        return try XCTUnwrap(Bundle(path: path))
    }

    /// `localizedString(forKey:value:table:)` answers with the key itself when
    /// there is no entry, which is exactly the bug being tested for, so the
    /// sentinel has to be something a real translation could never be.
    private func translation(_ key: String, in bundle: Bundle) -> String? {
        let sentinel = "\u{0}missing\u{0}"
        let value = bundle.localizedString(forKey: key, value: sentinel, table: nil)
        return value == sentinel ? nil : value
    }

    /// Guards the guard: a lookup that always answers with something would
    /// pass every assertion below without reading the catalogue at all.
    func testAKeyThatIsNotThereReadsAsMissing() throws {
        XCTAssertNil(translation("no string is worded like this", in: try brazilianBundle()))
    }

    func testTheCopyThatSpentLongestInEnglishIsPortugueseNow() throws {
        let bundle = try brazilianBundle()
        // One per surface that the coverage check found untranslated, rather
        // than a long list from one screen: the failure was per-surface.
        let expected = [
            "Hang up": "Desligar",                  // the DM call
            "Accept": "Aceitar",                    // Friends
            "Threads": "Tópicos",                   // threads
            "banned a member": "baniu um membro",   // the audit log
            "You are presenting": "Você está apresentando",  // screen share
            "More reactions": "Mais reações",       // the message menu
        ]
        for (key, portuguese) in expected {
            XCTAssertEqual(
                translation(key, in: bundle), portuguese,
                "\"\(key)\" did not come back as Portuguese from the built bundle"
            )
        }
    }

    /// The other half of the failure, and the one no JSON can see: a
    /// translation that exists and is never asked for, because
    /// `Text(someString)` is the verbatim initialiser rather than the localised
    /// one. These four were in the catalogue and on screen in English.
    func testThePickerOptionsThatWereBuiltFromPlainStringsAreLookedUp() throws {
        let bundle = try brazilianBundle()
        for (key, portuguese) in [
            "All messages": "Todas as mensagens",
            "Only @mentions": "Só @menções",
            "Keep forever": "Guardar para sempre",
            "People I share a community with": "Quem está numa comunidade comigo",
        ] {
            XCTAssertEqual(translation(key, in: bundle), portuguese)
        }
    }
}
