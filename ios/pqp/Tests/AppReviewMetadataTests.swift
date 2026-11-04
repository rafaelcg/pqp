import XCTest

@testable import pqp

/// The in-app half of the App Review fixes: the About section's facts, and the
/// three files Apple reads straight out of the bundle (Info.plist and the two
/// privacy manifests). They are read from the source tree, like
/// `NoEmDashTests`, because a plist that is wrong is wrong before anything runs.
final class AppReviewMetadataTests: XCTestCase {
    private static var appRoot: URL {
        URL(fileURLWithPath: #filePath)   // …/ios/pqp/Tests/AppReviewMetadataTests.swift
            .deletingLastPathComponent()  // …/ios/pqp/Tests
            .deletingLastPathComponent()  // …/ios/pqp
    }

    private func plist(_ path: String) throws -> [String: Any] {
        let data = try Data(contentsOf: Self.appRoot.appending(path: path))
        let object = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(object as? [String: Any])
    }

    // MARK: About

    func testTheContactRowWritesToTheAddressTheTermsName() {
        XCTAssertEqual(LegalLinks.contactAddress, "contato@pqp.gg")
        XCTAssertEqual(LegalLinks.contact.absoluteString, "mailto:contato@pqp.gg")
        // Only the two web pages open in the in-app browser; mail goes to Mail.
        XCTAssertFalse(LegalLinks.isLegal(LegalLinks.contact))
    }

    func testTheVersionLabelNamesTheVersionAndTheBuild() {
        XCTAssertEqual(
            AppVersion.label(from: ["CFBundleShortVersionString": "1.2", "CFBundleVersion": "43"]),
            "1.2 (43)"
        )
        XCTAssertEqual(AppVersion.label(from: ["CFBundleShortVersionString": "1.2"]), "1.2")
        XCTAssertEqual(AppVersion.label(from: ["CFBundleVersion": "43"]), "43")
        XCTAssertEqual(AppVersion.label(from: [:]), "?")
    }

    // MARK: Info.plist

    func testTheAppDoesNotDeclareVoipWithoutPushKit() throws {
        let info = try plist("Info.plist")
        let modes = try XCTUnwrap(info["UIBackgroundModes"] as? [String])
        XCTAssertEqual(modes, ["audio"])
        // If this starts failing because PushKit shipped, bring `voip` back in
        // the same change: the two go together.
        let sources = try String(
            contentsOf: Self.appRoot.appending(path: "Sources/Voice/CallKitCoordinator.swift"),
            encoding: .utf8
        )
        XCTAssertFalse(sources.contains("PKPushRegistry"))
    }

    func testTheLocalNetworkPromptHasAnHonestReason() throws {
        let info = try plist("Info.plist")
        let text = try XCTUnwrap(info["NSLocalNetworkUsageDescription"] as? String)
        XCTAssertTrue(text.contains("calls"))
        XCTAssertFalse(text.contains("\u{2014}"))
    }

    func testTheReleasePlistCarriesNoAppTransportSecurityException() throws {
        // Plain HTTP to a local API is a Debug-only need, added to the BUILT
        // plist by the "Allow local HTTP (Debug only)" phase in project.yml.
        // The source plist is what Release ships, so it must not name ATS.
        let info = try plist("Info.plist")
        XCTAssertNil(info["NSAppTransportSecurity"])
    }

    // MARK: Store listing

    func testTheDescriptionsMakeNoDatedAttendanceClaim() throws {
        // A "100 people in September 2026" line cannot be checked by a reviewer
        // (Guideline 2.3.1), so the listing says what watch parties are for.
        let metadata = Self.appRoot
            .deletingLastPathComponent()  // …/ios
            .appending(path: "app-store/metadata")
        for locale in ["en-US", "pt-BR", "es-MX"] {
            let text = try String(
                contentsOf: metadata.appending(path: "\(locale)/description.txt"), encoding: .utf8
            )
            XCTAssertFalse(text.contains("100"), locale)
            XCTAssertFalse(text.lowercased().contains("2026"), locale)
        }
    }

    // MARK: Privacy manifests

    func testTheAppManifestSaysNoTrackingAndNamesUserDefaults() throws {
        let manifest = try plist("PrivacyInfo.xcprivacy")
        XCTAssertEqual(manifest["NSPrivacyTracking"] as? Bool, false)
        XCTAssertEqual((manifest["NSPrivacyTrackingDomains"] as? [Any])?.count, 0)

        let apis = try XCTUnwrap(manifest["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
        XCTAssertEqual(apis.count, 1)
        XCTAssertEqual(apis[0]["NSPrivacyAccessedAPIType"] as? String, "NSPrivacyAccessedAPICategoryUserDefaults")
        XCTAssertEqual(apis[0]["NSPrivacyAccessedAPITypeReasons"] as? [String], ["CA92.1"])

        let collected = try XCTUnwrap(manifest["NSPrivacyCollectedDataTypes"] as? [[String: Any]])
        XCTAssertFalse(collected.isEmpty)
        for item in collected {
            XCTAssertEqual(item["NSPrivacyCollectedDataTypeTracking"] as? Bool, false, "\(item)")
        }
    }

    func testTheBroadcastExtensionManifestDeclaresNothingItDoesNotUse() throws {
        let manifest = try plist("Broadcast/PrivacyInfo.xcprivacy")
        XCTAssertEqual(manifest["NSPrivacyTracking"] as? Bool, false)
        XCTAssertEqual((manifest["NSPrivacyCollectedDataTypes"] as? [Any])?.count, 0)
        XCTAssertEqual((manifest["NSPrivacyAccessedAPITypes"] as? [Any])?.count, 0)
    }
}
