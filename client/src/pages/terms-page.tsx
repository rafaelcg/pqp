import { Link } from "react-router-dom";
import { LegalPage } from "@/components/marketing/legal-page";

export function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service — pqp"
      description="Terms for using the hosted pqp.gg service and notes for self-hosted deployments."
      path="/terms"
      heading="Terms of Service"
      updated="July 11, 2026"
    >
      <p>
        These terms cover the hosted service at <strong>pqp.gg</strong>. By
        creating an account or using the app, you agree to them. Self-hosted
        copies of the open-source software are governed by the project license
        and whatever terms you set for your own users — not these hosted terms.
      </p>

      <h2>The service</h2>
      <p>
        pqp is a real-time chat and voice product: servers, text and voice
        channels, invites, and related features. We may change, pause, or
        discontinue features. Hosted billing tiers (if offered) will be
        described separately when available.
      </p>

      <h2>Accounts</h2>
      <p>
        You sign in through Clerk. Keep your credentials safe. You are
        responsible for activity under your account. Provide accurate info and
        do not impersonate others.
      </p>

      <h2>Acceptable use</h2>
      <p>Do not use pqp.gg to:</p>
      <ul>
        <li>Break the law or encourage others to</li>
        <li>Harass, threaten, or exploit people</li>
        <li>Distribute malware, spam, or scrape the service abusively</li>
        <li>Attempt to break into accounts, servers, or infrastructure</li>
        <li>Infringe others&apos; intellectual property or privacy</li>
      </ul>
      <p>
        We may suspend or terminate accounts that violate these rules or put
        the service or other users at risk.
      </p>

      <h2>Your content</h2>
      <p>
        You keep ownership of messages and other content you post. You grant us
        a limited license to host, store, and display that content so the
        product works (including showing history to members of your servers).
        You are responsible for what you post and for having the rights to
        post it.
      </p>

      <h2>Our stuff</h2>
      <p>
        The pqp name, branding on pqp.gg, and hosted infrastructure are ours.
        The open-source codebase is available under its project license —
        separate from the hosted service.
      </p>

      <h2>Voice and media</h2>
      <p>
        Voice uses WebRTC. Quality depends on your network and peers. We do
        not guarantee uninterrupted audio. Do not record others without
        consent where required by law.
      </p>

      <h2>Disclaimer</h2>
      <p>
        The service is provided &quot;as is.&quot; To the fullest extent
        allowed by law, we disclaim warranties of merchantability, fitness for
        a particular purpose, and non-infringement. We do not promise the
        service will be error-free or always available.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the fullest extent allowed by law, pqp and its operators are not
        liable for indirect, incidental, special, or consequential damages, or
        for loss of data, profits, or goodwill arising from use of pqp.gg. Our
        total liability for any claim related to the hosted service is limited
        to the greater of (a) amounts you paid us for the service in the 12
        months before the claim, or (b) zero if the service was free.
      </p>

      <h2>Indemnity</h2>
      <p>
        You agree to indemnify us against claims arising from your content or
        your misuse of the service, to the extent permitted by law.
      </p>

      <h2>Privacy</h2>
      <p>
        Our <Link to="/privacy">Privacy Policy</Link> explains how we handle
        data. Our <Link to="/cookies">Cookie notice</Link> covers cookies.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. Continued use after the &quot;Last
        updated&quot; date means you accept the new terms. If you disagree,
        stop using pqp.gg and delete your account.
      </p>

      <h2>Contact</h2>
      <p>
        Questions: <a href="mailto:legal@pqp.gg">legal@pqp.gg</a>.
      </p>
    </LegalPage>
  );
}
