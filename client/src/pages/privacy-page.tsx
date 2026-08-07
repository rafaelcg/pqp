import { Link } from "react-router-dom";
import { LegalPage } from "@/components/marketing/legal-page";

export function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy — pqp"
      description="How pqp.gg handles personal data under the LGPD: what we collect, our legal bases, international transfers, retention, and your art. 18 rights."
      path="/privacy"
      heading="Privacy Policy"
      updated="{{EFFECTIVE_DATE}}"
    >
      <p>
        This policy explains what personal data <strong>pqp.gg</strong> collects,
        why, and what you can do about it. It is written against the{" "}
        <strong>Lei Geral de Proteção de Dados (Lei nº 13.709/2018, LGPD)</strong>
        . We have tried to describe the product as it actually works today,
        including the parts that are not finished — where a control does not
        exist yet, we say so instead of describing one we have not built.
      </p>
      <p>
        If you self-host pqp, you are the <em>controlador</em> for your own
        instance. This document still describes what the software stores, so you
        can write your own policy from it.
      </p>

      <h2>Who is responsible for your data</h2>
      <ul>
        <li>
          <strong>Controlador (controller):</strong>{" "}
          <strong>{"{{LEGAL_ENTITY_NAME}}"}</strong>, CNPJ{" "}
          <strong>{"{{LEGAL_ENTITY_CNPJ}}"}</strong>,{" "}
          <strong>{"{{LEGAL_ENTITY_ADDRESS}}"}</strong>
        </li>
        <li>
          <strong>Encarregado pelo tratamento de dados pessoais (LGPD art.
          41):</strong> <strong>{"{{DPO_NAME}}"}</strong> —{" "}
          <strong>{"{{DPO_EMAIL}}"}</strong>
        </li>
        <li>
          <strong>General privacy contact:</strong>{" "}
          <strong>{"{{PRIVACY_EMAIL}}"}</strong>
        </li>
      </ul>
      <p>
        The encarregado is the person you write to about your rights, and the
        point of contact for the ANPD.
      </p>

      <h2>Age</h2>
      <p>
        pqp.gg is for people <strong>18 and over</strong>. We do not knowingly
        process the personal data of children or adolescents. If you believe a
        minor is using pqp.gg, tell us at{" "}
        <strong>{"{{ABUSE_EMAIL}}"}</strong> and we will terminate the account
        and delete the data. See the <Link to="/terms">Terms of Service</Link>{" "}
        for the eligibility rule.
      </p>

      <h2>What we collect</h2>
      <p>
        <strong>Account and profile.</strong> Sign-in is handled by{" "}
        <a href="https://clerk.com" target="_blank" rel="noreferrer">
          Clerk
        </a>
        , a third-party identity provider. <strong>Clerk holds your email
        address and login credentials — our database does not.</strong> What we
        store on our side is: a Clerk user identifier, your display name, your{" "}
        <code>name#1234</code> handle, an avatar URL, the{" "}
        <em>domains</em> of your verified email addresses (for example{" "}
        <code>empresa.com.br</code>, used for company-domain server joins — never
        the mailbox itself), your DM privacy setting, and when the account was
        created.
      </p>
      <p>
        <strong>Content you post.</strong> Message text, timestamps, edits, pins,
        replies, @-mentions, and emoji reactions. Messages are stored so history
        works when you reload, and so other members of a channel can read them.
        We also keep a per-channel &quot;last read&quot; marker so unread badges
        work.
      </p>
      <p>
        <strong>Communities.</strong> Servers you create or join, channel names
        and topics, your role (owner / admin / member), invite codes you create,
        and bans — including the free-text reason a moderator typed.
      </p>
      <p>
        <strong>Files and images.</strong> When file attachments are enabled, we
        store the filename, type, size, and dimensions in our database, and the
        file itself in S3-compatible object storage. Attachments are{" "}
        <strong>{"{{ATTACHMENTS_STATUS}}"}</strong> on pqp.gg today. GIFs picked
        from the GIF search are stored as a link to the GIF provider, not as a
        copy.
      </p>
      <p>
        <strong>Settings.</strong> Notification preferences, theme, mute-on-join
        and audio volumes are saved to your account so they follow you between
        devices, and mirrored in your browser&apos;s local storage. See the{" "}
        <Link to="/cookies">Cookie notice</Link>.
      </p>
      <p>
        <strong>Moderation records.</strong> Server owners and admins get an
        audit log of administrative actions in their server — who kicked, banned,
        changed a role, deleted someone else&apos;s message, renamed a channel,
        or exported the server. It records the actor, the action, the target id,
        an optional reason, and the previous value of whatever changed. It does
        not record message text.
      </p>
      <p>
        <strong>Link previews.</strong> When you post a link, our server fetches
        that page once to read its preview tags and caches the title,
        description, site name and preview image against the URL. That cache is
        keyed by the URL only — it does not record who posted it.
      </p>
      <p>
        <strong>Technical.</strong> Application logs of errors and connection
        events. These record a connection number and a user id; they do not
        record your IP address. Your IP address is read in memory, briefly, to
        enforce rate limits, and is not written to our database or our logs.
      </p>

      <h2>What we do not do</h2>
      <ul>
        <li>
          <strong>No analytics or tracking.</strong> There is no analytics SDK,
          no product-analytics tool, no advertising pixel, no session recorder,
          and no error-reporting service in the app or the marketing site. We do
          not measure you.
        </li>
        <li>
          <strong>No advertising and no selling data.</strong> We do not build
          advertising profiles and we do not sell or rent personal data.
        </li>
        <li>
          <strong>No device fingerprinting and no geolocation.</strong> We do not
          probe your device for a fingerprint and we do not look up your
          location.
        </li>
        <li>
          <strong>No voice recording.</strong> No call is recorded or stored by
          us on any path — see below.
        </li>
        <li>
          <strong>No stored IP addresses.</strong> There is no IP address column
          anywhere in our database.
        </li>
        <li>
          <strong>No automated decisions about you.</strong> Nothing here
          profiles you or decides anything about you automatically, so LGPD art.
          20 review does not arise. Moderation decisions are made by people.
        </li>
      </ul>

      <h2>Voice calls</h2>
      <p>
        In the configuration pqp.gg runs today, voice is{" "}
        <strong>peer-to-peer</strong>. Your audio goes directly from your device
        to the other people in the channel over WebRTC, encrypted end to end by
        the browser (DTLS-SRTP). <strong>It does not pass through our servers,
        and we could not record it if we wanted to.</strong> What our server
        handles is signalling only: who is in which voice channel, and the
        connection-setup messages the browsers exchange.
      </p>
      <p>Two honest caveats:</p>
      <ul>
        <li>
          <strong>STUN and TURN.</strong> To connect two devices behind home
          routers, browsers use STUN servers, and when a direct path is
          impossible (common on mobile networks) the encrypted audio is relayed
          through a <strong>TURN</strong> server. Those third parties see the IP
          addresses of the people on the call, and the TURN relay carries the
          media — but it is still encrypted between the participants, so the
          relay cannot listen to it. Our STUN/TURN providers today are{" "}
          <strong>{"{{TURN_PROVIDER}}"}</strong>, plus public STUN servers run by
          Google and Cloudflare.
        </li>
        <li>
          <strong>Large calls.</strong> The software also supports a media server
          (SFU) for bigger channels, which <em>would</em> place audio on a
          third-party server. That mode is <strong>not enabled</strong> on
          pqp.gg. If we turn it on, we will update this page before we do.
        </li>
      </ul>

      <h2>Why we process your data, and the legal basis</h2>
      <p>
        Under LGPD art. 7, every processing activity needs a basis. Ours:
      </p>
      <ul>
        <li>
          <strong>Running the service</strong> — creating your account,
          delivering messages, storing history, connecting voice calls, keeping
          your settings.{" "}
          <em>Basis: execution of a contract with you (art. 7, V).</em>
        </li>
        <li>
          <strong>Security, anti-abuse and reliability</strong> — rate limiting,
          blocking attacks, debugging, protecting other users.{" "}
          <em>
            Basis: legitimate interests (art. 7, IX), balanced against your
            rights and limited to what the purpose needs.
          </em>
        </li>
        <li>
          <strong>Moderation and enforcing our rules</strong> — reviewing
          reports, keeping ban and audit records so enforcement is reviewable.{" "}
          <em>Basis: legitimate interests (art. 7, IX).</em>
        </li>
        <li>
          <strong>Responding to imminent danger</strong> — acting on credible
          threats to someone&apos;s life or physical safety, including reports
          involving minors.{" "}
          <em>
            Basis: protection of life or physical safety (art. 7, VII), and legal
            obligation (art. 7, II) where reporting is required.
          </em>
        </li>
        <li>
          <strong>Complying with the law and answering the authorities</strong> —
          responding to lawful orders, tax and accounting duties.{" "}
          <em>Basis: compliance with a legal or regulatory obligation (art. 7,
          II).</em>
        </li>
        <li>
          <strong>Defending or exercising rights in a dispute</strong>.{" "}
          <em>
            Basis: regular exercise of rights in judicial, administrative or
            arbitration proceedings (art. 7, VI).
          </em>
        </li>
        <li>
          <strong>Optional extras you switch on</strong> — desktop notifications,
          for example, which your browser asks you to allow.{" "}
          <em>Basis: your consent (art. 7, I), which you can withdraw at any
          time in Settings or in your browser.</em>
        </li>
      </ul>
      <p>
        Where we rely on legitimate interests, you can object — write to the
        encarregado and we will look at the specific processing you are objecting
        to.
      </p>

      <h2>Who else sees your data</h2>
      <p>
        We use operators (<em>operadores</em>) to run the service. They process
        data on our instructions and for no other purpose:
      </p>
      <ul>
        <li>
          <strong>Clerk</strong> — authentication. Holds your email and
          credentials.
        </li>
        <li>
          <strong>{"{{HOSTING_PROVIDER}}"}</strong> — application servers and the
          Postgres database, in <strong>{"{{HOSTING_REGION}}"}</strong>.
        </li>
        <li>
          <strong>Cloudflare</strong> — serves the web app and the marketing
          site.
        </li>
        <li>
          <strong>{"{{OBJECT_STORAGE_PROVIDER}}"}</strong> — object storage for
          file attachments, if attachments are enabled. Your browser uploads and
          downloads attachment bytes <em>directly</em> to that storage using
          short-lived signed links, so the storage provider sees your IP address
          while a file transfers.
        </li>
        <li>
          <strong>{"{{TURN_PROVIDER}}"}</strong>, plus Google and Cloudflare
          public STUN — voice connection setup and relay, as described above.
        </li>
      </ul>
      <p>Some third parties are contacted by your browser directly:</p>
      <ul>
        <li>
          <strong>Google Fonts</strong> — the site&apos;s typefaces load from
          Google&apos;s CDN on every page, so Google sees your IP address and
          which page you loaded.
        </li>
        <li>
          <strong>GIPHY and Tenor</strong> — GIF search runs through our server
          (so the provider sees the search term from us, not from you), but the
          GIF image itself loads straight from their CDN, so they see the IP
          address of everyone who views it in the channel.
        </li>
        <li>
          <strong>DiceBear</strong> — the preset avatar images in Settings load
          from their service.
        </li>
      </ul>
      <p>
        We deliberately <em>do not</em> hot-link link-preview images: those are
        proxied through our server, so opening a channel never tells the linked
        site who you are.
      </p>
      <p>
        We also disclose data when a valid legal order requires it, or where it
        is necessary to protect someone from serious harm. We do not sell
        personal data.
      </p>

      <h2>International transfers</h2>
      <p>
        <strong>Some of your data is processed outside Brazil.</strong> Clerk,
        Cloudflare, our object-storage and STUN/TURN providers, and Google Fonts
        operate globally and typically process data in the United States and
        Europe. Our application servers and database run on{" "}
        <strong>{"{{HOSTING_PROVIDER}}"}</strong> in{" "}
        <strong>{"{{HOSTING_REGION}}"}</strong>; where that region is outside
        Brazil, your messages and account data are stored abroad.
      </p>
      <p>
        We are moving the application and database to a{" "}
        <strong>São Paulo</strong> region — target{" "}
        <strong>{"{{BR_MIGRATION_TARGET}}"}</strong> — so that message content
        and account data are stored in Brazil. Third-party services such as Clerk
        will still be international.
      </p>
      <p>
        International transfers are made on the basis of{" "}
        <strong>{"{{TRANSFER_SAFEGUARD}}"}</strong> under LGPD art. 33. Write to
        the encarregado if you want details of the safeguards for a specific
        provider.
      </p>

      <h2>How long we keep things</h2>
      <ul>
        <li>
          <strong>Account and profile</strong> — until the account is deleted.
        </li>
        <li>
          <strong>Messages in a server</strong> — indefinitely by default. Each
          server owner can set a <strong>message retention window</strong> for
          their server, after which a daily job deletes messages older than that
          window. Pinned messages are exempt. The default is no window, so
          nothing is deleted unless the owner asks for it.
        </li>
        <li>
          <strong>Direct messages and group DMs</strong> — kept indefinitely.{" "}
          <strong>Server retention windows do not apply to DMs.</strong> Removing
          a DM from your sidebar hides it from your view; it does not delete the
          conversation for the other person. Deleting individual messages you
          sent does delete them.
        </li>
        <li>
          <strong>Attachments</strong> — as long as the message they belong to.
          Once the message is gone, an hourly job deletes the stored file.
        </li>
        <li>
          <strong>Server audit logs</strong> — 90 days, then automatically
          deleted.
        </li>
        <li>
          <strong>Link-preview cache</strong> — refreshed after 7 days; entries
          are not currently purged. They contain page metadata, not personal
          data about you.
        </li>
        <li>
          <strong>Service status samples</strong> — 30 days. These contain no
          user or server information.
        </li>
        <li>
          <strong>Bans</strong> — kept until the server owner lifts them, so that
          a ban survives the banned person leaving.
        </li>
      </ul>
      <p>
        After a deletion request we may keep the minimum needed to comply with a
        legal obligation, or to exercise rights in a proceeding (LGPD art. 16).
      </p>

      <h2>Your rights, and how to use them</h2>
      <p>
        LGPD art. 18 gives you the rights below. Some are self-serve in the app
        today; the rest are handled by a person, because{" "}
        <strong>self-serve account deletion and personal data export are not
        built yet</strong>. We would rather tell you that than describe a button
        that does not exist.
      </p>
      <ul>
        <li>
          <strong>Confirmation that we process your data, and access to it (art.
          18, I and II)</strong> — email{" "}
          <strong>{"{{PRIVACY_EMAIL}}"}</strong>. We will send you a copy of the
          account data and messages we hold about you.
        </li>
        <li>
          <strong>Correction of incomplete or out-of-date data (art. 18, III)
          </strong> — self-serve: change your display name, handle, avatar and
          settings in Settings inside the app. For anything you cannot change
          there, email us.
        </li>
        <li>
          <strong>Anonymisation, blocking or deletion of unnecessary or
          excessive data (art. 18, IV)</strong> — email us describing what you
          want removed. You can also delete your own messages one by one in the
          app.
        </li>
        <li>
          <strong>Portability (art. 18, V)</strong> — email us and we will
          provide your data in a structured, machine-readable file. There is no
          self-serve export for individuals. (Server <em>owners</em> can export a
          whole server from Server Settings, but that is an owner tool covering
          everyone&apos;s messages in that server — it is not a personal data
          export.)
        </li>
        <li>
          <strong>Deletion of data processed with consent (art. 18, VI)</strong>{" "}
          — email us. To delete your whole account, email{" "}
          <strong>{"{{PRIVACY_EMAIL}}"}</strong> from the address on your
          account; we handle it manually today.
        </li>
        <li>
          <strong>Information about who we share data with (art. 18, VII)</strong>{" "}
          — the list is in &quot;Who else sees your data&quot; above; ask the
          encarregado for more detail.
        </li>
        <li>
          <strong>Information about refusing consent and the consequences (art.
          18, VIII)</strong> — the only consent-based features are optional ones
          like desktop notifications. Refusing them turns that feature off and
          nothing else.
        </li>
        <li>
          <strong>Withdrawing consent (art. 18, IX)</strong> — turn the feature
          off in Settings or revoke the permission in your browser.
        </li>
      </ul>
      <p>
        <strong>How to make a request.</strong> Email{" "}
        <strong>{"{{PRIVACY_EMAIL}}"}</strong> or the encarregado at{" "}
        <strong>{"{{DPO_EMAIL}}"}</strong>, from the email address on your
        account, saying what you want. We may ask for information to confirm it
        is really you — we will not ask for more than we need. LGPD art. 19 gives
        us up to <strong>15 days</strong> to provide a complete response.
      </p>
      <p>
        Some things we cannot do. We cannot delete messages you sent out of other
        people&apos;s conversations without deleting their record of a
        conversation they took part in, and we cannot remove your messages from
        copies a server owner has already exported or another member has
        screenshotted.
      </p>
      <p>
        You also have the right to complain to the{" "}
        <strong>ANPD (Autoridade Nacional de Proteção de Dados)</strong> if you
        think we have handled your data wrongly.
      </p>

      <h2>Controls you have in the app right now</h2>
      <ul>
        <li>
          <strong>Blocking.</strong> Blocking someone stops either of you opening
          or sending direct messages to the other, and stops their messages
          notifying you. Be aware of the limit:{" "}
          <strong>blocking is not invisibility</strong> — in a server you both
          belong to, they can still see the messages you post there, and you will
          still see that they posted, collapsed.
        </li>
        <li>
          <strong>DM privacy.</strong> Choose who can start a DM with you:
          everyone, only people who share a server with you (the default), or
          nobody. It governs new conversations; it does not close existing ones.
        </li>
        <li>
          <strong>Deleting your own messages</strong>, and leaving any server.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Traffic is encrypted in transit. Voice audio is encrypted between
        participants. Attachment links are short-lived and signed rather than
        public. Our server refuses to fetch link previews from internal network
        addresses. No system is perfectly secure; if you find a vulnerability,
        please tell us at <strong>{"{{SECURITY_EMAIL}}"}</strong>. If a breach
        creates a relevant risk to you, we will notify you and the ANPD as LGPD
        art. 48 requires.
      </p>

      <h2>Self-hosted instances</h2>
      <p>
        If you run pqp yourself, you choose the database, the Clerk application,
        and the hosting, and you are the <em>controlador</em> for your users.
        pqp.gg does not receive your users&apos; data. Tell your members how you
        handle their information.
      </p>

      <h2>Changes</h2>
      <p>
        We may update this policy. The &quot;Last updated&quot; date at the top
        will change, and we will give notice in the app before changes that
        materially affect you take effect.
      </p>

      <h2>Contact</h2>
      <ul>
        <li>
          Encarregado / DPO: <strong>{"{{DPO_NAME}}"}</strong> —{" "}
          <strong>{"{{DPO_EMAIL}}"}</strong>
        </li>
        <li>
          Privacy requests: <strong>{"{{PRIVACY_EMAIL}}"}</strong>
        </li>
        <li>
          Abuse and safety: <strong>{"{{ABUSE_EMAIL}}"}</strong>
        </li>
      </ul>
    </LegalPage>
  );
}
