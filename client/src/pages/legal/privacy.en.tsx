import { Link } from "react-router-dom";
import type { LegalDocument } from "./document";

/**
 * Source of truth for the Privacy Policy. `privacy.pt-BR.tsx` translates it.
 */
export const privacyEn: LegalDocument = {
  locale: "en",
  path: "/privacy",
  title: "Privacy Policy — pqp",
  description:
    "How pqp.gg handles personal data: what we collect, our legal bases, where it is processed, retention, and your rights under the LGPD and UK data protection law.",
  heading: "Privacy Policy",
  updated: "2 September 2026",
  sections: [
    {
      id: "intro",
      body: (
        <>
          <p>
            This policy explains what personal data <strong>pqp.gg</strong>{" "}
            collects, why, and what you can do about it. We have tried to
            describe the product as it actually works today, including the parts
            that are not finished — where a control does not exist yet, we say
            so instead of describing one we have not built.
          </p>
          <p>
            If you self-host pqp, you are the controller for your own instance.
            This document still describes what the software stores, so you can
            write your own policy from it.
          </p>
        </>
      ),
    },
    {
      id: "controller",
      heading: "Who is responsible for your data",
      body: (
        <p>
          <strong>The operator of pqp.gg</strong> is the controller: one person
          in the United Kingdom, running it as a personal project rather than a
          company. There is no privacy team and no appointed data protection
          officer — appointing one would be theatre for a project this size. The
          same person who wrote the code answers the data-protection questions,
          and there is one address for it: <strong>contato@pqp.gg</strong>.
          Wherever this policy says to write to us, that is the address and that
          is who reads it.
        </p>
      ),
    },
    {
      id: "which-law",
      heading: "Which law applies",
      body: (
        <>
          <p>
            This policy is written against the{" "}
            <strong>
              Lei Geral de Proteção de Dados (Lei nº 13.709/2018, LGPD)
            </strong>
            , because that is the law most of the people using pqp.gg are
            covered by. Because the operator is in the United Kingdom,{" "}
            <strong>
              UK data protection law — the UK GDPR and the Data Protection Act
              2018 — also applies
            </strong>
            .
          </p>
          <p>
            We are not going to maintain two lists that say almost the same
            thing. The rights described below are honoured for <em>everyone</em>
            , whichever of the two laws happens to grant them to you, and where
            one gives you something the other does not, you get it.
          </p>
        </>
      ),
    },
    {
      id: "age",
      heading: "Age",
      body: (
        <>
          <p>
            pqp.gg is for people <strong>18 and over</strong>. We do not
            knowingly process the personal data of children or adolescents. If
            you believe a minor is using pqp.gg, tell us at{" "}
            <strong>contato@pqp.gg</strong> and we will terminate the account
            and delete the data. See the <Link to="/terms">Terms of Service</Link>{" "}
            for the eligibility rule.
          </p>
          <p>
            <strong>How we ask, and what we keep.</strong> The first time you
            use the app after signing in, we ask for your{" "}
            <strong>date of birth</strong> — day, month and year — and you can
            answer only once. The server works out whether you are 18 yet.{" "}
            <strong>If you are, we do not keep the date</strong>: your account
            keeps the yes-or-no answer and the moment you gave it, and the date
            itself is never written to our database. If the answer is that you
            are under 18, the account is blocked from using pqp.gg and we do
            keep the date you entered, because it is the record an appeal would
            have to be decided on. Both the answer and the date, where there is
            one, live on your account, so deleting your account deletes them.
          </p>
          <p>
            This is a <strong>self-declaration that we enforce</strong>, not age
            verification. We do not ask for a document and we do not use an
            age-assurance provider, because that would mean holding far more
            personal data about you than an 18+ rule needs. An account blocked
            by this check can still download its data and delete itself: your
            rights do not depend on being welcome.
          </p>
        </>
      ),
    },
    {
      id: "what-we-collect",
      heading: "What we collect",
      body: (
        <>
          <p>
            <strong>Account and profile.</strong> Sign-in is handled by{" "}
            <a href="https://clerk.com" target="_blank" rel="noreferrer">
              Clerk
            </a>
            , a third-party identity provider.{" "}
            <strong>
              Clerk holds your email address and login credentials. We do not
              copy it into our own database
            </strong>{" "}
            — though nothing stops you typing it into a field yourself, such as
            your display name or a message, and if you do, it is stored like any
            other text you write. What we store on our side is: a Clerk user
            identifier, your display name, your <code>name#1234</code> tag,
            an optional public <code>@handle</code> if you claimed one, an
            avatar URL, an optional profile banner, the <em>domains</em> of
            your verified email addresses
            (for example <code>empresa.com.br</code>, used for company-domain
            server joins — never the mailbox itself), your DM privacy setting,
            and when the account was created. If the link that first brought
            you to pqp.gg carried campaign parameters (
            <code>utm_source</code>, <code>utm_medium</code>,{" "}
            <code>utm_campaign</code>, <code>gclid</code> or <code>ref</code>
            ), those values and the page
            you landed on are saved on the account once, at sign-up, and never
            changed afterwards, so we can tell which links bring people here.
            This uses no cookie and no third party (see the{" "}
            <Link to="/cookies">Cookie notice</Link>), and it is only ever
            read as a count per campaign, never as a list of people.
          </p>
          <p>
            <strong>Content you post.</strong> Message text, timestamps, edits,
            pins, replies, @-mentions, and emoji reactions. Messages are stored
            so history works when you reload, and so other members of a channel
            can read them. We also keep a per-channel &quot;last read&quot;
            marker so unread badges work.
          </p>
          <p>
            <strong>Communities.</strong> Servers you create or join, channel
            names and topics, your role (owner / admin / member), invite codes
            you create, and bans — including the free-text reason a moderator
            typed.
          </p>
          <p>
            <strong>Public profile.</strong> If you claim a unique{" "}
            <code>@handle</code>, we publish a thin page at{" "}
            <code>pqp.gg/@that-handle</code> that anyone on the internet can open
            without signing in: display name, avatar, optional banner, join
            month (not the day), public-community badges, approved depoimentos,
            and any game connection you marked public. It does not include
            your id, your <code>name#1234</code> tag, your email, or whether
            you are online. A listed community can have a similar poster at{" "}
            <code>pqp.gg/c/slug</code>: name, tagline, pictures, member count,
            never a member list. Unfurlers (WhatsApp, Twitter, and the rest)
            get Open Graph tags injected at the edge so the card is not a
            blank SPA.
          </p>
          <p>
            <strong>Game connections.</strong> Steam, Battle.net, and Twitch
            are optional. Connecting one is not a second login. We store the
            provider, that provider&apos;s user id, the display name and
            picture they gave us, an optional profile URL, the visibility you
            chose, and when you connected. Access tokens are used once to learn
            who you are, then discarded. The default visibility is people who
            already share a server or a friendship with you.{" "}
            <strong>Public</strong> also puts it on the public page, including a
            Steam profile URL if you opt in. Disconnecting deletes the row.
          </p>
          <p>
            <strong>Depoimentos.</strong> A friend can write a short note for
            your profile. It is not public until you approve it. The public page
            shows the newest six approved notes as a name, a picture, and
            (only if they claimed one) their handle — not their id or tag.
            Deleting your account removes notes you wrote from other people&apos;s
            pages, and removes the notes on yours.
          </p>
          <p>
            <strong>Files and images.</strong> When file attachments are
            enabled, we store the filename, type, size, and dimensions in our
            database, and the file itself in S3-compatible object storage.
            Attachments are <strong>            enabled</strong> on pqp.gg today. A profile banner uses the same
            storage. GIFs
            picked from the GIF search are stored as a link to the GIF provider,
            not as a copy. When image scanning is configured, a freshly uploaded
            image is checked before it is visible in a channel. A match can
            drop the file without a person reading it. That is a check of the
            file, not a decision about you as a person. Avatars and banners are
            not scanned today.
          </p>
          <p>
            <strong>Settings.</strong> Notification preferences, theme,
            mute-on-join and audio volumes are saved to your account so they
            follow you between devices, and mirrored in your browser&apos;s
            local storage. See the <Link to="/cookies">Cookie notice</Link>.
          </p>
          <p>
            <strong>Moderation records.</strong> Server owners and admins get an
            audit log of administrative actions in their server — who kicked,
            banned, changed a role, deleted someone else&apos;s message, renamed
            a channel, or exported the server. It records the actor, the action,
            the target id, an optional reason, and the previous value of
            whatever changed. It does not record message text.
          </p>
          <p>
            <strong>Link previews.</strong> When you post a link, our server
            fetches that page once to read its preview tags and caches the
            title, description, site name and preview image against the URL.
            That cache is keyed by the URL only — it does not record who posted
            it.
          </p>
          <p>
            <strong>Technical.</strong> Application logs of errors and
            connection events. These record a connection number and a user id;
            they do not record your IP address. Your IP address is read in
            memory, briefly, to enforce rate limits, and is not written to our
            database or our logs.
          </p>

          <h3>Site analytics</h3>
          <p>
            The marketing pages and the app use{" "}
            <strong>Cloudflare Web Analytics</strong> so we can tell whether
            anyone is arriving and whether the site is fast enough to use. It is
            cookieless: it stores nothing on your device and uses no persistent
            identifier, so it cannot recognise you on a later visit or follow
            you to another site.
          </p>
          <p>
            What it records is the page address, the page that referred you,
            your country, your browser and device type, and how quickly pages
            loaded. That is aggregate traffic measurement, not a profile — there
            is no way for us to look up an individual person in it, and it is
            never joined to your account.
          </p>
          <p>
            The script is injected by Cloudflare at the edge rather than bundled
            into the app, so you will not find it in our source code. Blocking
            it with a browser extension breaks nothing.
          </p>
          <p>
            The same pages also load <strong>Umami</strong>, hosted by its
            makers in the EU, for the same purpose: counting visits and seeing
            which pages people arrive on. It is cookieless too, stores nothing
            on your device, and uses no persistent identifier. It records the
            page address, the referring page, and your country, browser and
            device type, all of it aggregate. It never sees your account, and
            blocking it also breaks nothing.
          </p>
          <p>
            Two of them, because they answer slightly different questions and
            neither costs you anything to be measured by. If that changes, this
            paragraph changes with it.
          </p>

          <h3>Advertising measurement</h3>
          <p>
            pqp.gg buys a small amount of advertising, and it carries{" "}
            <strong>Google Ads conversion tracking</strong> so we can tell
            whether an ad produced an account and not just a click. This is the
            one thing on the site that is not cookieless, and we would rather
            say so plainly than bury it. Google&apos;s tag loads on every page of
            pqp.gg, and it sets first-party cookies on the pqp.gg domain (their
            names begin <code>_gcl_</code>) to remember that your visit came
            from an ad.
          </p>
          <p>
            One event is sent to Google, once: when an account is created, the
            tag reports that a sign-up happened. It carries no name, no email,
            no user id and nothing you typed. Google still sees your IP address
            and which page you loaded, which is what any third-party script
            sees. If you arrived from an ad, we also store the{" "}
            <code>gclid</code> on the account once, with the other campaign
            parameters. We do not upload account data to Google, we have not
            switched on enhanced conversions or any customer-data matching, and
            we run no remarketing or audience lists. Signing in again sends
            nothing, and neither does anything you do inside the app.
          </p>
          <p>
            Google is a third party here and handles what it receives, including
            your IP address, under its own terms. Blocking the tag with a
            browser extension, or blocking cookies for pqp.gg, breaks nothing:
            the product works exactly the same and the sign-up simply goes
            uncounted.
          </p>
          <p>
            This is true of the hosted pqp.gg and of nothing else. The tag is
            added at build time, and only when the build is given our
            advertising account id, so a self-hosted copy of pqp contacts no
            Google advertising server and sets no Google cookie.
          </p>
        </>
      ),
    },
    {
      id: "what-we-dont-do",
      heading: "What we do not do",
      body: (
        <ul>
          <li>
            <strong>No profile of you.</strong> There is no session recorder and
            no error-reporting service, and nothing we hold builds a picture of
            you as a person. The two analytics tools described under &quot;What
            we collect&quot; above count visits and cannot identify visitors.
            The single exception to &quot;nothing follows you between sites&quot;
            is the Google Ads conversion tag, described in the same place: its
            whole job is to connect one ad click to one sign-up, and it is the
            only thing on pqp.gg that a third party can read.
          </li>
          <li>
            <strong>No advertising profiles, and no selling data.</strong> We do
            advertise, and we count how many sign-ups the advertising produced,
            which is the conversion tag above. We build no advertising profiles,
            run no remarketing or audience lists, and do not sell or rent
            personal data.
          </li>
          <li>
            <strong>No device fingerprinting and no geolocation.</strong> We do
            not probe your device for a fingerprint and we do not look up your
            location.
          </li>
          <li>
            <strong>No voice recording.</strong> No call is recorded or stored
            by us on any path — see below.
          </li>
          <li>
            <strong>No stored IP addresses in our database.</strong> There is
            no IP address column on the pqp.gg API. Third parties listed below
            still see your IP when your browser talks to them. The Android
            download button on pqp.gg also sends a count to our operator
            dashboard, which rate-limits that count by IP for a minute.
          </li>
          <li>
            <strong>No automated decisions about you as a person.</strong>{" "}
            Nothing here profiles you or decides whether you may keep an
            account. Moderation of people is done by a person. If image
            scanning is on, a file can be dropped or flagged by that check
            before a person sees it. That is a check of the file.
          </li>
        </ul>
      ),
    },
    {
      id: "voice",
      heading: "Voice calls",
      body: (
        <>
          <p>
            In the configuration pqp.gg runs today, voice is{" "}
            <strong>peer-to-peer</strong>. Your audio goes directly from your
            device to the other people in the channel over WebRTC, encrypted end
            to end by the browser (DTLS-SRTP).{" "}
            <strong>
              It does not pass through our servers, and we could not record it
              if we wanted to.
            </strong>{" "}
            What our server handles is signalling only: who is in which voice
            channel, and the connection-setup messages the browsers exchange.
          </p>
          <p>Two honest caveats:</p>
          <ul>
            <li>
              <strong>STUN and TURN.</strong> To connect two devices behind home
              routers, browsers use STUN servers, and when a direct path is
              impossible (common on mobile networks) the encrypted audio is
              relayed through a <strong>TURN</strong> server. Those third
              parties see the IP addresses of the people on the call, and the
              TURN relay carries the media — but it is still encrypted between
              the participants, so the relay cannot listen to it. Our STUN/TURN
              providers today are <strong>Cloudflare Realtime TURN</strong>,
              then Metered / Open Relay if Cloudflare is not configured, then
              a static relay (ExpressTURN on pqp.gg) as the fallback, plus
              public STUN servers run by Google and Cloudflare.
            </li>
            <li>
              <strong>Large calls.</strong> Because every participant connects
              directly to every other one, this design only stretches so far
              before the connections get heavy. The software also supports a
              media server (SFU) for bigger channels, which <em>would</em> place
              audio on a third-party server. That mode is{" "}
              <strong>not enabled</strong> on pqp.gg. If we turn it on, we will
              update this page before we do.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "legal-bases",
      heading: "Why we process your data, and the legal basis",
      body: (
        <>
          <p>
            Here is what we actually use your data for. LGPD art. 7 says every
            one of these purposes has to rest on a specific legal basis, so we
            have named it in parentheses at the end of each one — but the plain
            sentence in front of it is the part that answers the question you
            actually have.
          </p>
          <ul>
            <li>
              <strong>Running pqp itself.</strong> Creating your account,
              delivering your messages, keeping your history so it is there when
              you reload, connecting your voice calls, and remembering your
              settings — the basic service you signed up for.{" "}
              <em>(This rests on our contract with you: art. 7, V.)</em>
            </li>
            <li>
              <strong>
                Keeping the service running, and keeping people from abusing it.
              </strong>{" "}
              Rate limits, blocking attacks, debugging problems, protecting
              other users from harm.{" "}
              <em>
                (Basis: our legitimate interest, art. 7, IX — weighed against
                your rights, and limited to what that actually needs.)
              </em>
            </li>
            <li>
              <strong>Enforcing our rules.</strong> Reviewing reports, and
              keeping ban and audit records so a moderation decision can be
              checked later instead of just taken on trust.{" "}
              <em>(Basis: legitimate interest, art. 7, IX.)</em>
            </li>
            <li>
              <strong>
                Acting on a credible threat to someone&apos;s life or physical
                safety
              </strong>
              , including a report involving a minor.{" "}
              <em>
                (Basis: protecting life or physical safety, art. 7, VII, and,
                where the law requires us to report it, legal obligation, art.
                7, II.)
              </em>
            </li>
            <li>
              <strong>Complying with the law.</strong> Responding to a lawful
              order, or keeping the records the law makes us keep.{" "}
              <em>(Basis: legal obligation, art. 7, II.)</em>
            </li>
            <li>
              <strong>
                Defending ourselves, or asserting a claim, if there is ever a
                dispute.
              </strong>{" "}
              <em>
                (Basis: exercising rights in a judicial, administrative or
                arbitration proceeding, art. 7, VI.)
              </em>
            </li>
            <li>
              <strong>Measuring our advertising.</strong> Counting how many
              sign-ups an ad campaign produced, through the Google Ads
              conversion tag described above. It counts an event. The event
              carries no name, email or user id. Google still sees your IP
              and the page, as set out under &quot;Advertising measurement&quot;.{" "}
              <em>
                (Basis: legitimate interest, art. 7, IX. Object by blocking the
                tag in your browser, or by writing to us.)
              </em>
            </li>
            <li>
              <strong>Anything optional you switch on</strong>, like desktop
              notifications, which your browser asks you to allow separately,
              or a game account you choose to connect.{" "}
              <em>
                (Basis: your consent, art. 7, I — withdraw it any time in
                Settings or in your browser.)
              </em>
            </li>
          </ul>
          <p>
            Under UK law the same eight activities rest on the equivalent bases
            in UK GDPR art. 6 — contract, legitimate interests, legal
            obligation, vital interests and consent, in that order. The
            processing is the same either way; only the article numbers change.
          </p>
          <p>
            Where we rely on legitimate interests, you can object — write to{" "}
            <strong>contato@pqp.gg</strong> and we will look at the specific
            processing you are objecting to.
          </p>
        </>
      ),
    },
    {
      id: "who-sees",
      heading: "Who else sees your data",
      body: (
        <>
          <p>
            We use third-party services to run pqp.gg. They process data on our
            instructions and for no other purpose:
          </p>
          <ul>
            <li>
              <strong>Clerk</strong> — authentication. Holds your email and
              credentials.
            </li>
            <li>
              <strong>Fly.io</strong> — application servers and the Postgres
              database, in{" "}
              <strong>São Paulo, Brazil (Fly region gru)</strong>.
            </li>
            <li>
              <strong>Umami</strong> — cookieless visit counts, hosted by its
              makers in the EU. Set out under &quot;Site analytics&quot; above.
            </li>
            <li>
              <strong>Cloudflare</strong> — serves the web app and the marketing
              site. Cloudflare Web Analytics, if enabled on the zone, is
              injected at their edge rather than bundled in our source.
            </li>
            <li>
              <strong>Cloudflare R2</strong> — object storage for file
              attachments, if attachments are enabled. Your browser uploads and
              downloads attachment bytes <em>directly</em> to that storage using
              short-lived signed links, so the storage provider sees your IP
              address while a file transfers.
            </li>
            <li>
              <strong>Cloudflare Realtime TURN</strong>, Metered / Open Relay,
              or ExpressTURN as fallback, plus Google and Cloudflare public
              STUN — voice connection setup and relay, as described above.
            </li>
          </ul>
          <p>Some third parties are contacted by your browser directly:</p>
          <ul>
            <li>
              <strong>Google Fonts</strong> — the site&apos;s typefaces load
              from Google&apos;s CDN on every page, so Google sees your IP
              address and which page you loaded.
            </li>
            <li>
              <strong>KLIPY, GIPHY and Tenor</strong> — GIF search runs through
              our server and is answered by KLIPY (so the provider sees the
              search term from us, not from you), but the GIF image itself
              loads straight from the provider&apos;s CDN, so it sees the IP
              address of everyone who views it in the channel. GIFs picked
              before the switch to KLIPY still load from GIPHY or Tenor.
            </li>
            <li>
              <strong>DiceBear</strong> — the preset avatar images in Settings
              load from their service.
            </li>
            <li>
              <strong>Google Ads</strong> loads its conversion tag on every page
              of pqp.gg, so Google sees your IP address and which page you
              loaded, and it is told once when an account is created. Set out in
              full under &quot;Advertising measurement&quot; above.
            </li>
            <li>
              <strong>Steam, Battle.net, and Twitch</strong> — only if you
              click Connect. Your browser goes to that provider and comes back
              with proof of who you are. We do not keep their access tokens.
            </li>
            <li>
              <strong>GitHub Sponsors</strong> and your bank, if you donate —
              those payments happen on their sites, not on pqp. We do not
              receive a list of who gave.
            </li>
            <li>
              <strong>The Android download counter</strong> on pqp.gg posts a
              one-byte beacon to our operator dashboard when you tap the APK
              button. It carries no account. The dashboard rate-limits by IP
              for a minute.
            </li>
          </ul>
          <p>
            We deliberately <em>do not</em> hot-link link-preview images: those
            are proxied through our server, so opening a channel never tells the
            linked site who you are.
          </p>
          <p>
            We also disclose data when a valid legal order requires it, or where
            it is necessary to protect someone from serious harm. We do not sell
            personal data.
          </p>
        </>
      ),
    },
    {
      id: "where-processed",
      heading: "Where your data is processed",
      body: (
        <>
          <p>
            <strong>
              Your data is processed in several countries, and probably not
              yours.
            </strong>{" "}
            Clerk, Cloudflare, our object-storage and STUN/TURN providers, and
            Google Fonts operate globally and typically process data in the
            United States and Europe. The application servers and database run
            on <strong>Fly.io</strong> in{" "}
            <strong>São Paulo, Brazil (Fly region gru)</strong>. The person who
            operates pqp.gg is in the United Kingdom, so anything handled by a
            human is handled there.
          </p>
          <p>
            The honest basis for those transfers: these are ordinary commercial
            services, used on the published terms each of them offers, and it is
            those terms that the transfers rest on. There is no bespoke transfer
            agreement negotiated for pqp, because there is no company to sign
            one and no lawyer to draft it. The database already runs in Brazil, so
            your messages are not routinely leaving the country — but the person
            who reads a report or answers a deletion request is in the UK, and
            that is a transfer too.
          </p>
        </>
      ),
    },
    {
      id: "retention",
      heading: "How long we keep things",
      body: (
        <>
          <ul>
            <li>
              <strong>Account and profile</strong> — until the account is
              deleted.
            </li>
            <li>
              <strong>The 18+ declaration</strong> — the yes-or-no answer and
              when you gave it, until the account is deleted. The date of birth
              itself is kept only where the answer was that you are under 18.
            </li>
            <li>
              <strong>Messages in a server</strong> — indefinitely by default.
              Each server owner can set a{" "}
              <strong>message retention window</strong> for their server, after
              which a daily job deletes messages older than that window. Pinned
              messages are exempt. The default is no window, so nothing is
              deleted unless the owner asks for it.
            </li>
            <li>
              <strong>Direct messages and group DMs</strong> — kept
              indefinitely.{" "}
              <strong>Server retention windows do not apply to DMs.</strong>{" "}
              Removing a DM from your sidebar hides it from your view; it does
              not delete the conversation for the other person. Deleting
              individual messages you sent does delete them.
            </li>
            <li>
              <strong>Attachments</strong> — as long as the message they belong
              to. Once the message is gone, an hourly job deletes the stored
              file.
            </li>
            <li>
              <strong>Server audit logs</strong> — 90 days, then automatically
              deleted.
            </li>
            <li>
              <strong>Link-preview cache</strong> — refreshed after 7 days;
              entries are not currently purged. They contain page metadata, not
              personal data about you.
            </li>
            <li>
              <strong>Service status samples</strong> — 30 days. These contain
              no user or server information.
            </li>
            <li>
              <strong>Bans</strong> — kept until the server owner lifts them, so
              that a ban survives the banned person leaving.
            </li>
          </ul>
          <p>
            <strong>What survives your account being deleted.</strong> Deleting
            your account removes your profile, your settings and every message
            you wrote, anywhere. A few records stay, each because the law allows
            data to be kept where it is needed to comply with a legal obligation
            or to exercise rights in a proceeding (LGPD art. 16; the UK GDPR has
            the same carve-out in art. 17(3)):
          </p>
          <ul>
            <li>
              <strong>Audit entries for moderation actions you took</strong> in
              someone else&apos;s server. The entry stays and your user id is
              removed from it, and the log is still deleted after 90 days like
              every other entry. It is the only record that a moderator deleted
              a message or banned a member; if deleting an account erased it,
              abusing a server would be one click away from being erased too.
            </li>
            <li>
              <strong>Bans you issued against other people</strong>, with your
              id removed. That record is a fact about the person who was banned
              and about the server, not about you — removing it would silently
              readmit everyone you had ever banned.
            </li>
            <li>
              <strong>Reports other people filed about you</strong>, including
              the copy of the reported content kept as evidence, with your id
              removed. A report has to outlive what it points at, or deleting
              your account would be a way to destroy the record of your own
              conduct. Reports that have been resolved are deleted after 90
              days.
            </li>
            <li>
              <strong>Reports you filed about other people</strong>, with your
              id removed. Those are records of somebody else&apos;s conduct, and
              an open queue must not empty itself because the person who
              reported it left.
            </li>
          </ul>
          <p>
            Beyond those, we may keep the minimum needed to comply with a legal
            obligation, or to exercise rights in a proceeding.
          </p>
        </>
      ),
    },
    {
      id: "rights",
      heading: "Your rights, and how to use them",
      body: (
        <>
          <p>
            LGPD art. 18 gives you the rights below, and UK GDPR arts. 15–21
            give you the same ones under different names. The two heaviest —{" "}
            <strong>
              getting a copy of your data, and deleting your account
            </strong>{" "}
            — are self-serve in the app, in <strong>Settings</strong> under{" "}
            <strong>&quot;Your data&quot;</strong>. Others are self-serve
            elsewhere in Settings, and the rest are handled by a person. Where a
            control does not exist, we say so rather than describe a button we
            have not built.
          </p>
          <ul>
            <li>
              <strong>
                Confirmation that we process your data, and access to it (art.
                18, I and II)
              </strong>{" "}
              — self-serve: <strong>Download my data</strong> in Settings, under
              &quot;Your data&quot;, builds a file of the account data, settings
              and messages we hold about you, including your 18+ declaration.
              For anything that file does not cover, email{" "}
              <strong>contato@pqp.gg</strong>.
            </li>
            <li>
              <strong>
                Correction of incomplete or out-of-date data (art. 18, III)
              </strong>{" "}
              — self-serve: change your display name, tag, public handle, avatar,
              banner and settings in Settings inside the app. For anything you cannot
              change there, email us.
            </li>
            <li>
              <strong>
                Anonymisation, blocking or deletion of unnecessary or excessive
                data (art. 18, IV)
              </strong>{" "}
              — email us describing what you want removed. You can also delete
              your own messages one by one in the app, or delete the whole
              account yourself — see art. 18, VI below.
            </li>
            <li>
              <strong>Portability (art. 18, V)</strong> — self-serve:{" "}
              <strong>Download my data</strong> gives you one structured,
              machine-readable JSON file. It holds your profile, your settings,
              your 18+ declaration, the servers you are in and your role in
              each, every message you wrote with the channel and server it was
              in and the files attached to it, linked game accounts, the
              conversations you took part
              in, who you have blocked, reports you filed, and moderation
              actions you took. It does not yet include your public{" "}
              <code>@handle</code>, your banner, or depoimentos. For those,
              email us. Very large accounts are capped, and the file
              says so when it has been cut short. (Server <em>owners</em> can
              also export a whole server from Server Settings, but that is an
              owner tool covering everyone&apos;s messages in that server — it
              is not a personal data export.)
            </li>
            <li>
              <strong>
                Deletion of data processed with consent (art. 18, VI)
              </strong>{" "}
              — self-serve: <strong>Delete my account</strong> in Settings,
              under &quot;Your data&quot;. You confirm by typing your own{" "}
              <code>name#1234</code> tag. It is permanent, there is no undo and no backup to restore
              from, and it is real deletion rather than a hidden account: your
              profile, settings, every message you wrote anywhere, your
              reactions, mentions, read markers, memberships, conversation
              participation, invites you created and the files you uploaded all
              go, and your account at Clerk is deleted too. A few moderation
              records stay behind — see &quot;What survives your account being
              deleted&quot; above. <strong>One thing stops it:</strong> if you
              still own a server that other people are in, we refuse and name
              those servers, because taking the server with you would destroy
              everyone else&apos;s messages in it to serve your request.
              Transfer the server to another member, or delete it, and then
              delete your account. A server nobody else is in is not a problem —
              it goes with the account. For anything this does not cover, email{" "}
              <strong>contato@pqp.gg</strong>.
            </li>
            <li>
              <strong>
                Information about who we share data with (art. 18, VII)
              </strong>{" "}
              — the list is in &quot;Who else sees your data&quot; above; write
              to us for more detail.
            </li>
            <li>
              <strong>
                Information about refusing consent and the consequences (art.
                18, VIII)
              </strong>{" "}
              — the only consent-based features are optional ones like desktop
              notifications. Refusing them turns that feature off and nothing
              else.
            </li>
            <li>
              <strong>Withdrawing consent (art. 18, IX)</strong> — turn the
              feature off in Settings or revoke the permission in your browser.
            </li>
          </ul>
          <p>
            <strong>What your export leaves out, and why.</strong> It contains
            the messages <em>you</em> wrote. It does not contain messages other
            people wrote, including the other half of your direct messages.
            Those words are their personal data rather than yours — a right of
            access is a right of access to data about <em>you</em>, and a
            message somebody else wrote is that person&apos;s own expression.
            Leaving it out costs you very little: you can still read every one
            of those messages in the app, exactly as you always could. What
            changes is only whether somebody else&apos;s words become a file
            that can be forwarded, published or handed to a third party in one
            action. For the same reason, a report you filed lists what you said
            and who you reported, but not the copy of the content you reported.
            In place of a transcript, the file lists every conversation you were
            part of, who else was in it, when it last saw traffic and how many
            of the messages were yours. If you genuinely need the other side — a
            court case, a harassment complaint — write to{" "}
            <strong>contato@pqp.gg</strong>, and that request is weighed by
            hand. There is no self-serve route to another person&apos;s
            messages, and there should not be one.
          </p>
          <p>
            <strong>How to make a request.</strong> Email{" "}
            <strong>contato@pqp.gg</strong> from the email address on your
            account, saying what you want. We may ask for information to confirm
            it is really you — we will not ask for more than we need. LGPD art.
            19 gives us up to <strong>15 days</strong> for a complete response
            and UK law allows a month; we work to the shorter one. These are
            statutory limits rather than a service level we invented, and they
            are the only deadlines on this site that we do not get to set.
          </p>
          <p>
            <strong>What we still cannot do.</strong> Deleting your account{" "}
            <em>does</em> take the messages you wrote out of other people&apos;s
            conversations, including their direct messages with you. The honest
            cost is that their side of those threads is left with gaps where
            your half of the conversation was, and there is no way to give
            somebody erasure without that. What we cannot reach is a copy that
            has already left our systems: your messages will still be in an
            export a server owner ran before you left, and in anything another
            member screenshotted.
          </p>
          <p>
            You also have the right to complain to a regulator if you think we
            have handled your data wrongly: in Brazil the{" "}
            <strong>ANPD (Autoridade Nacional de Proteção de Dados)</strong>, in
            the UK the{" "}
            <strong>Information Commissioner&apos;s Office (ICO)</strong>.
          </p>
        </>
      ),
    },
    {
      id: "controls",
      heading: "Controls you have in the app right now",
      body: (
        <ul>
          <li>
            <strong>Blocking.</strong> Blocking someone stops either of you
            opening or sending direct messages to the other, and stops their
            messages notifying you. Be aware of the limit:{" "}
            <strong>blocking is not invisibility</strong> — in a server you both
            belong to, they can still see the messages you post there, and you
            will still see that they posted, collapsed.
          </li>
          <li>
            <strong>DM privacy.</strong> Choose who can start a DM with you:
            everyone, only people who share a server with you (the default), or
            nobody. It governs new conversations; it does not close existing
            ones.
          </li>
          <li>
            <strong>Deleting your own messages</strong>, and leaving any server.
          </li>
          <li>
            <strong>Downloading your data, and deleting your account</strong> —
            in Settings, under &quot;Your data&quot;. Both are described above.
          </li>
          <li>
            <strong>Public handle and game connections.</strong> Claiming a
            handle is optional. Connection visibility is hidden, shared, or
            public. Disconnecting a game account deletes that row.
          </li>
        </ul>
      ),
    },
    {
      id: "security",
      heading: "Security",
      body: (
        <p>
          Traffic is encrypted in transit. Voice audio is encrypted between
          participants. Attachment links are short-lived and signed rather than
          public. Our server refuses to fetch link previews from internal
          network addresses. No system is perfectly secure, and this one is
          maintained by one person with no security team behind them — if you
          find a vulnerability, please tell us at{" "}
          <strong>contato@pqp.gg</strong> before you tell anyone else. If a
          breach creates a real risk to you, we will tell you and the relevant
          regulator, as LGPD art. 48 and UK GDPR arts. 33–34 require.
        </p>
      ),
    },
    {
      id: "self-hosted",
      heading: "Self-hosted instances",
      body: (
        <p>
          If you run pqp yourself, you choose the database, the Clerk
          application, and the hosting, and you are the controller for your
          users. pqp.gg does not receive your users&apos; data. Our advertising
          does not reach your copy either: the Google Ads conversion tag
          described above is added to the pqp.gg build alone, so a self-hosted
          instance ships without it. Tell your members how you handle their
          information.
        </p>
      ),
    },
    {
      id: "changes",
      heading: "Changes",
      body: (
        <p>
          We may update this policy. The &quot;Last updated&quot; date at the
          top will change, and we will give notice in the app before changes
          that materially affect you take effect.
        </p>
      ),
    },
    {
      id: "contact",
      heading: "Contact",
      body: (
        <p>
          Privacy requests, abuse and safety, security reports, and anything
          else on this page: <strong>contato@pqp.gg</strong>. One address, read
          by the one person who runs pqp.gg.
        </p>
      ),
    },
  ],
};
