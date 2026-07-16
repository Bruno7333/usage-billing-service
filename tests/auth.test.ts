import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/db";

const apiKey = `auth-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let tenantId: number;

beforeAll(async () => {
  const free = await prisma.plan.findUniqueOrThrow({ where: { name: "Free" } });
  const tenant = await prisma.tenant.create({
    data: { name: "Auth Test Tenant", apiKey, planId: free.id },
  });
  tenantId = tenant.id;
});

afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } });
});

describe("GET /health", () => {
  it("responds without authentication", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("auth middleware (via GET /me)", () => {
  it("rejects a missing Authorization header", async () => {
    const res = await request(app).get("/me");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing/i);
  });

  it("rejects a non-Bearer scheme", async () => {
    const res = await request(app).get("/me").set("Authorization", `Basic ${apiKey}`);
    expect(res.status).toBe(401);
  });

  it("rejects an unknown API key", async () => {
    const res = await request(app)
      .get("/me")
      .set("Authorization", "Bearer definitely-not-a-real-key");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("accepts a valid key and returns the tenant with its plan", async () => {
    const res = await request(app).get("/me").set("Authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(tenantId);
    expect(res.body.apiKey).toBe(apiKey);
    expect(res.body.plan.name).toBe("Free");
    expect(res.body.plan.apiLimit).toBe(1_000);
  });
});
