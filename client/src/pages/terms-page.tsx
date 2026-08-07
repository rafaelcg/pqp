import { Link } from "react-router-dom";
import { LegalPage } from "@/components/marketing/legal-page";

export function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service — pqp"
      description="Terms for using the hosted pqp.gg service: eligibility (18+), acceptable use, moderation, reporting and takedowns."
      path="/terms"
      heading="Terms of Service"
      updated="{{EFFECTIVE_DATE}}"
    >
      <p>
        These terms cover the hosted service at <strong>pqp.gg</strong>, operated
        by <strong>{"{{LEGAL_ENTITY_NAME}}"}</strong> (CNPJ{" "}
        <strong>{"{{LEGAL_ENTITY_CNPJ}}"}</strong>,{" "}
        <strong>{"{{LEGAL_ENTITY_ADDRESS}}"}</strong>) — &quot;we,&quot;
        &quot;us,&quot; pqp. By creating an account or using the app, you agree
        to them. Self-hosted copies of the open-source software are governed by
        the project license and whatever terms you set for your own users — not
        these hosted terms.
      </p>

      <h2>You must be 18 or older</h2>
      <p>
        <strong>pqp.gg is for adults only.</strong> You may only create an
        account or use the service if you are <strong>18 years of age or
        older</strong>. There is no version of pqp.gg for minors, and no
        parental-consent path that makes an under-18 account acceptable. By
        signing up you confirm that you are 18 or older and legally able to
        enter into these terms.
      </p>
      <p>
        If we learn that an account belongs to someone under 18, we will
        terminate it and delete the associated data, without notice and without
        appeal. We may do the same where we have a good-faith belief the account
        holder is under 18 — for example, from what they say in chat or from a
        report we receive.
      </p>
      <p>
        <strong>To report an account you believe belongs to a minor</strong>,
        write to <strong>{"{{ABUSE_EMAIL}}"}</strong> with the user tag (their{" "}
        <code>name#1234</code> handle), the server or DM where you saw them, and
        what led you to believe they are under 18. Reports about minors are
        handled ahead of the normal queue. You do not need an account to send
        one.
      </p>
      <p>
        We do not currently verify age with documents or a third-party
        age-assurance provider. Eligibility is enforced at sign-up by
        self-declaration and afterwards by enforcement on report — we say this
        plainly rather than implying a check we do not perform.
      </p>

      <h2>The service</h2>
      <p>
        pqp is a real-time chat and voice product: servers, text and voice
        channels, direct messages, invites, and related features. We may change,
        pause, or discontinue features. Hosted billing tiers (if offered) will
        be described separately when available.
      </p>

      <h2>Accounts</h2>
      <p>
        You sign in through Clerk, a third-party identity provider. Clerk holds
        your login credentials and email address; pqp itself stores a display
        name, a <code>name#1234</code> handle, an avatar URL, and the domains of
        your verified email addresses. Keep your credentials safe. You are
        responsible for activity under your account. Provide accurate
        information and do not impersonate other people, brands, or pqp staff.
      </p>
      <p>
        One person, one account. Do not create accounts to evade a ban, and do
        not sell, rent, or transfer your account.
      </p>

      <h2>Acceptable use</h2>
      <p>Do not use pqp.gg to:</p>
      <ul>
        <li>
          Sexualise minors in any way, or share, request, or link to child
          sexual abuse material. This is the one rule with no warning step: it
          means immediate termination and, where the law requires it, a report
          to the competent authorities.
        </li>
        <li>
          Harass, threaten, stalk, or organise a pile-on against anyone;
          incite violence or self-harm
        </li>
        <li>
          Promote hate against people based on race, colour, ethnicity, national
          origin, religion, disability, sex, sexual orientation, or gender
          identity
        </li>
        <li>
          Share someone&apos;s private information without consent (doxxing), or
          share intimate images of someone without their consent
        </li>
        <li>Break the law, or plan or coordinate illegal activity</li>
        <li>
          Distribute malware, run phishing or fraud, spam, or scrape the service
          abusively
        </li>
        <li>
          Attempt to break into accounts, servers, or infrastructure, or evade
          rate limits and access controls
        </li>
        <li>Infringe others&apos; intellectual property or privacy</li>
        <li>
          Record voice conversations without the consent of the people in them,
          where consent is required by law
        </li>
        <li>Automate the service in a way that degrades it for other people</li>
      </ul>
      <p>
        Server owners and admins are responsible for the communities they run.
        Running a server whose apparent purpose is to break these rules is
        itself a violation.
      </p>

      <h2>Your content</h2>
      <p>
        You keep ownership of messages, files, and other content you post. You
        grant us a limited, non-exclusive licence to host, store, transmit, and
        display that content so the product works — for example, showing your
        message history to the members of your server. That licence exists for
        operating the service and ends when the content is deleted, except for
        copies we must keep to comply with a legal obligation. You are
        responsible for what you post and for having the rights to post it.
      </p>

      <h2>Moderation and enforcement</h2>
      <p>
        Most moderation on pqp happens inside a server, by the people who run
        it. Server owners and admins can:
      </p>
      <ul>
        <li>Delete messages in their channels</li>
        <li>Remove (kick) a member from the server</li>
        <li>
          Ban a member from the server, which removes them and blocks rejoining
        </li>
        <li>Change roles, and restrict who can post where</li>
      </ul>
      <p>
        Server-level actions are written to that server&apos;s audit log, so
        members with access can see who did what.
      </p>
      <p>
        Separately, we can act at the platform level when a report reaches us or
        we otherwise become aware of a problem. Depending on severity and
        history, that can mean: removing specific content, restricting an
        account&apos;s ability to post, removing a server from the hosted
        service, suspending an account, or terminating an account permanently.
        We aim to take the narrowest action that fixes the problem — but for
        content involving minors, credible threats of violence, or CSAM, the
        first action is termination.
      </p>
      <p>
        We can also suspend accounts or servers that put the service or other
        users at risk, including abuse of the infrastructure itself.
      </p>

      <h2>Reporting abuse</h2>
      <p>
        To report content, a user, or a whole server, email{" "}
        <strong>{"{{ABUSE_EMAIL}}"}</strong>. Include:
      </p>
      <ul>
        <li>What you are reporting — a message, a user, a server, a DM</li>
        <li>
          Where it is: the server name, channel name, and the user tag
          (<code>name#1234</code>)
        </li>
        <li>Why it breaks these terms, in a sentence or two</li>
        <li>Screenshots if you have them, and roughly when it happened</li>
      </ul>
      <p>
        We are building an in-app report button; until it ships, email is the
        reporting channel and it is monitored. You can report without having an
        account.
      </p>
      <p>
        <strong>What happens next.</strong> We acknowledge the report, review
        the content and the account&apos;s history, and take one of the actions
        listed above or close the report as no violation. We target an
        acknowledgement within{" "}
        <strong>{"{{STANDARD_REPORT_SLA_HOURS}}"}</strong> hours and a decision
        within <strong>{"{{TAKEDOWN_SLA_HOURS}}"}</strong> hours, and we
        prioritise reports involving minors, imminent physical danger, or
        non-consensual intimate images — those target{" "}
        <strong>{"{{URGENT_REPORT_SLA_HOURS}}"}</strong> hours. We will tell you
        the outcome where we can do so without exposing another user&apos;s
        personal data.
      </p>
      <p>
        Do not use reporting to harass someone. Repeated bad-faith reports are
        themselves a violation.
      </p>

      <h2>Copyright and other legal takedown requests</h2>
      <p>
        If you believe content on pqp.gg infringes your copyright or other
        rights, send a notice to <strong>{"{{LEGAL_EMAIL}}"}</strong>{" "}
        identifying the work, the exact location of the content, your contact
        details, and a statement that you are the rights holder or authorised to
        act for them. We will review it and remove content where the claim is
        substantiated.
      </p>
      <p>
        Brazilian law — in particular the{" "}
        <strong>Marco Civil da Internet (Lei nº 12.965/2014)</strong> — sets
        specific rules about when a platform must remove content and when it
        becomes liable for content posted by its users, including the general
        rule that removal follows a court order (with narrower rules for
        non-consensual intimate content). Our procedure for receiving and acting
        on judicial orders and out-of-court notices, and the address for service
        of those notices, is{" "}
        <strong>{"{{MARCO_CIVIL_NOTICE_PROCEDURE}}"}</strong>. This section has
        not yet been reviewed by Brazilian counsel and does not attempt to
        restate the statute.
      </p>

      <h2>Appeals</h2>
      <p>
        If we suspend or terminate your account or remove your content and you
        think we got it wrong, reply to the enforcement message or write to{" "}
        <strong>{"{{APPEAL_EMAIL}}"}</strong> within 30 days. Tell us what was
        actioned and why you believe it was a mistake. Where practical, someone
        who was not involved in the original decision reviews the appeal, and we
        target a response within <strong>{"{{APPEAL_SLA_DAYS}}"}</strong> days.
        Decisions on accounts terminated for child safety reasons are final.
      </p>
      <p>
        Appeals about actions a <em>server owner</em> took inside their own
        server — a kick, a ban, a deleted message — go to that server&apos;s
        owner, not to us. We do not overturn community moderation decisions
        unless the server itself is breaking these terms.
      </p>

      <h2>Our stuff</h2>
      <p>
        The pqp name, branding on pqp.gg, and hosted infrastructure are ours.
        The open-source codebase is available under its project licence —
        separate from the hosted service.
      </p>

      <h2>Voice and media</h2>
      <p>
        Voice uses WebRTC. In the configuration pqp.gg runs today, audio travels
        directly between participants and is not routed through, recorded by, or
        stored on our servers. Quality depends on your network and your peers,
        and we do not guarantee uninterrupted audio. See the{" "}
        <Link to="/privacy">Privacy Policy</Link> for what this means for your
        data.
      </p>

      <h2>Termination by you</h2>
      <p>
        You can stop using pqp.gg at any time. Self-serve account deletion is
        not built yet; to have your account and personal data deleted, write to{" "}
        <strong>{"{{PRIVACY_EMAIL}}"}</strong> and we will action it. See the{" "}
        <Link to="/privacy">Privacy Policy</Link> for what we delete and what we
        must keep.
      </p>

      <h2>Disclaimer</h2>
      <p>
        The service is provided &quot;as is.&quot; To the fullest extent allowed
        by law, we disclaim warranties of merchantability, fitness for a
        particular purpose, and non-infringement. We do not promise the service
        will be error-free or always available.
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
      <p>
        <strong>Nothing in these terms removes rights you have under mandatory
        law</strong> — including the Brazilian Consumer Protection Code (Lei nº
        8.078/1990) and the Lei Geral de Proteção de Dados (Lei nº 13.709/2018).
        Where a clause above conflicts with a right you cannot waive, that right
        wins and the rest of these terms still stand.
      </p>

      <h2>Indemnity</h2>
      <p>
        You agree to indemnify us against claims arising from your content or
        your misuse of the service, to the extent permitted by law.
      </p>

      <h2>Governing law and jurisdiction</h2>
      <p>
        These terms are governed by{" "}
        <strong>{"{{GOVERNING_LAW}}"}</strong>, and disputes are subject to the
        courts of <strong>{"{{FORUM_CITY_STATE}}"}</strong>. If you use pqp.gg
        as a consumer, mandatory rules may let you bring a claim in the courts
        of your own domicile regardless of that choice.
      </p>

      <h2>Privacy</h2>
      <p>
        Our <Link to="/privacy">Privacy Policy</Link> explains how we handle
        personal data. Our <Link to="/cookies">Cookie notice</Link> covers
        cookies and local storage.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. Continued use after the &quot;Last
        updated&quot; date means you accept the new terms. For changes that
        materially reduce your rights we will give notice in the app or by email
        before they take effect. If you disagree, stop using pqp.gg and ask us
        to delete your account.
      </p>

      <h2>Contact</h2>
      <ul>
        <li>
          General and legal: <strong>{"{{LEGAL_EMAIL}}"}</strong>
        </li>
        <li>
          Abuse, safety, and underage accounts:{" "}
          <strong>{"{{ABUSE_EMAIL}}"}</strong>
        </li>
        <li>
          Privacy and data rights: <strong>{"{{PRIVACY_EMAIL}}"}</strong>
        </li>
        <li>
          Support: <strong>{"{{SUPPORT_EMAIL}}"}</strong>
        </li>
      </ul>
    </LegalPage>
  );
}
