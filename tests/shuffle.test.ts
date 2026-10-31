import { describe, expect, it } from "vitest";
import { shuffled } from "../src/lib/shuffle";

const OPTIONS = ["A", "B", "C", "D"];

describe("jumbled options", () => {
  it("keeps every option exactly once", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(shuffled(OPTIONS, `team-${i}`).sort()).toEqual(OPTIONS);
    }
  });

  it("gives one team the same order after a reload", () => {
    expect(shuffled(OPTIONS, "team:run")).toEqual(shuffled(OPTIONS, "team:run"));
  });

  it("gives teams different orders, with each option first about equally often", () => {
    const first = new Map<string, number>();
    const orders = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const order = shuffled(OPTIONS, `token-${i}:run`);
      orders.add(order.join(""));
      first.set(order[0], (first.get(order[0]) ?? 0) + 1);
    }
    expect(orders.size).toBe(24);
    for (const option of OPTIONS) {
      expect(first.get(option)!).toBeGreaterThan(350);
      expect(first.get(option)!).toBeLessThan(650);
    }
  });
});
