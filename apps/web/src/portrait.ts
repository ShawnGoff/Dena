import { useEffect, useState } from "react";
import { apiBuffer } from "./api";

/**
 * The presenter picture is the owner's own file, ~/.dena/presenter/portrait.png: a person or
 * statue on a transparent background, 480x588. These are where the mouth is in it, in its own
 * pixels, found by looking. The lips part along a horizontal line at `y`; the lower lip and chin
 * slide down from there when she speaks.
 */
export const PORTRAIT = {
  width: 480,
  height: 588,
  mouth: { x: 240, y: 333 },
  /** The sliding part: how wide and tall it is, and how far down the chin sits below the lip line. */
  patch: { halfWidth: 82, height: 112, centreY: 34, radiusY: 78 },
  /** Most the lower lip drops, in picture pixels. */
  maxDrop: 14,
};

let cached: Promise<ArrayBuffer | null> | null = null;
/** For tests: forget the picture that was fetched. */
export const forgetPortrait = () => { cached = null; };
/** The picture's bytes once, or null when the owner has not added one. */
export function usePortrait(): ArrayBuffer | null {
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  useEffect(() => {
    let live = true;
    (cached ??= apiBuffer("presenter/portrait").catch(() => null)).then((b) => live && setBytes(b));
    return () => { live = false; };
  }, []);
  return bytes;
}
