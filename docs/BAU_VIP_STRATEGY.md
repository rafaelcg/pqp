# Baú VIP: what to charge, who sets the price, and how the money moves

Status: analysis, 2026-09-01. Nothing here is built. The free Baú ships first
behind `COMMUNITY_HOME_ENABLED` to measure appetite; the VIP half is behind
`COMMUNITY_HOME_VIP_ENABLED` and, on the product side, stops at a disabled
"VIP, coming soon" button. This document is the argument for what goes behind
that button. Sources were checked on 2026-09-01; anything marked *unverified*
could not be confirmed against a primary source.

## The question

Three decisions, in order of how much they constrain the others:

1. **Who sets the price.** Platform-fixed tiers (YouTube, Twitch) or
   owner-set plans inside a floor (Patreon, Ko-fi, Discord, Apoia.se)?
2. **Which rail.** Clerk Billing, Stripe direct, Stripe Connect, or a
   Brazilian PSP (Mercado Pago, Asaas, Pagar.me)?
3. **What pqp keeps.** A percentage, a flat fee, or nothing for now?

## What the market does

| Platform | Cut | Who sets tiers | Floor / ceiling | Brazil |
|---|---|---|---|---|
| Patreon | 10% (pages made after Aug 2025) + processing 2.9% + $0.30, FX 2.5% | Creator, unlimited tiers, free tier | $1 floor; rises capped at +$20/edit | BRL pay-in only; payout in USD via PayPal/Payoneer; no Pix |
| Ko-fi | 0% tips, 5% memberships (0% on Gold) | Creator | none published | via own Stripe/PayPal account |
| Buy Me a Coffee | 5% + Stripe | Creator | none published | listed for Stripe payouts |
| Substack | 10% + Stripe | Writer | $5/mo floor | 0% for BR writers today (Stripe limits) |
| YouTube memberships | 30% | **Platform ladder**, creator picks up to 6 levels | BR: R$ 3,99 to R$ 1.999,99 | native BRL |
| Twitch | 50/50 (up to 70/30 with Plus) | **Platform**, 3 fixed tiers, localised | BR Tier 1 R$ 9,90 | native BRL |
| Discord Server Subscriptions | 10% + Stripe | Owner, 1 to 3 tiers | $2.99 to $199.99 | **sellers must be US**; Brazilians can only buy; not on Android |
| Apoia.se | 13% | Creator | none; most supported R$ 5 to 20 | native, Pix |
| Catarse Assinaturas | 13% | Creator | none published | native |
| Hotmart / Kiwify | ~9 to 10% + R$ 1 to 2,49 per sale | Producer | none | native, Pix, boleto, NF-e tooling |
| Mercado Pago Assinaturas | card 3.98 to 4.98%, Pix 0.99% (rail, not a platform) | Merchant | none | native, Pix Automático |

Two things stand out. Every creator-first platform lets the owner set the
price inside a floor; only the two with app-store and hundred-currency
problems (YouTube, Twitch) fix the ladder. And the space pqp actually plays in
(Discord) has no seller path for a Brazilian owner at all, which is the gap.

### Benchmarks

| Metric | Value | Source quality |
|---|---|---|
| Patreon fan-to-member conversion | 0.5% to 2.5% | Patreon's own creator hub, ~300k creators |
| Patreon modal tier | $5; avg patron spend ~$12/mo | secondary |
| YouTube member conversion | ~1% of subscribers (2 to 4% education) | secondary, unverified |
| Discord paid-server conversion | 2 to 8% of an engaged free server at $4.99 to $9.99 | blogs, unverified |
| Apoia.se most-supported values | R$ 5 to R$ 20/mo | Apoia.se blog |
| Twitch BR Tier 1 | R$ 9,90 (was R$ 7,90 until Jun 2024) | Twitch pricing |

No controlled study compares creator-set with fixed pricing. The observable
pattern is that creators cluster on round points regardless (R$ 5 / 10 / 20,
$5 / $10), and Patreon's own advice is that a $5 tier out-converts a $6 one.

## Rails, honestly

**Clerk Billing is out.** It is app-defined plans only (no tenant-created
plans), USD only, adds 0.7% on top of Stripe, has no third-party payouts,
and its docs currently list Brazil as unsupported. It would fit "pqp Pro for
the person" one day; it cannot do "this owner sells this community".

**Stripe Connect Express, owner as connected account.** Brazil is a supported
platform country. pqp is *not* merchant of record: the owner sells, Stripe
pays the owner, pqp takes an application fee. That keeps pqp out of the
Brazilian *subadquirente* category (BCB Res. 150/2021, centralised settlement
from Res. 522/2025) and leaves the NFS-e obligation where it belongs, with
the owner. BR domestic cards cost 3.99% + R$ 0,39 on the owner's side, in
line with every peer. Weakness: Stripe BR has no Pix Automático (recurring
Pix), and Pix itself is invite-only for BR accounts.

**Mercado Pago or Asaas** as a second rail if Pix subscriptions become the
ask. Both have split payments and Pix Automático (launched Jun 2025), Asaas
has NF-e built in. More integration work, no Connect-style onboarding UI.

## Recommendation

1. **Owner-set plans inside a floor.** One to three tiers per community,
   floor R$ 5, suggested list R$ 5 / 10 / 20 / 50, monthly only at first.
   Fixed platform tiers would be simpler to build and Apple-ready, but every
   platform Brazilian owners already use lets them pick, and a ladder that
   starts at R$ 3,99 (YouTube) is not where a small hall wants to be.
2. **One VIP cargo, not per-tier gating, for v1.** Any paid tier grants the
   existing `system_key=vip` cargo; tiers differ in price and in what the
   owner promises outside the software (a Discord-style "supporter" model).
   Per-tier post gating is a `roles`-keyed visibility, which the schema can
   take later without a migration of existing posts.
3. **Stripe Connect Express, 10% application fee.** Matches Discord and the
   new Patreon, undercuts Apoia.se and Catarse (13%). The 10% is the number to
   test, not defend; a launch promo at 5% for the first N communities is a
   one-line change on the fee parameter.
4. **Web checkout only.** Apple takes 30% on in-app digital purchases and
   Patreon now raises iOS prices ~43% to compensate. The native apps should
   show the VIP lock and a "manage on the web" link, not a Buy button. Same
   for Electron (it is the web client; Stripe Checkout in a new window works).
5. **Refunds as one click for 7 days.** CDC art. 49 gives a 7-day withdrawal
   on any remote purchase, digital goods included. Refund revokes the cargo.
   Cancellation must be as easy as sign-up (Decreto 7.962/2013).

## What this means for the software

Things the current schema already supports: `visibility = members`, the VIP
cargo, `post.locked`, the teaser, the disabled CTA.

Things to add, in order:

1. `community_plans` (server_id, name, price_brl_cents, active, stripe_price_id)
   and `community_subscriptions` (server_id, user_id, plan_id, status,
   current_period_end, stripe_subscription_id). Subscription webhooks grant
   and revoke the VIP cargo; nothing else reads Stripe.
2. Owner onboarding: "Connect payouts" in Server settings, a Stripe Express
   onboarding link, plan editor with the floor and the suggested list.
3. Member checkout: the lock's CTA opens Stripe Checkout (web) with the
   plan's price; success returns to the Baú and the cargo is already on
   because the webhook landed first (or a short poll).
4. Operator view: `pqp-admin` gets subscription counts and gross volume per
   community, since the instance is now a platform account with a fee.

Things to decide before building any of it, and who decides:

| Question | Owner | Suggested answer |
|---|---|---|
| Do we charge the owner a cut at all before there are 10 paying communities? | Rafael | No cut until then; 10% after, announced up front |
| Is VIP a cargo or a per-tier gate in v1? | Rafael + first owners | Cargo |
| Do we need Pix on day one? | first owners | Ask them; card first, Pix rail second |
| What does the disclosed-bot / ambient runner do around VIP posts? | Rafael | Nothing; bots never see members-only content |
| Polls as a Baú post type? | PO | Not now. Chat already has polls; a Baú poll is a poll pinned to a card, which is a `message_id` on a post, not a new type |

## Parity across surfaces

| Surface | Free Baú | VIP |
|---|---|---|
| Web (Pages) | full | full incl. checkout |
| Electron | inherits web | inherits web; Checkout in a new window |
| Android / iOS | not in this pass; the row is invisible because the apps do not know the route, and nothing breaks | show lock + "manage on the web"; never a native Buy button |

## Open questions for the next pass

- Feed pagination (the list query has none; fine under a few hundred posts).
- Notification on publish: none today, on purpose (Baú is not #avisos). A
  weekly digest email is the Patreon pattern and needs the email rail first.
- Discovery: should a community's public page (`/c/<slug>`) show the three
  newest free Baú posts? Cheap, and it is what a Patreon page does.
