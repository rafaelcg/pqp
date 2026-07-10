import { Link } from "react-router-dom";
import { LegalPage } from "@/components/marketing/legal-page";

export function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy — pqp"
      description="How pqp.gg and self-hosted pqp handle account data, messages, voice, and cookies."
      path="/privacy"
      heading="Privacy Policy"
      updated="July 11, 2026"
    >
      <p>
        This policy explains what pqp collects and why. It covers the hosted
        service at <strong>pqp.gg</strong>. If you self-host pqp, you are the
        data controller for your instance — this document still describes what
        the software is designed to store so you can write your own policy.
      </p>

      <h2>Who we are</h2>
      <p>
        pqp is an open-source Discord alternative (servers, text/voice channels,
        invites). The hosted product is available at pqp.gg. Contact:{" "}
        <a href="mailto:privacy@pqp.gg">privacy@pqp.gg</a>.
      </p>

      <h2>What we collect (hosted pqp.gg)</h2>
      <ul>
        <li>
          <strong>Account data</strong> — Authentication is handled by{" "}
          <a
            href="https://clerk.com"
            target="_blank"
            rel="noreferrer"
          >
            Clerk
          </a>
          . We receive identifiers and profile fields Clerk provides (for
          example user id, email, display name) so we can create your pqp user
          and keep you signed in.
        </li>
        <li>
          <strong>Profile</strong> — Display name and tag (e.g. name#1234) you
          set in the app.
        </li>
        <li>
          <strong>Server &amp; channel data</strong> — Servers you create or
          join, channel names/types, roles, and invite codes.
        </li>
        <li>
          <strong>Messages</strong> — Text messages you send in channels are
          stored so history works when you reload. We do not sell message
          content.
        </li>
        <li>
          <strong>Voice</strong> — Voice uses WebRTC between peers (mesh). Audio
          is not recorded or stored by pqp by default. Signaling metadata (who
          joined which voice channel) may pass through our servers to connect
          calls.
        </li>
        <li>
          <strong>Technical logs</strong> — Basic server logs (errors, request
          timing) for reliability and abuse prevention. We do not build
          advertising profiles.
        </li>
      </ul>

      <h2>Cookies and similar tech</h2>
      <p>
        Clerk uses cookies/local storage for session auth. See our{" "}
        <Link to="/cookies">Cookie notice</Link> for details. We do not run
        third-party ad trackers on the marketing site.
      </p>

      <h2>Why we process data</h2>
      <p>
        To run the product: authenticate you, deliver chat and voice, store
        message history you expect to see, prevent abuse, and improve
        reliability. Legal bases (where GDPR applies): contract (providing the
        service) and legitimate interests (security, debugging).
      </p>

      <h2>Sharing</h2>
      <p>
        We share data with processors who help run pqp.gg — notably Clerk
        (auth) and our hosting/database providers. We do not sell personal
        data. We may disclose information if required by law or to protect
        users from serious harm.
      </p>

      <h2>Retention</h2>
      <p>
        Account and message data stay until you delete them or close your
        account, or until we delete inactive data as part of normal ops. You
        can ask us to delete your hosted account via{" "}
        <a href="mailto:privacy@pqp.gg">privacy@pqp.gg</a>.
      </p>

      <h2>Your rights</h2>
      <p>
        Depending on where you live, you may have rights to access, correct,
        delete, or export your data, and to object to certain processing.
        Email us and we will respond within a reasonable time.
      </p>

      <h2>Self-hosted instances</h2>
      <p>
        If you run pqp yourself, you choose the database, Clerk application,
        and hosting. pqp.gg does not receive your users&apos; data. Tell your
        members how you handle their information.
      </p>

      <h2>Children</h2>
      <p>
        pqp.gg is not directed at children under 13 (or the minimum age in
        your country). Do not create an account if you are under that age.
      </p>

      <h2>Changes</h2>
      <p>
        We may update this policy. The &quot;Last updated&quot; date at the top
        will change. Continued use of pqp.gg after updates means you accept the
        revised policy.
      </p>
    </LegalPage>
  );
}
