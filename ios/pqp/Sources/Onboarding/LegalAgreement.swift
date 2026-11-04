import SwiftUI
import SafariServices

/// The agreement line a person sees before they make an account.
///
/// App Review (Guideline 1.2, user-generated content) asks that people agree to
/// terms, and that those terms make it clear there is no tolerance for
/// objectionable content or abusive users, BEFORE they register or log in. So
/// the line sits under the sign-in buttons on the welcome screen, where the
/// tap happens, and again under Clerk's own sheet (`legalAgreementInset`),
/// because that is where the account is actually made.
///
/// The documents are the web's own pages, `/terms` and `/privacy`, the single
/// source of truth for the wording. They open in an in-app Safari sheet so the
/// person never leaves the app and the sign-in underneath is untouched.
enum LegalLinks {
    static let terms = URL(string: "https://pqp.gg/terms")!
    static let privacy = URL(string: "https://pqp.gg/privacy")!

    /// The one address the Terms name for support, abuse reports, appeals and
    /// privacy requests. There is no contact page on the web to link instead.
    static let contactAddress = "contato@pqp.gg"
    static let contact = URL(string: "mailto:contato@pqp.gg")!

    /// Only these two open in the in-app browser; any other link keeps its
    /// default behaviour.
    static func isLegal(_ url: URL) -> Bool {
        url == terms || url == privacy
    }
}

/// "By continuing, you agree to the Terms and the Privacy Policy."
///
/// The two links are Markdown inside one localised sentence, so a translation
/// can order the words as its language needs. They are underlined as well as
/// tinted: a link that differs from its sentence by colour alone is invisible
/// to somebody who cannot tell the colours apart.
struct LegalAgreementLine: View {
    static var text: AttributedString {
        let source = AttributedString(
            localized: "By continuing, you agree to the [Terms](https://pqp.gg/terms) and the [Privacy Policy](https://pqp.gg/privacy)."
        )
        var value = source
        for run in source.runs where run.link != nil {
            value[run.range].underlineStyle = .single
            value[run.range].foregroundColor = Palette.paperSubtle
        }
        return value
    }

    var body: some View {
        Text(Self.text)
            .font(.footnote)
            .foregroundStyle(Palette.paperMuted)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: 420)
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("welcome.agreement")
    }
}

/// An in-app browser for the two legal pages.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

private struct LegalLinkSheet: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

private struct InAppLegalLinks: ViewModifier {
    @State private var sheet: LegalLinkSheet?

    func body(content: Content) -> some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                guard LegalLinks.isLegal(url) else { return .systemAction }
                sheet = LegalLinkSheet(url: url)
                return .handled
            })
            .sheet(item: $sheet) { item in
                SafariView(url: item.url).ignoresSafeArea()
            }
    }
}

extension View {
    /// Opens a Terms or Privacy link tapped anywhere inside this view in an
    /// in-app Safari sheet.
    func inAppLegalLinks() -> some View {
        modifier(InAppLegalLinks())
    }

    /// The agreement line pinned under a sheet's content, which is how it sits
    /// under Clerk's flow without touching Clerk.
    func legalAgreementInset() -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) {
            LegalAgreementLine()
                .padding(.horizontal, 24)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .background(.bar)
        }
        .inAppLegalLinks()
    }
}
