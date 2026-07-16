import { describe, it, expect, afterAll } from "vitest";
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
