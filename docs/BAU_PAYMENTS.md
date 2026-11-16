# Baú+ payments (a fan pays a creator for VIP, inside pqp)

A fan on the web or the desktop app pays a creator's server for its VIP cargo,
with Pix first and card second, and the cargo arrives the moment the payment
lands. This file is the contract: who holds what, the states, the endpoints,
the provider adapter and the sandbox. Shapes live in
`packages/shared/src/bau-payments.ts`; the server in
`server/src/services/bau-payments/` and `server/src/api/bau-payments-routes.ts`.

## Who is the merchant

**The creator.** Every charge is made by a payment provider on the creator's own
payout account. pqp never holds, routes or splits money: it shows the Pix code,
listens for the provider's notification and gives or takes the VIP cargo. The
seller's name is on the pay screen and on every receipt, and the provider is
named on the receipt ("processado por ..."), because a buyer has to know who
sold them something.

Which provider is still open (Asaas, LivePix, Mercado Pago, Stripe; see the
feasibility report). Nothing here talks to a real one yet. The **sandbox**
provider is built in so the whole flow works with no account and no money.

## Switches

Selling needs all of these, per server:

| Switch | What |
|---|---|
| `community_home` | The Baú exists on this deployment |
| `community_home_vip` (per server) | VIP posts exist on this server |
| `bau_payments` (runtime flag, **per server, default off**) | This server may sell VIP. Env `BAU_PAYMENTS` is its default (`true` only) |
| `servers.community_home_enabled` | The owner turned the Baú on |
| An active `bau_plans` row | A price |
| A `connected` `bau_payout_accounts` row on the active provider | Where the money goes |
| `BAU_PAYMENTS_PROVIDER` | Which adapter. Unset means the sandbox under the dev auth bypass and **nothing anywhere else**; `none` is off even in dev |

A self-host that never sets `BAU_PAYMENTS_PROVIDER` gets `enabled: false` from
every offer, draws no pay button, makes no network call and writes no row.

**Off is a kill switch for new sales only.** Turning `bau_payments` off stops
new checkouts. It does not touch months already paid: the sweep keeps running,
a VIP still ends on its date, a fan can still cancel and refund, and the
manager still lists the membership.

**Phones never draw any of it** (store policy, see
`phone-support-link-store-policy-2026-11-02.md`): no price, no Pix, no link, no
button, on iOS and Android. The cargo arrives on the phone like any other VIP.

## States

Membership (`bau_memberships`, one row per fan per server, reused across months):

| Status | Access | Means |
|---|---|---|
| `pending` | no | Checkout started, nothing paid yet |
| `active` | yes | Paid, the month is running |
| `grace` | yes | The month ended unpaid; `BAU_GRACE_DAYS` (3) more days |
| `expired` | no | Grace ran out |
| `cancelled` | until `periodEnd` | The fan stopped renewing |
| `refunded` | no | The payment was given back |

Charge (`bau_payment_attempts`): `pending`, `paid`, `expired`, `failed`,
`cancelled`, `refunded`. `failureReason` is `declined`, `expired`, `cancelled`
or `provider_error`.

`bauMembershipHasAccess` (shared) is the one access rule; the server's SQL twin
is `HAS_ACCESS_SQL` in `vip.ts`.

### Transitions

All in `applyCharge`, with the charge and the membership locked:

- **paid**: from `pending`, `expired`, `failed` or `cancelled`. Money that arrived
  is never ignored, so a code paid at the last second and confirmed after we
  called it expired still activates ("pagou mas demorou"). The membership goes
  `active`; the month starts at the end of the running one when VIP is still on
  (paying three days early or in grace loses no day and gains none), otherwise
  now. Any other open code of that membership is cancelled. Then the VIP cargo.
- **refunded**: from `paid` only. The membership goes `refunded` and the cargo
  goes. A renewal refunded at the provider ends access too (the simple rule).
- **expired / failed / cancelled**: from `pending` only.
- Nothing moves a `paid` or `refunded` charge back.

The sweep (`sweep.ts`, every minute in `jobs.ts`, on the worker when there is
one) moves time:

1. open codes past their expiry are asked of the provider and expired;
2. the **reminder**, `BAU_REMINDER_DAYS` (3) before the month ends, once per month (`reminded_for`);
3. `active` to `grace` when the month ends;
4. `grace` to `expired` three days later;
5. the cargo taken back from every membership without access that gave it;
6. the cargo given back to a paid fan who left and came back.

Each step claims its rows with a conditional `UPDATE ... RETURNING` or a row
lock, so with two API machines and a worker each row moves once and each fan is
told once.

## The VIP cargo

It is the server's ordinary VIP role (`roles.system_key = 'vip'`). No second
permission: the Baú, VIP-only rooms and every reader of VIP work unchanged.

`bau_memberships.vip_owned` is the **source marker**: TRUE only when this
membership inserted the `member_roles` row. A revoke deletes the row only then.
So a VIP staff gave by hand is never taken by an expiry, and a lapsed paid VIP
never survives. If staff give VIP by hand to somebody who already holds it
through a payment, it is the same row; when the payment ends it goes, and staff
give it again.

Kick and leave drop `member_roles` by FK. A paid fan who comes back gets the
cargo again from the sweep: the test is `vip_granted_at < server_members.joined_at`.
Staff stripping the cargo from a member who never left is respected (the grant
is after the join, so the sweep leaves it).

A grant or revoke bumps `permissions_version` and sends `permissions-update`
(`notifyPermissionsUpdate`, over the cluster bus), so the fan's open app shows
the VIP post and the VIP room without a reload. A revoke also evicts them from
VIP-only channels the way taking a cargo by hand does.

## Monthly billing

One Pix per month. The reminder goes out three days before the month ends, as a
`bau-plus-update` frame (`reason: "reminder"`) and a renewal card on the web
(derived from `renewalDue` on the membership, so nothing extra is stored). No
push and no email yet: a push may not carry a price (store policy) and there is
no email service. A recurring provider (Pix Automático, a card subscription)
replaces the reminder later by sending `paid` before `periodEnd`; the states do
not change.

**7-day refund** (CDC art. 49): the FIRST payment a membership ever settled,
within `BAU_REFUND_WINDOW_DAYS` (7) of it, one tap, no creator approval. A
payment after an earlier one was refunded or ran out does not reopen it. The provider
refunds from the creator's balance; when it cannot, the fan gets an error and
nothing changes (pqp never tops a refund up). A renewal is not refundable from
the app.

**Price changes**: a new price is a new plan. A receipt and a running month keep
the price they were sold at; a checkout started against the old plan is refused
with `plan_changed` and the client re-reads the offer.

## Endpoints

Web and desktop only. The phone apps never call them.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/servers/:serverId/bau-plus` | member | `BauOffer`: `enabled`, plan, seller, methods, `sandbox`, my membership |
| POST | `/api/servers/:serverId/bau-plus/checkout` | member | `{ planId, method }` to `{ attempt, membership }`. Hands back a still-good open code of the same method instead of a second one. `409 already_member` when there is nothing to pay yet, `409 plan_changed`, `429 too_many_attempts` (12 an hour), `502 provider_unavailable` |
| GET | `/api/bau-plus/attempts/:attemptId[?refresh=1]` | the fan | The pay screen's poll. Asks the provider at most every 10 s, or now with `refresh=1` ("já paguei") |
| POST | `/api/bau-plus/attempts/:attemptId/cancel` | the fan | Drop an open code |
| GET | `/api/bau-plus/memberships` | the fan | Every membership that ever paid or has an open code, with receipts |
| POST | `/api/bau-plus/memberships/:id/cancel` | the fan | Stop renewing (access to the end of the month; in grace it ends now) |
| POST | `/api/bau-plus/memberships/:id/resume` | the fan | Undo a cancel while the month runs. Charges nothing |
| POST | `/api/bau-plus/memberships/:id/refund` | the fan | The 7-day refund. `409 refund_window_closed`, `502 refund_failed` |
| GET, PUT | `/api/servers/:serverId/bau-plus/plan` | MANAGE_SERVER | The one plan (`bauPlanBodySchema`: name, `priceCents` 500 to 20000, up to 4 perks) |
| POST | `/api/servers/:serverId/bau-plus/sandbox/connect` | MANAGE_SERVER, sandbox only | `{ sellerName }`: a sandbox payout account in one call |
| POST | `/api/bau-plus/attempts/:attemptId/sandbox` | the fan, sandbox only | `{ action: "pay" \| "fail" \| "expire" }` |
| POST | `/api/bau-plus/webhooks/:provider` | the provider | Before auth (pitfall 8). The adapter checks the signature on the raw body |

Frame `bau-plus-update` (per person, the fan's own sockets on every instance):
`{ serverId, membershipId, status, attemptId, reason }`, `reason` one of `paid`,
`attempt-expired`, `attempt-failed`, `refunded`, `cancelled`, `resumed`,
`reminder`, `grace`, `expired`. Content-light: the client re-reads.

## The provider adapter

`server/src/services/bau-payments/provider.ts`, `PaymentProvider`:

- `createCharge({ account, reference, amountCents, method, description, expiresAt })`
- `getCharge(account, ref)`: **the truth**. A webhook only says "look at charge
  X"; the state machine believes `getCharge`. Events arrive twice and out of
  order, and the re-fetch is what makes that harmless.
- `cancelCharge`, `refundCharge` (`refunded` now or `pending` until a webhook)
- `verifyWebhook(headers, rawBody)`: the events, or null for a bad signature
  (401, counted as `webhooksBadSignature`).
- `methods`: what the pay screen may offer, Pix first. The card button is drawn
  only when the adapter lists `card`.

Every notification is recorded once in `bau_payment_events` (primary key
`(provider, event_id)`), so a webhook delivered twice does nothing the second
time. An apply that throws leaves the row unprocessed and answers 500, so the
provider retries.

To add a real provider: implement the interface, `registerPaymentProvider` it,
set `BAU_PAYMENTS_PROVIDER`, and let the payout connect slice write
`bau_payout_accounts` with its account id. A creator's API key, when a provider
needs one, is never in a row of these tables or a log; it lives encrypted where
the connect slice puts it.

## The sandbox

`sandbox-provider.ts`. Allowed only in development, under the dev auth bypass,
and on a Fly app named `-staging`; never on production (a sandbox charge is a
button that grants VIP for free).

- A charge has a real-looking Pix copia e cola (EMV BR Code, valid CRC, made out
  to `sandbox@pqp.invalid`, `NAO PAGUE` in the name) and an expiry
  (`BAU_PAYMENTS_PIX_TTL_MINUTES`, default 15).
- It pays itself `BAU_PAYMENTS_SANDBOX_AUTOPAY_SECONDS` after creation (default
  8, `0` never), or when the dev controls on the pay screen say pay, fail
  (a declined card) or expire. A refund is immediate.
- Each of those sends a webhook through the same handler the HTTP route feeds,
  with its own event id. The HTTP route also accepts the sandbox's signature
  (`x-sandbox-signature: sha256=HMAC(BAU_PAYMENTS_SANDBOX_SECRET, body)`), so
  the external shape is exercised by the tests.
- `BAU_PAYMENTS_SANDBOX_CARD=false` hides the card option.

Locally, with `DEV_AUTH_BYPASS=true`, the boot seed gives the **Sandbox** hall a
plan (VIP, R$ 9,90) and a sandbox payout account named "Dev User". Turn on
`community_home`, `community_home_vip` and `bau_payments` (env or the dashboard)
and the hall sells.

## The fan's screens (web and desktop)

All in `client/src/components/bau-plus/`, strings under `bauPlus.*`. Never on
the phone apps.

- **The locked post** (`BauPlusPaywall`): when the server's offer is
  `enabled`, a members-only post shows the title, the date and the creator's
  own teaser (the composer's "Prévia" field, written per post), then a
  placeholder shaped like the hidden text: rows of word-sized bars, plainly
  not words, as many rows as the text is long, and none under media with only
  a caption (the plate above already has the media's shape, with a play,
  picture or file mark). Then one card: "Post exclusivo pra VIP", what is
  inside ("Vídeo", "Leitura rápida", "3 min de leitura"), one sentence, and
  "Apoiar por R$ X/mês". The kind and the length come from
  `post.lockedHint` (`{ mediaKind, readMinutes }`), which the feed API fills
  only for a locked reader and which carries no word of the post; the real
  body never reaches the client. Never a disabled button: mid-payment it says
  "Continuar o pagamento", after VIP ran out "Voltar pro VIP". Without an
  offer the card is the support-link card, as before. A VIP reader gets a
  small "VIP" chip on members-only posts.
- **The pay sheet** (`BauPlusPayDialog`), one dialog in three steps: summary
  (seller, price, the creator's perks, Pix or card when the adapter offers
  card, the renewal and 7-day lines), pay, and paid. The pay step opens with
  the amount (and "Voltar" on the same row) and a status block, "Esperando o
  pagamento" with the countdown over a bar that drains with the code's time
  (warning colour in the last two minutes), so the state is the first thing
  seen when the person comes back from the bank app. Then two layouts:
  - **phone** (under 640px): the bank app is on the same screen, so "Copiar
    código Pix" leads, the steps say copy, paste in Pix Copia e Cola, confirm,
    and the QR folds behind one row ("Pagar de outro celular? Mostrar o QR").
    Copying ticks step one and lights step two. There is no "open your bank"
    button: Pix has no universal deep link. The whole decision fits a 390x844
    screen with no scroll (pinned by the e2e).
  - **computer**: the phone is what pays, so the QR leads and copying is the
    quieter second button.
  Expired, declined and "Já paguei e não liberou" (a provider re-fetch) live
  in the pay step. The sandbox's pay, fail and expire are one quiet row at the
  very bottom. The paid step is the one celebratory moment: the creator's VIP
  seal arrives (tile, one sheen, the gem medallion), a soft halo opens once,
  then "VIP até" with the month's bar, the perks listed back, and "Ler o
  post". The sheet flips on `bau-plus-update` and polls every 4 s under it.
- **The VIP seal** (`vip-seal.tsx`): the creator's icon with a gem medallion
  on its corner, the one mark for "tu é VIP daqui" on the confirmation, the
  strip and Assinaturas; greyed when access is off. `BauMonthMeter` beside it
  is how much of the paid month is left.
- **The membership strip** at the top of the creator's Baú. While VIP runs
  with nothing due it is a slim row (seal, "VIP desde ...", "Vale até ...", a
  hairline for the month) that opens Assinaturas. It grows into a card with
  one button when there is something to do: an open Pix, the renewal
  reminder (`renewalDue`, "Faltam 3 dias de VIP"), grace, a cancelled month
  still running, a VIP that ended in the last 30 days. Right after paying it
  is the welcome, which plays the seal's arrival once.
- **Configurações, Assinaturas** (`SubscriptionsSection`, shown once the person
  has a membership): one box per creator with the seal, status, "VIP desde",
  and while access runs a month block ("Vale até ...", days left, the bar,
  one friendly line on what happens next); then the one next step (renew,
  continue, reactivate, come back), cancel and the 7-day refund (both confirm
  first), and the receipts (each opens a receipt with seller, item, period,
  method, provider and the provider's reference). "Renovar" from here opens
  that creator's Baú with the pay sheet up (`requestBauPay`).

Motion is a handful of quiet moments (the step settling, the waiting dot and
draining bar, the seal arriving, the month bar easing in), all in `index.css`
under `bau-*` and off under reduced motion. The e2e is
`client/e2e/bau-plus-pay.spec.ts`, against the sandbox.

## Metrics

`creatorHub.payments` on `GET /api/admin/metrics`: `process` counters
(checkouts started and reused, paid, renewals, expired and failed codes,
refunds and refused refunds, cancels, resumes, reminders, grace entered,
expired memberships, VIP granted, revoked and regranted, provider errors,
webhooks received, duplicate, bad signature, unknown charge, failed) and `db`
counts (active plans, connected payout accounts, memberships by status, VIP held
through a payment, open codes, paid and refunded in 7 days). Counts only: no
amount per person, no name, no charge id.

## Audit

Written in the creator's server: `bau_plus.plan_update` (staff),
`bau_plus.activate`, `bau_plus.cancel`, `bau_plus.resume`, `bau_plus.refund`
(the fan), `bau_plus.grace`, `bau_plus.expire`, `bau_plus.vip_regrant` (the
system). Target is the fan; `changes` carries the status move and the charge id,
never an amount.

## Not here yet

- The payout connect flow (a creator connects an account in one click or with a
  Pix key; nobody handles API keys). The sandbox connect endpoint stands in.
- The creator's setup screen (price, perks) and earnings view.
- A real provider, receipts as PDF, email reminders, Pix Automático.
- Operator tools on paid content (pause a creator's checkout, refund their VIPs).
