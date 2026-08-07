import { Link } from "react-router-dom";
import type { LegalDocument } from "./document";

/**
 * Source of truth for the Terms. `terms.pt-BR.tsx` is a translation of this
 * file and must move with it — see `document.tsx` for how that is enforced.
 */
export const termsEn: LegalDocument = {
  locale: "en",
  path: "/terms",
  title: "Terms of Service — pqp",
  description:
    "Terms for using the hosted pqp.gg service: what pqp actually is, eligibility (18+), acceptable use, moderation, reporting and takedowns.",
  heading: "Terms of Service",
  updated: "7 August 2026",
  sections: [
    {
      id: "intro",
      body: (
        <p>
          These terms cover the hosted service at <strong>pqp.gg</strong>, which
          is run by <strong>one person, not a company</strong>. &quot;We&quot;
          and &quot;us&quot; below mean that one person. By creating an account
          or using the app, you agree to these terms. Self-hosted copies of the
          open-source software are governed by the project licence and whatever
          terms you set for your own users — not these hosted terms.
        </p>
      ),
    },
    {
      id: "before-you-move",
      heading: "Read this before you move your friends here",
      body: (
        <>
          <p>
            pqp is a personal project, built for fun by one person in their
            spare time. There is no company behind it, no funding, no revenue,
            and no support team — the person who reads your email is the person
            who wrote the code. It is provided <strong>as is</strong>: there is
            no uptime guarantee, no service level of any kind, and no promise
            that pqp.gg will still be running next year. Features may change or
            disappear, and the whole thing may stop. We would give notice if we
            could, but we cannot promise even that.
          </p>
          <p>
            We put this at the top because moving a group of friends onto a chat
            service is a decision you should make with the real picture in front
            of you. The rest of this page is written the same way: what is
            actually true, including the parts that are not finished.
          </p>
        </>
      ),
    },
    {
      id: "age",
      heading: "You must be 18 or older",
      body: (
        <>
          <p>
            <strong>pqp.gg is for adults only.</strong> You may only create an
            account or use the service if you are{" "}
            <strong>18 years of age or older</strong>. There is no version of
            pqp.gg for minors, and no parental-consent path that makes an
            under-18 account acceptable. By signing up you confirm that you are
            18 or older and legally able to enter into these terms.
          </p>
          <p>
            If we learn that an account belongs to someone under 18, we will
            terminate it and delete the associated data, without notice and
            without appeal. We may do the same where we have a good-faith belief
            the account holder is under 18 — for example, from what they say in
            chat or from a report we receive.
          </p>
          <p>
            <strong>To report an account you believe belongs to a minor</strong>
            , write to <strong>contato@pqp.gg</strong> with the user tag (their{" "}
            <code>name#1234</code> handle), the server or DM where you saw them,
            and what led you to believe they are under 18. Reports about minors
            are handled ahead of everything else. You do not need an account to
            send one.
          </p>
          <p>
            We do not currently verify age with documents or a third-party
            age-assurance provider. Eligibility is enforced at sign-up by
            self-declaration and afterwards by enforcement on report — we say
            this plainly rather than implying a check we do not perform.
          </p>
        </>
      ),
    },
    {
      id: "service",
      heading: "The service",
      body: (
        <p>
          pqp is a real-time chat and voice product: servers, text and voice
          channels, direct messages, invites, and related features. It is free,
          and there are no paid tiers today. We may change, pause, or
          discontinue any of it.
        </p>
      ),
    },
    {
      id: "accounts",
      heading: "Accounts",
      body: (
        <>
          <p>
            You sign in through Clerk, a third-party identity provider. Clerk
            holds your login credentials and email address; pqp itself stores a
            display name, a <code>name#1234</code> handle, an avatar URL, and
            the domains of your verified email addresses. Keep your credentials
            safe. You are responsible for activity under your account. Provide
            accurate information and do not impersonate other people, brands, or
            pqp itself.
          </p>
          <p>
            One person, one account. Do not create accounts to evade a ban, and
            do not sell, rent, or transfer your account.
          </p>
        </>
      ),
    },
    {
      id: "acceptable-use",
      heading: "Acceptable use",
      body: (
        <>
          <p>Do not use pqp.gg to:</p>
          <ul>
            <li>
              Sexualise minors in any way, or share, request, or link to child
              sexual abuse material. This is the one rule with no warning step:
              it means immediate termination and, where the law requires it, a
              report to the competent authorities.
            </li>
            <li>
              Harass, threaten, stalk, or organise a pile-on against anyone;
              incite violence or self-harm
            </li>
            <li>
              Promote hate against people based on race, colour, ethnicity,
              national origin, religion, disability, sex, sexual orientation, or
              gender identity
            </li>
            <li>
              Share someone&apos;s private information without consent
              (doxxing), or share intimate images of someone without their
              consent
            </li>
            <li>Break the law, or plan or coordinate illegal activity</li>
            <li>
              Distribute malware, run phishing or fraud, spam, or scrape the
              service abusively
            </li>
            <li>
              Attempt to break into accounts, servers, or infrastructure, or
              evade rate limits and access controls
            </li>
            <li>Infringe others&apos; intellectual property or privacy</li>
            <li>
              Record voice conversations without the consent of the people in
              them, where consent is required by law
            </li>
            <li>
              Automate the service in a way that degrades it for other people
            </li>
          </ul>
          <p>
            Server owners and admins are responsible for the communities they
            run. Running a server whose apparent purpose is to break these rules
            is itself a violation.
          </p>
        </>
      ),
    },
    {
      id: "your-content",
      heading: "Your content",
      body: (
        <p>
          You keep ownership of messages, files, and other content you post. You
          grant us a limited, non-exclusive licence to host, store, transmit,
          and display that content so the product works — for example, showing
          your message history to the members of your server. That licence
          exists for operating the service and ends when the content is deleted,
          except for copies we must keep to comply with a legal obligation. You
          are responsible for what you post and for having the rights to post
          it.
        </p>
      ),
    },
    {
      id: "moderation",
      heading: "Moderation and enforcement",
      body: (
        <>
          <p>
            Most moderation on pqp happens inside a server, by the people who
            run it. Server owners and admins can:
          </p>
          <ul>
            <li>Delete messages in their channels</li>
            <li>Remove (kick) a member from the server</li>
            <li>
              Ban a member from the server, which removes them and blocks
              rejoining
            </li>
            <li>Change roles, and restrict who can post where</li>
          </ul>
          <p>
            Server-level actions are written to that server&apos;s audit log, so
            members with access can see who did what.
          </p>
          <p>
            Separately, we can act at the platform level when a report reaches
            us or we otherwise become aware of a problem. Depending on severity
            and history, that can mean: removing specific content, restricting
            an account&apos;s ability to post, removing a server from the hosted
            service, suspending an account, or terminating an account
            permanently. We aim to take the narrowest action that fixes the
            problem — but for content involving minors, credible threats of
            violence, or CSAM, the first action is termination.
          </p>
          <p>
            We can also suspend accounts or servers that put the service or
            other users at risk, including abuse of the infrastructure itself.
          </p>
        </>
      ),
    },
    {
      id: "reporting",
      heading: "Reporting abuse",
      body: (
        <>
          <p>
            To report content, a user, or a whole server, email{" "}
            <strong>contato@pqp.gg</strong>. Include:
          </p>
          <ul>
            <li>What you are reporting — a message, a user, a server, a DM</li>
            <li>
              Where it is: the server name, channel name, and the user tag (
              <code>name#1234</code>)
            </li>
            <li>Why it breaks these terms, in a sentence or two</li>
            <li>Screenshots if you have them, and roughly when it happened</li>
          </ul>
          <p>
            We are building an in-app report button; until it ships, email is
            the reporting channel. You can report without having an account.
          </p>
          <p>
            <strong>What happens next, honestly.</strong> One person reads the
            reports. There is no moderation team, no rota and no out-of-hours
            cover, so we are not going to publish response times we cannot keep.
            What is true is this: reports are read and acted on as fast as one
            person reasonably can, usually within a few days, and reports
            involving minors, imminent physical danger, or non-consensual
            intimate images go to the front of the queue. If we are away or
            swamped it takes longer. That is not a target we are quietly missing
            — it is the shape of a one-person project, and you should know it
            before you rely on us.
          </p>
          <p>
            <strong>One thing has no caveat.</strong> Content that sexualises a
            minor, and child sexual abuse material, are removed on sight, the
            account is terminated, and the matter is reported to the competent
            authorities. No queue, no timeline, no appeal.
          </p>
          <p>
            We will tell you the outcome where we can do so without exposing
            another user&apos;s personal data.
          </p>
          <p>
            Do not use reporting to harass someone. Repeated bad-faith reports
            are themselves a violation.
          </p>
        </>
      ),
    },
    {
      id: "copyright",
      heading: "Copyright and other legal notices",
      body: (
        <>
          <p>
            If you believe content on pqp.gg infringes your copyright or other
            rights, send a notice to <strong>contato@pqp.gg</strong> identifying
            the work, the exact location of the content, your contact details,
            and a statement that you are the rights holder or authorised to act
            for them. We will review it and remove content where the claim is
            substantiated.
          </p>
          <p>
            Court orders and other formal legal notices go to the same address.
            There is no registered office to serve papers at, because there is
            no company — pqp.gg is run by an individual in the United Kingdom.
            Content removal that the law of your country requires us to perform
            is something we will do; a notice that simply asserts a right is
            something we will read and judge.
          </p>
        </>
      ),
    },
    {
      id: "appeals",
      heading: "Appeals",
      body: (
        <>
          <p>
            If we suspend or terminate your account or remove your content and
            you think we got it wrong, reply to the enforcement message or write
            to <strong>contato@pqp.gg</strong> within 30 days. Tell us what was
            actioned and why you believe it was a mistake.
          </p>
          <p>
            We will not pretend an appeal reaches an independent reviewer: the
            person who made the first decision is the only person there is, and
            what they will do is look at it again with what you have told them.
            There is no promised turnaround. Decisions on accounts terminated
            for child safety reasons are final.
          </p>
          <p>
            Appeals about actions a <em>server owner</em> took inside their own
            server — a kick, a ban, a deleted message — go to that server&apos;s
            owner, not to us. We do not overturn community moderation decisions
            unless the server itself is breaking these terms.
          </p>
        </>
      ),
    },
    {
      id: "our-stuff",
      heading: "Our stuff",
      body: (
        <p>
          The pqp name, branding on pqp.gg, and hosted infrastructure are ours.
          The open-source codebase is available under its project licence —
          separate from the hosted service.
        </p>
      ),
    },
    {
      id: "voice",
      heading: "Voice and media",
      body: (
        <p>
          Voice uses WebRTC. In the configuration pqp.gg runs today, audio
          travels directly between participants and is not routed through,
          recorded by, or stored on our servers. That design has a practical
          ceiling: every person in a channel connects to every other one, so a
          busy voice channel gets heavy on everybody&apos;s connection. Quality
          depends on your network and your peers, and we do not guarantee
          uninterrupted audio. See the <Link to="/privacy">Privacy Policy</Link>{" "}
          for what this means for your data.
        </p>
      ),
    },
    {
      id: "termination",
      heading: "Termination by you",
      body: (
        <p>
          You can stop using pqp.gg at any time. To delete your account, use{" "}
          <strong>Delete my account</strong> in Settings, under &quot;Your
          data&quot;. It is permanent and there is no undo. See the{" "}
          <Link to="/privacy">Privacy Policy</Link> for what we delete and what
          we must keep.
        </p>
      ),
    },
    {
      id: "disclaimer",
      heading: "Disclaimer",
      body: (
        <p>
          The service is provided &quot;as is.&quot; To the fullest extent
          allowed by law, we disclaim warranties of merchantability, fitness for
          a particular purpose, and non-infringement. We do not promise the
          service will be error-free or always available. Keep your own copies
          of anything you would be upset to lose.
        </p>
      ),
    },
    {
      id: "liability",
      heading: "Limitation of liability",
      body: (
        <>
          <p>
            To the fullest extent allowed by law, pqp and its operator are not
            liable for indirect, incidental, special, or consequential damages,
            or for loss of data, profits, or goodwill arising from use of
            pqp.gg. The service is free, so our total liability for any claim
            related to it is limited to zero, and to whatever you have paid us
            if that ever changes.
          </p>
          <p>
            <strong>
              Nothing in these terms removes rights you have under mandatory
              law.
            </strong>{" "}
            If you are in Brazil, that includes the Consumer Protection Code
            (Lei nº 8.078/1990) and the Lei Geral de Proteção de Dados (Lei nº
            13.709/2018); if you are in the UK or the EU, it includes your
            consumer and data-protection rights there. Where a clause above
            conflicts with a right you cannot waive, that right wins and the
            rest of these terms still stand.
          </p>
        </>
      ),
    },
    {
      id: "indemnity",
      heading: "Indemnity",
      body: (
        <p>
          You agree to indemnify us against claims arising from your content or
          your misuse of the service, to the extent permitted by law.
        </p>
      ),
    },
    {
      id: "governing-law",
      heading: "Governing law and jurisdiction",
      body: (
        <p>
          pqp.gg is operated from the United Kingdom. These terms are governed
          by the <strong>laws of England and Wales</strong>, and disputes are
          subject to the courts of <strong>England and Wales</strong>. If you
          use pqp.gg as a consumer, mandatory rules may let you bring a claim in
          the courts of the country you live in regardless of that choice — and
          Brazilian users keep their rights under the Consumer Protection Code
          and the LGPD whichever country the operator sits in. We are not going
          to argue otherwise.
        </p>
      ),
    },
    {
      id: "privacy",
      heading: "Privacy",
      body: (
        <p>
          Our <Link to="/privacy">Privacy Policy</Link> explains how we handle
          personal data. Our <Link to="/cookies">Cookie notice</Link> covers
          cookies and local storage.
        </p>
      ),
    },
    {
      id: "changes",
      heading: "Changes",
      body: (
        <p>
          We may update these terms. Continued use after the &quot;Last
          updated&quot; date means you accept the new terms. For changes that
          materially reduce your rights we will give notice in the app or by
          email before they take effect. If you disagree, stop using pqp.gg and
          delete your account.
        </p>
      ),
    },
    {
      id: "contact",
      heading: "Contact",
      body: (
        <>
          <p>
            One address for all of it — support, abuse and safety reports,
            underage accounts, privacy requests, security disclosures, legal
            notices and appeals: <strong>contato@pqp.gg</strong>.
          </p>
          <p>
            It is one person&apos;s inbox, and that is on purpose. Five more
            addresses would mean five more inboxes nobody reads.
          </p>
        </>
      ),
    },
  ],
};
