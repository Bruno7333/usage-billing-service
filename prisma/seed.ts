import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const free = await prisma.plan.upsert({
    where: { name: "Free" },
    update: {},
    create: { name: "Free", monthlyPrice: 0, apiLimit: 1_000, tokenLimit: 100_000 },
  });

  await prisma.plan.upsert({
    where: { name: "Pro" },
    update: {},
    create: { name: "Pro", monthlyPrice: 2900, apiLimit: 100_000, tokenLimit: 10_000_000 },
  });

  await prisma.tenant.upsert({
    where: { apiKey: "test-key-123" },
    update: {},
    create: { name: "Test Tenant", apiKey: "test-key-123", planId: free.id },
  });
}

main().finally(() => prisma.$disconnect());