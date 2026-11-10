import { describe, expect, it } from "vitest";
import { follow, mouthOpen, pretendLevel, rms } from "../src/avatarMath";

describe("avatar math", () => {
  it("measures loudness: silence is 0, a full-swing wave is near 1", () => {
    expect(rms(new Uint8Array(64).fill(128))).toBe(0);
    expect(rms(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 255 : 0)))).toBeGreaterThan(0.95);
    expect(rms([])).toBe(0);
  });
  it("closes the mouth for quiet gaps and caps how far it opens", () => {
    expect(mouthOpen(0.01)).toBe(0);
    expect(mouthOpen(0.1)).toBeGreaterThan(0.3);
    expect(mouthOpen(5)).toBe(1);
  });
  it("opens faster than it closes", () => {
    expect(follow(0, 1) - 0).toBeGreaterThan(1 - follow(1, 0));
  });
  it("gives the stand-in mouth a modest, always-positive movement", () => {
    for (let t = 0; t < 5000; t += 37) {
      const v = pretendLevel(t);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(0.2);
    }
  });
});
