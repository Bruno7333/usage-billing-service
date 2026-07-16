import "dotenv/config";
import express from "express";
import { requireAuth } from "./middleware/auth";
import usageRouter from "./routes/usage";
import billingRouter from "./routes/billing";
import webhooksRouter from "./routes/webhooks";

export const app = express();

// Webhooks need the raw body for signature verification — mount BEFORE express.json()
app.use("/webhooks", webhooksRouter);

app.use(express.json());
app.use("/usage", usageRouter);
app.use("/billing", billingRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/me", requireAuth, (_req, res) => {
  res.json(res.locals.tenant);
});