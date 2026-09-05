# uapay-recurring

Recurring card billing for **WayForPay**, **LiqPay** and **monobank**, behind one interface.

Stripe does not contract with Ukrainian entities. The acquirers that do have no subscription
product: they will store a card and let you charge it again, and everything above that — the
renewal schedule, dunning, proration, webhook idempotency — is yours to write. This package is that
layer, extracted from a product that runs it in production.

- **No hosted subscription page.** The card is captured once on the acquirer's page, which returns
  a recurring token. Every renewal after that is a server-side charge against the stored token.
- **Signatures are verified before parsing.** WayForPay is HMAC-MD5 over a fixed field order,
  LiqPay a base64 `data` + SHA-1 `signature` envelope, monobank an ECDSA signature in an `X-Sign`
  header over the raw body. All three are tested against tampered amounts, tampered statuses and
  foreign keys.
- **No dependencies.** Node 20+, `fetch` and `node:crypto`. TypeScript types included.
- **No database.** It does not own your subscriptions; it gives you the provider calls, the webhook
  envelope and the schedule maths, and stays out of your schema.

```bash
npm install uapay-recurring
```

## Taking the first payment

```ts
import { createWayForPay, paymentReference } from "uapay-recurring";

const provider = createWayForPay({
  merchantAccount: process.env.WAYFORPAY_MERCHANT_ACCOUNT!,
  merchantSecret: process.env.WAYFORPAY_MERCHANT_SECRET!,
  merchantDomain: process.env.WAYFORPAY_MERCHANT_DOMAIN!,
});

const reference = paymentReference("sub");

const session = await provider.createSetupCheckout({
  reference,
  amountMinor: 499,
  currency: "USD",
  description: "Pro, monthly",
  returnUrl: "https://example.com/billing/done",
  webhookUrl: "https://example.com/api/webhooks/billing/wayforpay",
});

// Store `reference` against your pending subscription, then send the browser here.
redirect(session.redirectUrl);
```

Amounts are **minor units** everywhere — `499` is $4.99. The acquirers speak major units; the
conversion happens inside, through a rounding path that round-trips exactly (`toMinorUnits`,
`toMajorUnits` are exported if you need the same behaviour elsewhere).

`createLiqPay({ publicKey, privateKey })` is the same interface. LiqPay builds its checkout URL
locally rather than calling the API, so `createSetupCheckout` there makes no network request.

## Handling the webhook

Mount the route **before** your JSON body parser — the signature is computed over the raw bytes.

```ts
import express from "express";
import { MemoryEventLedger, redactTokens } from "uapay-recurring";

const ledger = new MemoryEventLedger();

app.post(
  "/api/webhooks/billing/wayforpay",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    const envelope = provider.verifyWebhook(req.body);

    if (!envelope) {
      return res.sendStatus(401);
    }

    if (!(await ledger.claim(provider.name, envelope.eventId))) {
      return res.json(envelope.acknowledgement ?? { ok: true });
    }

    // Reconcile against what you stored, and never trust the callback's own amount.
    const payment = await payments.findByReference(envelope.reference);

    if (!payment || payment.amountMinor !== envelope.amountMinor) {
      await payments.markFailed(envelope.reference, "amount_mismatch");
      return res.json(envelope.acknowledgement ?? { ok: true });
    }

    if (envelope.outcome === "succeeded" && envelope.card) {
      await subscriptions.activate(payment, encrypt(envelope.card.token));
    }

    await events.store(redactTokens(envelope.payload));

    res.json(envelope.acknowledgement ?? { ok: true });
  },
);
```

Four rules the envelope is shaped around, each of which is a real integration bug if skipped:

1. **Verify before parsing.** `verifyWebhook` returns `null` for a bad signature, an unparseable
   body, or a payload with no order reference. There is no partial result to act on.
2. **Claim the event id.** `envelope.eventId` is stable per delivery, and acquirers retry. Claim it
   under a unique constraint before doing anything with side effects; `MemoryEventLedger` is fine
   for one process, but a real ledger is a unique index on `(provider, eventId)`. Implement
   `EventLedger` over your own store and pass that instead.
3. **Never trust the callback amount.** Reconcile `envelope.amountMinor` against what you charged.
   A mismatch is a failure to record, not a subscription to activate.
4. **Answer WayForPay with its acknowledgement.** `envelope.acknowledgement` is the signed
   `{ orderReference, status, time, signature }` object WayForPay expects; without it, it keeps
   retrying. LiqPay wants no acknowledgement, so the field is absent there — `?? { ok: true }`
   covers both.

`redactTokens` strips `recToken` / `card_token` / `cardToken` / `token` at any depth, so a stored
payload is safe to keep as dispute evidence. Pass the token values you already hold as a second
argument — `redactTokens(payload, [card.token])` — and it also redacts them wherever they appear
under a field name nobody thought to list.

## Renewing, and failing to renew

```ts
import { addMonths, nextDunningStep, nextPeriodStart } from "uapay-recurring";

const result = await provider.charge({
  reference: paymentReference("sub"),
  amountMinor: 499,
  currency: "USD",
  description: "Pro, monthly",
  token: decrypt(subscription.tokenEnc),
});

if (result.outcome === "succeeded") {
  const start = nextPeriodStart(subscription.currentPeriodEnd);

  await subscriptions.renew(subscription.id, start, addMonths(start, 1));
  return;
}

if (result.outcome === "pending") {
  // Reconcile later with provider.status(result.providerRef).
  return;
}

const step = nextDunningStep(subscription.failedCharges);

if (step.action === "give_up") {
  await subscriptions.expire(subscription.id, step.attempt);
} else {
  await subscriptions.markPastDue(subscription.id, step.attempt, step.retryAt);
}
```

`nextDunningStep` walks a ladder — by default 1 day, then 3, then 3 more, then give up — and takes
`delaysMs` if you want your own. It is a pure function of the failure count, so the schedule is
testable without a clock or a database.

`addMonths` clamps to the end of a shorter month: a subscription started on 31 January renews on
28 February, and on 29 February in a leap year, rather than sliding into March.

`nextPeriodStart` starts the new period where the old one ended, unless that moment has already
passed — so a renewal that happens late does not hand out free time, and one that happens early
does not take any away.

## Refunding

```ts
const refund = await provider.refund({
  reference: payment.reference,
  amountMinor: payment.amountMinor,
  currency: payment.currency,
  reason: "Cancelled within fourteen days",
});

if (refund.outcome === "refunded") {
  await payments.markRefunded(payment.id, refund.amountMinor);
}
```

`amountMinor` is the amount to send back, not the amount originally charged, so a partial refund is
the same call with a smaller number — which is what a policy promising "the unused part of your
period" needs.

**Refund outcomes map the opposite way round to charge outcomes, deliberately.** An unrecognised
charge status is a `failed` charge, because activating a subscription on a status nobody documented
is the expensive mistake. An unrecognised _refund_ status is `pending`, because there the expensive
mistake is telling the caller the refund failed when the money already left — a caller that retries
sends it twice. Only an explicit refusal (`Declined` at WayForPay, `failure` / `error` at LiqPay) is
`failed`. Anything else is yours to reconcile with `provider.status(providerRef)` before trying
again.

The acquirer also announces the refund on the webhook, whoever started it — including a refund an
operator issued by hand in the acquirer's own dashboard, which your database would otherwise never
hear about. `Refunded` and `Voided` at WayForPay and `reversed` at LiqPay all arrive as
`envelope.outcome === "refunded"`, so that callback is not mistaken for a failed renewal and does
not feed the dunning ladder.

## Cancelling, and what the acquirer does not know

**With token-driven billing, cancellation is yours, not the acquirer's.** This package charges a
stored token on a schedule you own: WayForPay `CHARGE` against a `recToken`, LiqPay `paytoken`.
Neither acquirer holds a subscription for that, so there is nothing on their side to cancel. The
authoritative cancellation is that you stop charging and delete your copy of the token.

`cancelRecurring` speaks to the _other_ thing — WayForPay's Regular Payments engine
(`https://api.wayforpay.com/regularApi`) and LiqPay's `unsubscribe`, both of which manage
subscriptions the acquirer schedules itself. Call it if you also created one of those. If you did
not, expect it to answer "not found", which it now tells you rather than swallowing:

```ts
const cancelled = await provider.cancelRecurring(subscription.providerRef);

if (cancelled.outcome === "failed") {
  logger.warn(`${provider.name} would not cancel: ${cancelled.failureCode}`);
}

// This is the part that actually stops the money.
await subscriptions.forgetPaymentMethod(subscription.id);
```

The order matters. Delete the token when the subscription really ends, not when the customer
clicks cancel — a customer who cancels at period end and then changes their mind still needs the
card you were about to throw away.

## Charge outcomes

Both providers map their own vocabularies onto three outcomes:

| Outcome     | WayForPay                                        | LiqPay                                                                           |
| ----------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `succeeded` | `Approved`                                       | `success`, `subscribed`, `sandbox`                                               |
| `pending`   | `InProcessing`, `WaitingAuthComplete`, `Pending` | `processing`, `prepared`, `wait_accept`, `wait_secure`, `wait_card`, `hold_wait` |
| `failed`    | everything else, including an absent status      | everything else, including an absent status                                      |

`verifyWebhook` adds a fourth, `refunded`, for `Refunded` / `Voided` at WayForPay and `reversed` at
LiqPay. `refund()` answers with `refunded` / `pending` / `failed` on the inverted rule above.

Unknown statuses fail closed. A new status neither provider documented will be treated as a failure
rather than silently activating a subscription — reconcile `pending` payments against
`provider.status(providerRef)` on a schedule rather than waiting on the webhook forever.

## API

```ts
createWayForPay(credentials, options?): RecurringProvider
createLiqPay(credentials, options?): RecurringProvider
createMonobank(credentials, options?): RecurringProvider
```

`options` takes `timeoutMs` (default 15s) and `fetch`, which is how the tests drive the providers
without a network.

Every provider exposes:

| Method                             | Does                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `createSetupCheckout(req)`         | first payment, asking the acquirer to return a recurring token          |
| `charge(req)`                      | a server-side charge against a stored token                             |
| `refund(req)`                      | send back all or part of a payment                                      |
| `status(providerRef)`              | the acquirer's own view of a payment, for reconciling `pending`         |
| `cancelRecurring(providerRef)`     | drops the acquirer-side regular payment, if there is one — read below   |
| `verifyWebhook(rawBody, headers?)` | `WebhookEnvelope` for a valid signed callback, `null` for anything else |

Also exported: `wayforpaySignature`, `signPurchase`, `signCallback`, `signAcknowledgement`,
`signRefund`, `liqpaySignature`, `encodeLiqPayData`, `decodeLiqPayData` — for signing a request this
package does not cover, and `wayforpayOutcome` / `liqpayOutcome` / `wayforpayRefundOutcome` /
`liqpayRefundOutcome` / `monobankOutcome` / `monobankRefundOutcome` for mapping a status you read
elsewhere. For monobank specifically: `verifyMonobankSignature`, `decodeMonobankPublicKey`,
`MONOBANK_SIGNATURE_HEADER`, and `currencyNumber` / `currencyAlpha`.

## monobank

monobank signs its webhook in a header rather than in the body, and verifies against a key it
publishes rather than a shared secret. That is why `verifyWebhook` takes a second argument — the
other two providers ignore it.

```ts
import { createMonobank } from "uapay-recurring";

const provider = createMonobank({ token: process.env.MONOBANK_TOKEN! });

await provider.refreshPublicKey();
```

Fetch the key once at boot and keep it; it is stable, not per-request. If verification starts
failing across the board, call `refreshPublicKey()` again — that is what a rotation looks like. You
can also pass `publicKey` yourself and skip the call entirely, which is what the tests do.

```ts
app.post(
  "/api/webhooks/billing/monobank",
  express.raw({ type: "*/*" }),
  (req, res) => {
    const envelope = provider.verifyWebhook(req.body, req.headers);

    if (!envelope) {
      return res.sendStatus(401);
    }

    // …as for the other providers
  },
);
```

Three things differ from WayForPay and LiqPay, and the interface carries them rather than hiding
them:

- **The card is tokenised into a wallet.** `createSetupCheckout` sets `saveCardData.saveCard`, and
  `customerRef` becomes monobank's `walletId` so the saved card belongs to a customer you can name.
  Renewals go through `initiationKind: "merchant"`, which is what marks them merchant-initiated.
- **Refunds are keyed by invoice, not by your order reference.** Pass the `providerRef` you stored
  at charge time; it falls back to `reference` only so the common shape still works.
- **`cancelRecurring` deletes the saved card** — monobank has no subscription object to cancel, so
  removing the token is the honest equivalent. Pass the card token, not an invoice id.

Amounts are already in minor units, so nothing is converted. Currencies are ISO 4217 _numbers_ on
the wire; pass `"UAH"`, `"USD"` or `"EUR"` and `currencyNumber` maps them, or pass the number
yourself. A code it does not know is refused rather than guessed at.

## What this does not do

- **No card form.** Card entry only ever happens on the acquirer's hosted page, which is what keeps
  the compliance burden at SAQ A. Building your own form changes that by an order of magnitude.
- **No storage.** Tokens, subscriptions and payments are yours to persist. Encrypt the recurring
  token at rest; it is a bearer credential for charging that card.
- **No scheduler.** `nextDunningStep` says _when_, and your own sweep decides _how_ — a cron, a
  queue, or an interval, whichever your deployment already has.
- **No partial captures.** Nothing in the recurring path holds an amount and settles a smaller one
  later, so there is no two-step capture to model.
- **No refund policy.** `refund()` sends the amount you pass it. Whether fourteen days have passed,
  whether the period was used, and how much of it to give back are questions about your terms, not
  about the acquirer.
- **No SUSPEND / RESUME.** WayForPay documents both, but on the Regular Payments engine this
  package does not drive, and its `merchantPassword` is undocumented as to whether it wants the
  secret or a hash of it. Pausing a token-driven subscription is a row in your own table and a
  charge you do not send.

## Contributing and status

Version 0.2.0. The provider surface is what a real subscription product needed; the tests cover
signature verification, webhook shape, outcome mapping, refunds, the dunning ladder and the period
maths against tampered and malformed input, and stub `fetch` rather than reaching an acquirer.

0.2.0 added `refund()` and widened `WebhookEnvelope.outcome` with `"refunded"`. It also fixed
`cancelRecurring`, which posted WayForPay's `REMOVE` to `/api` instead of `/regularApi` — so it had
never cancelled anything — and changed its return from `void` to a `CancelResult`, because a
cancellation that quietly does nothing is the worst of the three outcomes.

Upgrading: a custom `RecurringProvider` implementation needs `refund()` and the new
`cancelRecurring` return type, and an exhaustive `switch` over a webhook outcome needs a
`"refunded"` arm. An `if` / `else if` over `succeeded` and `failed` keeps compiling, and stops
treating refunds as declines.

`npm run verify` runs lint, format check, types, tests and the build.

MIT.
