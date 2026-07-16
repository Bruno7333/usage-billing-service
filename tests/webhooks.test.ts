import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import Stripe from "stripe";
import { app } from "../src/app";
import { prisma } from "../src/db";

// Only used for its signing utility — no API calls are made
const stripeUtil = new Stripe("sk_test_dummy");

const runPrefix = `evt_test_${Date.now()}`;

function makePayload(eventId: string): string {
  return JSON.stringify({
    id: eventId,
    object: "event",
    type: "payment_intent.succeeded", // deliberately unhandled: no side effects
    data: { object: { id: "pi_123" } },
  });
}

function makeEvent(eventId: string, type: string, object: Record<string, unknown>): string {
  return JSON.stringify({ id: eventId, object: "event", type, data: { object } });
}

function postWebhook(payload: string, signature?: string) {
  const header =
    signature ??
    stripeUtil.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });

  return request(app)
    .post("/webhooks/stripe")
    .set("stripe-signature", header)
    .set("content-type", "application/json")
    .send(payload);
}

afterAll(async () => {
  await prisma.processedWebhook.deleteMany({
    where: { stripeEventId: { startsWith: runPrefix } },
  });
});

describe("POST /webhooks/stripe — signature verification", () => {
  it("rejects a missing signature header with 400", async () => {
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("content-type", "application/json")
      .send(makePayload(`${runPrefix}-nosig`));
    expect(res.status).toBe(400);
  });
});

describe("POST /webhooks/stripe", () => {
  it("rejects an invalid signature with 400", async () => {
    const res = await postWebhook(makePayload(`${runPrefix}-sig`), "t=1,v1=garbage");
    expect(res.status).toBe(400);

    // and nothing was recorded as processed
    const count = await prisma.processedWebhook.count({
      where: { stripeEventId: `${runPrefix}-sig` },
    });
    expect(count).toBe(0);
  });

  it("accepts a correctly signed event", async () => {
    const res = await postWebhook(makePayload(`${runPrefix}-ok`));
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.duplicate).toBeUndefined();
  });

  it("processes a duplicate event only once", async () => {
    const payload = makePayload(`${runPrefix}-dup`);

    const first = await postWebhook(payload);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();

    const second = await postWebhook(payload);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const count = await prisma.processedWebhook.count({
      where: { stripeEventId: `${runPrefix}-dup` },
    });
    expect(count).toBe(1); // §8: duplicate webhook processed exactly once
  });
});

describe("POST /webhooks/stripe — subscription lifecycle", () => {
  const subId = `sub_test_${runPrefix}`;
  let tenantId: number;
  let freePlanId: number;
  let proPlanId: number;

  beforeAll(async () => {
    const free = await prisma.plan.findUniqueOrThrow({ where: { name: "Free" } });
    const pro = await prisma.plan.findUniqueOrThrow({ where: { name: "Pro" } });
    freePlanId = free.id;
    proPlanId = pro.id;

    const tenant = await prisma.tenant.create({
      data: { name: "Webhook Tenant", apiKey: `webhook-${runPrefix}`, planId: free.id },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.subscription.deleteMany({ where: { stripeSubscriptionId: subId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  });

  it("checkout.session.completed upgrades the tenant to Pro", async () => {
    const res = await postWebhook(
      makeEvent(`${runPrefix}-checkout`, "checkout.session.completed", {
        id: "cs_test_lifecycle",
        object: "checkout.session",
        metadata: { tenantId: String(tenantId) },
        subscription: subId,
      })
    );
    expect(res.status).toBe(200);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.planId).toBe(proPlanId);
    expect(tenant.subscriptionStatus).toBe("active");
    expect(tenant.stripeSubscriptionId).toBe(subId);

    const sub = await prisma.subscription.findUnique({
      where: { stripeSubscriptionId: subId },
    });
    expect(sub?.status).toBe("active");
  });

  it("replaying the same checkout event has no further effect", async () => {
    const res = await postWebhook(
      makeEvent(`${runPrefix}-checkout`, "checkout.session.completed", {
        id: "cs_test_lifecycle",
        object: "checkout.session",
        metadata: { tenantId: String(tenantId) },
        subscription: subId,
      })
    );
    expect(res.body.duplicate).toBe(true);

    const subCount = await prisma.subscription.count({
      where: { stripeSubscriptionId: subId },
    });
    expect(subCount).toBe(1);
  });

  it("customer.subscription.updated syncs the subscription status", async () => {
    const res = await postWebhook(
      makeEvent(`${runPrefix}-updated`, "customer.subscription.updated", {
        id: subId,
        object: "subscription",
        status: "past_due",
      })
    );
    expect(res.status).toBe(200);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.subscriptionStatus).toBe("past_due");
  });

  it("customer.subscription.deleted downgrades the tenant to Free", async () => {
    const res = await postWebhook(
      makeEvent(`${runPrefix}-deleted`, "customer.subscription.deleted", {
        id: subId,
        object: "subscription",
        status: "canceled",
      })
    );
    expect(res.status).toBe(200);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.planId).toBe(freePlanId);
    expect(tenant.subscriptionStatus).toBe("canceled");

    const sub = await prisma.subscription.findUnique({
      where: { stripeSubscriptionId: subId },
    });
    expect(sub?.status).toBe("canceled");
  });

  it("ignores a checkout event without tenant metadata", async () => {
    const res = await postWebhook(
      makeEvent(`${runPrefix}-nometa`, "checkout.session.completed", {
        id: "cs_test_nometa",
        object: "checkout.session",
        metadata: {},
        subscription: "sub_unrelated",
      })
    );
    expect(res.status).toBe(200); // acknowledged, no crash, nothing to update
  });
});
