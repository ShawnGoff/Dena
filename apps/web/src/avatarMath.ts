/** Pure helpers for the presenter's face, kept apart from three.js so they can be tested. */

/** Root-mean-square loudness (0-1) of unsigned 8-bit time-domain samples, as an AnalyserNode gives them. */
export function rms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let s = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i]! - 128) / 128;
    s += v * v;
  }
  return Math.sqrt(s / samples.length);
}

/** Loudness to how far the mouth opens (0-1): a floor so quiet gaps close it, a ceiling so it never gapes. */
export function mouthOpen(level: number): number {
  return Math.min(1, Math.max(0, (level - 0.02) * 6));
}

/** Smooth toward a target; fast to open, slower to close, which reads as speech rather than flapping. */
export function follow(current: number, target: number): number {
  return current + (target - current) * (target > current ? 0.28 : 0.1);
}

/** A stand-in mouth movement for voices whose audio the page cannot hear (the browser's own). */
export function pretendLevel(timeMs: number): number {
  const t = timeMs / 1000;
  return 0.03 + 0.07 * Math.abs(Math.sin(t * 5.2)) * (0.6 + 0.4 * Math.sin(t * 2.1 + 1));
}
