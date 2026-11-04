import SwiftUI

/// The last section of Settings: the legal pages, who to write to, and which
/// build this is.
///
/// App Review (Guideline 5.1.1(i), and 1.2 for published contact information)
/// wants the privacy policy and a way to reach the developer INSIDE the app,
/// not only on a store page. Before this the screen ended at "Delete my
/// account" and nothing in the app linked to either.
///
/// The Terms and the Privacy Policy are the web's own pages, the single source
/// of truth for the wording, and open in the same in-app Safari sheet the
/// sign-in line uses (`inAppLegalLinks`, which the owner of the screen applies
/// above the `Form`: a sheet hung on a section is torn down when the section
/// scrolls away, see `YourDataSection`). Contact is a `mailto:` because there
/// is no contact page on the web: the Terms name one address for support, abuse
/// reports, appeals and privacy requests, and this is it.
struct AboutSection: View {
    var body: some View {
        Section {
            Link(destination: LegalLinks.terms) {
                row("Terms of Service", systemImage: "doc.text")
            }
            .accessibilityIdentifier("settings.about.terms")

            Link(destination: LegalLinks.privacy) {
                row("Privacy Policy", systemImage: "hand.raised")
            }
            .accessibilityIdentifier("settings.about.privacy")

            Link(destination: LegalLinks.contact) {
                VStack(alignment: .leading, spacing: 2) {
                    row("Contact us or report abuse", systemImage: "envelope")
                    // The address in plain text as well: a phone with no mail
                    // account configured opens nothing from a `mailto:`, and a
                    // reviewer (or anybody) can still read where to write.
                    Text(verbatim: LegalLinks.contactAddress)
                        .font(.footnote)
                        .foregroundStyle(Palette.paperMuted)
                        .padding(.leading, 36)
                }
            }
            .accessibilityIdentifier("settings.about.contact")

            LabeledContent("Version") {
                Text(verbatim: AppVersion.label())
                    .foregroundStyle(Palette.paperMuted)
                    .textSelection(.enabled)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("settings.about.version")
        } header: {
            Text("About")
        } footer: {
            Text("To report a message, a person or a community, open its menu and choose Report.")
        }
    }

    /// One tappable line: a fixed-width icon, the title, and a trailing
    /// chevron. Fixed width on the icon only, so the text still wraps at the
    /// largest Dynamic Type sizes instead of being clipped.
    private func row(_ title: LocalizedStringKey, systemImage: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .frame(width: 24)
                .foregroundStyle(Palette.paperMuted)
                .accessibilityHidden(true)
            Text(title)
                .foregroundStyle(Palette.paper)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.paperMuted)
                .accessibilityHidden(true)
        }
    }
}

/// "1.0 (32)": the marketing version and the build number, which is what a
/// support message needs to name.
enum AppVersion {
    static func label(from info: [String: Any]? = Bundle.main.infoDictionary) -> String {
        let short = (info?["CFBundleShortVersionString"] as? String) ?? ""
        let build = (info?["CFBundleVersion"] as? String) ?? ""
        switch (short.isEmpty, build.isEmpty) {
        case (false, false): return "\(short) (\(build))"
        case (false, true): return short
        case (true, false): return build
        case (true, true): return "?"
        }
    }
}
