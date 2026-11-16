import XCTest

@testable import pqp

/// The agreement line App Review's Guideline 1.2 asks for, before sign-up.
final class LegalAgreementTests: XCTestCase {
    func testTheLineLinksTheTermsAndThePrivacyPolicy() {
        let links = LegalAgreementLine.text.runs.compactMap(\.link)
        XCTAssertEqual(links, [LegalLinks.terms, LegalLinks.privacy])
    }

    func testTheLineSaysThereIsZeroToleranceInTheSentenceItself() {
        // App Review 1.2 wants the terms to say it before the account exists, and
        // the line is the only thing read before the Terms are opened.
        let text = String(LegalAgreementLine.text.characters)
        XCTAssertTrue(text.contains("zero tolerance"), text)
        XCTAssertTrue(text.contains("objectionable content"), text)
        XCTAssertTrue(text.contains("abusive users"), text)
    }

    func testOnlyTheTwoLegalPagesOpenInTheInAppBrowser() {
        XCTAssertTrue(LegalLinks.isLegal(LegalLinks.terms))
        XCTAssertTrue(LegalLinks.isLegal(LegalLinks.privacy))
        XCTAssertFalse(LegalLinks.isLegal(URL(string: "https://pqp.gg/")!))
        XCTAssertFalse(LegalLinks.isLegal(URL(string: "https://example.com/terms")!))
    }

    func testTheLegalPagesAreTheWebsOwn() {
        XCTAssertEqual(LegalLinks.terms.absoluteString, "https://pqp.gg/terms")
        XCTAssertEqual(LegalLinks.privacy.absoluteString, "https://pqp.gg/privacy")
    }
}
