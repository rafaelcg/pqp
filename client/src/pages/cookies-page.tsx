import { Link } from "react-router-dom";
import { LegalPage } from "@/components/marketing/legal-page";

export function CookiesPage() {
  return (
    <LegalPage
      title="Cookie Notice — pqp"
      description="What cookies and local storage pqp.gg uses for authentication and preferences."
      path="/cookies"
      heading="Cookie notice"
      updated="July 11, 2026"
    >
      <p>
        This notice explains how <strong>pqp.gg</strong> uses cookies and
        similar storage. Self-hosted instances may behave differently depending
        on how you configure auth and hosting.
      </p>

      <h2>What we use</h2>
      <ul>
        <li>
          <strong>Essential auth (Clerk)</strong> — Session cookies and/or
          local storage so you stay signed in. Without these, the app cannot
          authenticate you. Managed by{" "}
          <a href="https://clerk.com" target="_blank" rel="noreferrer">
            Clerk
          </a>
          ; see their documentation for technical details.
        </li>
        <li>
          <strong>Local preferences</strong> — Settings such as mute-on-join
          may be stored in your browser&apos;s local storage. These stay on
          your device and are not used for advertising.
        </li>
      </ul>

      <h2>What we do not use</h2>
      <p>
        On the marketing and app surfaces we control, we do not set third-party
        advertising cookies or sell cookie data. If we add analytics later, we
        will update this notice and, where required, ask for consent.
      </p>

      <h2>Managing cookies</h2>
      <p>
        You can clear cookies and site data in your browser settings. Blocking
        essential auth cookies will prevent sign-in to pqp.gg.
      </p>

      <h2>More</h2>
      <p>
        See the <Link to="/privacy">Privacy Policy</Link> for how we handle
        personal data, and the <Link to="/terms">Terms of Service</Link> for
        use of the hosted product.
      </p>

      <h2>Contact</h2>
      <p>
        <a href="mailto:privacy@pqp.gg">privacy@pqp.gg</a>
      </p>
    </LegalPage>
  );
}
