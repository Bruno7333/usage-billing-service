import { Router, raw } from "express";
import type Stripe from "stripe";
import { stripe } from "../stripe";
import { prisma } from "../db";

const router = Router();

router.post("/stripe", raw({ type: "application/json" }), async (req, res) => {
  const sig = req.header("stripe-signature");
  if (!sig) {
    return res.status(400).json({ error: "Missing signature" });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch {
    return res.status(400).json({ error: "Invalid signature" });
  }

  // Dedupe: the unique constraint on stripeEventId guarantees exactly-once processing
  try {
    await prisma.processedWebhook.create({ data: { stripeEventId: event.id } });
  } catch (e: any) {
    if (e?.code === "P2002") {
      return res.status(200).json({ received: true, duplicate: true });
    }
    throw e;
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const tenantId = Number(session.metadata?.tenantId);
      if (!tenantId) break;

      const pro = await prisma.plan.findUniqueOrThrow({ where: { name: "Pro" } });
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          planId: pro.id,
          subscriptionStatus: "active",
          stripeSubscriptionId:
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription?.id ?? null,
        },
      });

      if (typeof session.subscription === "string") {
        await prisma.subscription.upsert({
          where: { stripeSubscriptionId: session.subscription },
          update: { status: "active" },
          create: {
            tenantId,
            stripeSubscriptionId: session.subscription,
            status: "active",
          },
        });
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: sub.id },
        data: { status: sub.status },
      });
      await prisma.tenant.updateMany({
        where: { stripeSubscriptionId: sub.id },
        data: { subscriptionStatus: sub.status },
      });
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const free = await prisma.plan.findUniqueOrThrow({ where: { name: "Free" } });
      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: sub.id },
        data: { status: "canceled" },
      });
      await prisma.tenant.updateMany({
        where: { stripeSubscriptionId: sub.id },
        data: { planId: free.id, subscriptionStatus: "canceled" },
      });
      break;
    }
  }

  res.status(200).json({ received: true });
});

export default router;
