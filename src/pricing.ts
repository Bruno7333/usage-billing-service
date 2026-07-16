export const PRICING_USD = {
  api_call: 0.001,   // $1.00 per 1,000 calls
  tokens: 0.00002,   // $0.02 per 1,000 tokens
} as const;

export function calculateCost(usage: { apiCalls: number; tokens: number }): number {
  const raw =
    usage.apiCalls * PRICING_USD.api_call +
    usage.tokens * PRICING_USD.tokens;
  return Math.round(raw * 100) / 100; // round to cents at the END, never mid-calc
}