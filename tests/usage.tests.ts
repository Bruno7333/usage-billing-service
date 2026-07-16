import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/db";

const apiKey = `vitest-key-${Date.now()}`;
let tenantId: number;

beforeAll(async () => {
  const free = await prisma.plan.findUniqueOrThrow({ where: { name: "Free" } });
  const tenant = await prisma.tenant.create({
    data: { name: "Vitest Tenant", apiKey, planId: free.id },
  });
  tenantId = tenant.id;
});

afterAll(async () => {
  await prisma.usageEvent.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
});

function record(idemKey: string, quantity: number) {
  return request(app)
    .post("/usage/record")
    .set("Authorization", `Bearer ${apiKey}`)
    .set("Idempotency-Key", idemKey)
    .send({ usageType: "api_call", quantity });
}

describe("POST /usage/record", () => {
  it("records once for duplicate idempotency keys", async () => {
    const first = await record("dup-1", 5);
    expect(first.status).toBe(201);

    const second = await record("dup-1", 5);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const count = await prisma.usageEvent.count({ where: { tenantId } });
    expect(count).toBe(1); // not 2 — the §8 idempotency proof
  });

  it("allows reaching the limit exactly, rejects one past it", async () => {
    await record("fill", 995); // 5 already used above → exactly 1000
    const over = await record("over", 1);
    expect(over.status).toBe(429);
  });
});