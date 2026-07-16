import { describe, it, expect } from "vitest";
import { calculateCost } from "../src/pricing";

describe("calculateCost", () => {
  it("prices the PRD example", () => {
    expect(calculateCost({ apiCalls: 500, tokens: 50_000 })).toBe(1.5);
  });

  it("returns 0 for no usage", () => {
    expect(calculateCost({ apiCalls: 0, tokens: 0 })).toBe(0);
  });

  it("rounds to cents", () => {
    expect(calculateCost({ apiCalls: 1, tokens: 1 })).toBe(0);
  });
});