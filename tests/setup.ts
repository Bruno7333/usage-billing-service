// Runs before every test file (see vitest.config.ts).
// Webhook tests sign payloads themselves, so they must control the secret —
// and the Stripe client must construct even without a real .env key.
process.env.STRIPE_SECRET_KEY ??= "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_dummy";
