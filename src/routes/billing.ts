import { Router } from "express";
import { stripe } from "../stripe";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.post("/checkout", requireAuth, async (_req, res) => {
  const tenant = res.locals.tenant;

  let customerId: string | null = tenant.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: tenant.name,
      metadata: { tenantId: String(tenant.id) },
    });
    customerId = customer.id;
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { stripeCustomerId: customerId },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID!, quantity: 1 }],
    success_url: "http://localhost:3000/health?checkout=success",
    cancel_url: "http://localhost:3000/health?checkout=cancel",
    metadata: { tenantId: String(tenant.id) },
  });

  res.json({ url: session.url });
});

export default router;
