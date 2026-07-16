import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { calculateCost } from "../pricing";

const router = Router();

const recordSchema = z.object({
  usageType: z.enum(["api_call", "tokens"]),
  quantity: z.number().int().positive(),
});

function startOfMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

router.get("/", requireAuth, async (_req, res) => {
  const tenant = res.locals.tenant;
 
  const groups = await prisma.usageEvent.groupBy({
    by: ["usageType"],
    where: { tenantId: tenant.id, createdAt: { gte: startOfMonth() } },
    _sum: { quantity: true },
  });
 
  const apiCalls = groups.find((g) => g.usageType === "api_call")?._sum.quantity ?? 0;
  const tokens = groups.find((g) => g.usageType === "tokens")?._sum.quantity ?? 0;
 
  res.json({ apiCalls, tokens, cost: calculateCost({ apiCalls, tokens }) });
});


router.post("/record", requireAuth, async (req, res) => {
  const parsed = recordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
  }

  const idempotencyKey = req.header("idempotency-key");
  if (!idempotencyKey) {
    return res.status(400).json({ error: "Missing Idempotency-Key header" });
  }

  const tenant = res.locals.tenant;
  const { usageType, quantity } = parsed.data;

  // 1. replay check
  const existing = await prisma.usageEvent.findUnique({
    where: { tenantId_idempotencyKey: { tenantId: tenant.id, idempotencyKey } },
  });
  if (existing) {
    return res.status(200).json({ recorded: false, duplicate: true, eventId: existing.id });
  }

  // 2. quota check
  const agg = await prisma.usageEvent.aggregate({
    where: { tenantId: tenant.id, usageType, createdAt: { gte: startOfMonth() } },
    _sum: { quantity: true },
  });
  const current = agg._sum.quantity ?? 0;
  const limit = usageType === "api_call" ? tenant.plan.apiLimit : tenant.plan.tokenLimit;

  if (current + quantity > limit) {
    return res.status(429).json({ error: "Monthly quota exceeded", usage: current, limit });
  }

  // 3. insert — unique constraint catches concurrent duplicates
  try {
    const event = await prisma.usageEvent.create({
      data: { tenantId: tenant.id, usageType, quantity, idempotencyKey },
    });
    return res.status(201).json({ recorded: true, eventId: event.id });
  } catch (e: any) {
    if (e?.code === "P2002") {
      return res.status(200).json({ recorded: false, duplicate: true });
    }
    throw e;
  }
});

export default router;