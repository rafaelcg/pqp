import XCTest

/// The app actually speaks Portuguese, all the way to the screen.
///
/// WHY THIS EXISTS. `Localizable.xcstrings` is keyed on the **English source
/// string**, so editing an English literal renames its key and orphans the
/// translation. Nothing warns: the build succeeds, the unit tests pass, and a
/// Brazilian user quietly gets English. That very nearly shipped while the em
/// dashes were being taken out of the copy, which changed six keys at once.
///
/// `NoEmDashTests.testEveryStringInTheCatalogueIsStillTranslated` catches the
/// orphan inside the catalogue. This catches the other half, which no amount of
/// JSON reading can: that the catalogue is compiled into the bundle and looked
/// up at runtime at all.
final class LocalizationUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testTheAppRendersInPortugueseForABrazilianDevice() {
        let app = XCUIApplication()
        app.launchArguments += [
            "-pqp.hasCompletedOnboarding", "NO",
            "-pqp.lastVisited", "none",
            "-pqp.fakeCallRating",
            // The system's own override, which is what a phone set to
            // Portuguese does. Not a flag of ours.
            "-AppleLanguages", "(pt-BR)",
            "-AppleLocale", "pt_BR",
        ]
        app.launch()

        // Onboarding first: if this is still "Skip" the bundle has no pt-BR at
        // all and everything below would fail for a different reason.
        let skip = app.buttons["Pular"]
        XCTAssertTrue(
            skip.waitForExistence(timeout: 15),
            "Onboarding is in English, so the pt-BR catalogue is not in the bundle"
        )
        skip.tap()

        // The newest copy in the app, and therefore the most likely to have been
        // added in English and left there.
        XCTAssertTrue(app.otherElements["callRating.card"].waitForExistence(timeout: 20))
        XCTAssertTrue(
            app.staticTexts["Como foi essa call?"].exists,
            "The rating card fell back to English, so its keys never reached the catalogue"
        )
        XCTAssertTrue(app.staticTexts["Não deu"].exists)
        XCTAssertTrue(app.staticTexts["Perfeita"].exists)
    }
}
