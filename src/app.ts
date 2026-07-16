import "dotenv/config";
import express from "express";
import { requireAuth } from "./middleware/auth";
import usageRouter from "./routes/usage";

export const app = express();
app.use(express.json());
app.use("/usage", usageRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/me", requireAuth, (_req, res) => {
  res.json(res.locals.tenant);
});