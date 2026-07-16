import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/db";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdTenantIds: number[] = [];
let freePlanId: number;

async function createTenant(label: string) {
  const tenant = await prisma.tenant.create({
    data: { name: `Vitest ${label}`, apiKey: `${label}-${runId}`, planId: freePlanId },
  });
  createdTenantIds.push(tenant.id);
  return tenant;
}

beforeAll(async () => {
  const free = await prisma.plan.findUniqueOrThrow({ where: { name: "Free" } });
  freePlanId = free.id;
});

afterAll(async () => {
  await prisma.usageEvent.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
});

function record(
  apiKey: string,
  idemKey: string,
  quantity: unknown,
  usageType: unknown = "api_call"
) {
  return request(app)
    .post("/usage/record")
    .set("Authorization", `Bearer ${apiKey}`)
    .set("Idempotency-Key", idemKey)
    .send({ usageType, quantity });
}

describe("POST /usage/record — validation", () => {
  let apiKey: string;
  let tenantId: number;

  beforeAll(async () => {
    const tenant = await createTenant("validation");
    apiKey = tenant.apiKey;
    tenantId = tenant.id;
  });

  it("rejects requests without an API key", async () => {
    const res = await request(app)
      .post("/usage/record")
      .set("Idempotency-Key", "no-auth")
      .send({ usageType: "api_call", quantity: 1 });
    expect(res.status).toBe(401);
  });

  it("rejects a missing Idempotency-Key header", async () => {
    const res = await request(app)
      .post("/usage/record")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ usageType: "api_call", quantity: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/idempotency/i);
  });

  it("rejects an unknown usageType", async () => {
    const res = await record(apiKey, "bad-type", 1, "storage");
    expect(res.status).toBe(400);
  });

  it("rejects zero quantity", async () => {
    const res = await record(apiKey, "zero-qty", 0);
    expect(res.status).toBe(400);
  });

  it("rejects negative quantity", async () => {
    const res = await record(apiKey, "neg-qty", -5);
    expect(res.status).toBe(400);
  });

  it("rejects non-integer quantity", async () => {
    const res = await record(apiKey, "float-qty", 1.5);
    expect(res.status).toBe(400);
  });

  it("rejects a missing quantity", async () => {
    const res = await request(app)
      .post("/usage/record")
      .set("Authorization", `Bearer ${apiKey}`)
      .set("Idempotency-Key", "no-qty")
      .send({ usageType: "api_call" });
    expect(res.status).toBe(400);
  });

  it("records nothing for any rejected request", async () => {
    const count = await prisma.usageEvent.count({ where: { tenantId } });
    expect(count).toBe(0);
  });
});

describe("POST /usage/record — idempotency", () => {
  let apiKey: string;
  let tenantId: number;

  beforeAll(async () => {
    const tenant = await createTenant("idempotency");
    apiKey = tenant.apiKey;
    tenantId = tenant.id;
  });

  it("records once for duplicate idempotency keys", async () => {
    const first = await record(apiKey, "dup-1", 5);
    expect(first.status).toBe(201);
    expect(first.body.recorded).toBe(true);

    const second = await record(apiKey, "dup-1", 5);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const count = await prisma.usageEvent.count({
      where: { tenantId, idempotencyKey: "dup-1" },
    });
    expect(count).toBe(1); // the §8 idempotency proof
  });

  it("scopes idempotency keys per tenant", async () => {
    const other = await createTenant("idempotency-other");

    const a = await record(apiKey, "shared-key", 2);
    const b = await record(other.apiKey, "shared-key", 2);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201); // same key, different tenant → both recorded
  });

  it("survives concurrent duplicates (unique-constraint race)", async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => record(apiKey, "race-1", 3))
    );

    const created = responses.filter((r) => r.status === 201);
    const duplicates = responses.filter((r) => r.status === 200);

    expect(created.length).toBe(1);
    expect(duplicates.length).toBe(4);

    const count = await prisma.usageEvent.count({
      where: { tenantId, idempotencyKey: "race-1" },
    });
    expect(count).toBe(1);
  });
});

describe("POST /usage/record — quotas", () => {
  let apiKey: string;

  beforeAll(async () => {
    const tenant = await createTenant("quota");
    apiKey = tenant.apiKey;
  });

  it("allows filling the quota to the exact limit", async () => {
    const most = await record(apiKey, "fill-999", 999);
    expect(most.status).toBe(201);

    const exact = await record(apiKey, "fill-last", 1); // 1000/1000 on Free
    expect(exact.status).toBe(201);
  });

  it("rejects one unit past the limit with 429 and reports usage", async () => {
    const over = await record(apiKey, "over", 1);
    expect(over.status).toBe(429);
    expect(over.body.usage).toBe(1000);
    expect(over.body.limit).toBe(1000);
  });

  it("tracks token quota independently of the api_call quota", async () => {
    const tokens = await record(apiKey, "tokens-fill", 100_000, "tokens"); // exact Free token limit
    expect(tokens.status).toBe(201);

    const overTokens = await record(apiKey, "tokens-over", 1, "tokens");
    expect(overTokens.status).toBe(429);
  });
});

describe("GET /usage", () => {
  let apiKey: string;
  let tenantId: number;

  beforeAll(async () => {
    const tenant = await createTenant("get-usage");
    apiKey = tenant.apiKey;
    tenantId = tenant.id;
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/usage");
    expect(res.status).toBe(401);
  });

  it("returns zeros for a tenant with no usage", async () => {
    const res = await request(app)
      .get("/usage")
      .set("Authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apiCalls: 0, tokens: 0, cost: 0 });
  });

  it("sums the current month's usage and computes cost", async () => {
    await record(apiKey, "g-calls", 100);
    await record(apiKey, "g-tokens", 50_000, "tokens");

    const res = await request(app)
      .get("/usage")
      .set("Authorization", `Bearer ${apiKey}`);
    expect(res.body).toEqual({ apiCalls: 100, tokens: 50_000, cost: 1.1 });
  });

  it("excludes events from previous months", async () => {
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    await prisma.usageEvent.create({
      data: {
        tenantId,
        usageType: "api_call",
        quantity: 500,
        idempotencyKey: "old-event",
        createdAt: lastMonth,
      },
    });

    const res = await request(app)
      .get("/usage")
      .set("Authorization", `Bearer ${apiKey}`);
    expect(res.body.apiCalls).toBe(100); // the 500 old calls are not counted
  });
});