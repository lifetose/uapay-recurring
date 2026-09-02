# uapay-recurring

Recurring card billing for **WayForPay** and **LiqPay**, behind one interface.

Stripe does not contract with Ukrainian entities. The acquirers that do have no subscription
product: they will store a card and let you charge it again, and everything above that — the
renewal schedule, dunning, proration, webhook idempotency — is yours to write. This package is that
layer, extracted from a product that runs it in production.

- **No hosted subscription page.** The card is captured once on the acquirer's page, which returns
  a recurring token. Every renewal after that is a server-side charge against the stored token.
- **Signatures are verified before parsing.** WayForPay is HMAC-MD5 over a fixed field order,
  LiqPay a base64 `data` + SHA-1 `signature` envelope. Both are tested against tampered amounts,
  tampered statuses and foreign secrets.
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
payload is safe to keep as dispute evidence.

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

## Charge outcomes

Both providers map their own vocabularies onto three outcomes:

| Outcome     | WayForPay                                        | LiqPay                                                                           |
| ----------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `succeeded` | `Approved`                                       | `success`, `subscribed`, `sandbox`                                               |
| `pending`   | `InProcessing`, `WaitingAuthComplete`, `Pending` | `processing`, `prepared`, `wait_accept`, `wait_secure`, `wait_card`, `hold_wait` |
| `failed`    | everything else, including an absent status      | everything else, including an absent status                                      |

Unknown statuses fail closed. A new status neither provider documented will be treated as a failure
rather than silently activating a subscription — reconcile `pending` payments against
`provider.status(providerRef)` on a schedule rather than waiting on the webhook forever.

## API

```ts
createWayForPay(credentials, options?): RecurringProvider
createLiqPay(credentials, options?): RecurringProvider
```

`options` takes `timeoutMs` (default 15s) and `fetch`, which is how the tests drive the providers
without a network.

Every provider exposes:

| Method                         | Does                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| `createSetupCheckout(req)`     | first payment, asking the acquirer to return a recurring token          |
| `charge(req)`                  | a server-side charge against a stored token                             |
| `status(providerRef)`          | the acquirer's own view of a payment, for reconciling `pending`         |
| `cancelRecurring(providerRef)` | tells the acquirer to drop the stored token                             |
| `verifyWebhook(rawBody)`       | `WebhookEnvelope` for a valid signed callback, `null` for anything else |

Also exported: `wayforpaySignature`, `signPurchase`, `signCallback`, `signAcknowledgement`,
`liqpaySignature`, `encodeLiqPayData`, `decodeLiqPayData` — for signing a request this package does
not cover, and `wayforpayOutcome` / `liqpayOutcome` for mapping a status you read elsewhere.

## What this does not do

- **No card form.** Card entry only ever happens on the acquirer's hosted page, which is what keeps
  the compliance burden at SAQ A. Building your own form changes that by an order of magnitude.
- **No storage.** Tokens, subscriptions and payments are yours to persist. Encrypt the recurring
  token at rest; it is a bearer credential for charging that card.
- **No scheduler.** `nextDunningStep` says _when_, and your own sweep decides _how_ — a cron, a
  queue, or an interval, whichever your deployment already has.
- **No refunds or partial captures.** Neither is in the recurring path, and guessing at an API this
  package cannot test would be worse than leaving it out.

## Contributing and status

Version 0.1.0. The provider surface is what a real subscription product needed; the tests cover
signature verification, webhook shape, outcome mapping, the dunning ladder and the period maths
against tampered and malformed input, and stub `fetch` rather than reaching an acquirer.

`npm run verify` runs lint, format check, types, tests and the build.

MIT.
