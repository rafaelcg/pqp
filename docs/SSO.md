# SSO / SAML

pqp does not implement SAML or OIDC itself. Clerk performs the federation
handshake with the identity provider and issues the same session JWT the app
already accepts, so **the application code is unchanged whether someone signs in
with a password, Google, or a corporate SAML IdP.**

What Clerk cannot know is which pqp server a federated user belongs in. That is
the part this app supplies: **SSO email domain joining.**

## The two halves

| Piece | Where it is configured | What it does |
|---|---|---|
| SAML / OIDC federation | Clerk dashboard | Authenticates the user against the customer's IdP |
| SSO email domain | pqp → Server settings | Puts that user into the right server without an invite |

## 1. Federation (Clerk side)

In the Clerk dashboard, under **Enterprise Connections**, add a SAML or OIDC
connection for the customer's domain and follow Clerk's IdP-specific setup
(Okta, Entra ID, Google Workspace, or generic SAML). Clerk verifies domain
ownership as part of that flow.

Nothing needs deploying on the pqp side. No new env vars, no rebuild — a
federated user simply arrives with a working session.

Do check that the Pages and API origins are both allowed in the Clerk dashboard
(see pitfall 4 in [`../CLAUDE.md`](../CLAUDE.md)), which applies to every auth
method, not only SSO.

## 2. SSO email domain (pqp side)

**Server settings → SSO email domain.** Owner-only. Enter a domain the
organisation controls, e.g. `acme.com`. Leave it empty to turn the feature off.

Anyone whose Clerk account carries a **verified** email at that domain can then
join that server with no invite: the server appears under "Available to you" in
the app, with a Join button.

### The rules it enforces

- **Verified addresses only.** An unverified address is self-asserted. If pqp
  honoured one, anyone could type `someone@acme.com` into their profile and walk
  into Acme's private server. `verifiedEmailDomains` in
  `server/src/auth/clerk.ts` is where that filter lives, and it is the whole
  security boundary for this feature.
- **Every verified address counts, not just the primary.** Someone whose primary
  address is personal and whose work address is a verified secondary would
  otherwise be locked out of their own employer's server.
- **Exact domain match.** `acme.com` does not admit `mail.acme.com`,
  `evil-acme.com`, or `acme.com.evil.test`. A suffix match would admit all three.
- **Bans still apply.** A banned user whose domain matches is still refused.
- **Public providers are refused.** Setting `gmail.com` would not admit "your
  company", it would admit the internet, so the obvious consumer providers are
  rejected outright (`PUBLIC_EMAIL_DOMAINS` in `packages/shared/src/sso.ts`).
  This is a guard against an owner not thinking it through, not a security
  boundary — an invite link already exists for deliberately opening a server up.
- **Access is revoked when the address goes away.** `users.email_domains` is
  overwritten on every sign-in rather than merged, so removing or unverifying a
  work address stops it admitting anyone the next time they authenticate. It
  does not retroactively remove existing members — kick or ban for that, exactly
  as with an invite.
- **A mismatch and an unknown server id return the same 404.** A distinct 403
  would confirm to a stranger that a given server id exists.

### What is stored

Only the *domain* of each verified address (`users.email_domains`), never the
address itself. It is all the feature needs, and a domain is not personal data
the way a mailbox is.

## Trying it locally

The dev-auth bypass proves no email, so it grants no domain — and every request
re-runs it and overwrites `users.email_domains`, so setting that column by hand
does not survive the next call. To exercise domain joining locally, set
`DEV_AUTH_EMAIL_DOMAINS` (dev only, read only when `DEV_AUTH_BYPASS=true`, which
already refuses to run under `NODE_ENV=production`):

```bash
# .env
DEV_AUTH_BYPASS=true
DEV_AUTH_EMAIL_DOMAINS=acme.com
```

Then set a server's SSO email domain to `acme.com` and the dev account will see
it under "Available to you".

## Not built

- **SCIM provisioning / deprovisioning.** A user who leaves the company keeps
  their pqp membership until someone kicks them, or until their IdP account is
  removed in Clerk. Domain joining gates *joining*, not continued membership.
- **Clerk Organizations.** pqp servers are its own membership model; Clerk orgs
  are not mapped onto them.
- **Enforced SSO-only sign-in.** A server cannot currently require that members
  authenticate via SSO — it can only offer domain-based joining alongside the
  normal invite path.
