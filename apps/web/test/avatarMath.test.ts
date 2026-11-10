import { describe, expect, it } from "vitest";
import { blinkAmount, follow, mouthOpen, nextBlinkIn, pretendLevel, rms } from "../src/avatarMath";

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

describe("blinking", () => {
  it("shuts quickly, reopens a little slower, and is open before and after", () => {
    expect(blinkAmount(-50)).toBe(0);
    expect(blinkAmount(0)).toBe(0);
    expect(blinkAmount(72)).toBeCloseTo(1, 5);
    expect(blinkAmount(36)).toBeCloseTo(0.5, 5);
    expect(blinkAmount(72 + 58.5)).toBeCloseTo(0.5, 5);
    expect(blinkAmount(189)).toBe(0);
    expect(blinkAmount(5000)).toBe(0);
  });
  it("waits two to six seconds between blinks", () => {
    expect(nextBlinkIn(() => 0)).toBe(2200);
    expect(nextBlinkIn(() => 1)).toBe(6000);
  });
});
