import { useEffect, useRef } from "react";
import { follow, mouthOpen, pretendLevel } from "../avatarMath";
import { PORTRAIT } from "../portrait";

const { width: W, height: H, mouth, patch: P, maxDrop } = PORTRAIT;

/**
 * The presenter: the owner's picture, with the lower lip and chin sliding down along the lip line
 * and a dark mouth showing in the gap, scaled by how loud the voice is. A slow sway and breath keep
 * her alive. `getLevel` returns the voice's loudness (0-1), or null when the page cannot hear it
 * (the browser's own voices), in which case the mouth moves on a gentle pattern while speaking.
 */
export function Avatar({ picture, speaking, getLevel }: { picture: ArrayBuffer; speaking: boolean; getLevel: () => number | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ speaking, getLevel });
  live.current = { speaking, getLevel };

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || typeof createImageBitmap === "undefined") return; // no canvas: the voice carries on without her
    let gone = false;
    let raf = 0;
    createImageBitmap(new Blob([picture], { type: "image/png" })).then((img) => {
      if (gone) return;
      // The part below the lips, cut out once with soft edges so it slides without a visible seam.
      const patch = document.createElement("canvas");
      patch.width = P.halfWidth * 2;
      patch.height = P.height;
      const pc = patch.getContext("2d")!;
      pc.drawImage(img, mouth.x - P.halfWidth, mouth.y, patch.width, P.height, 0, 0, patch.width, P.height);
      pc.globalCompositeOperation = "destination-in";
      pc.save();
      pc.translate(P.halfWidth, P.centreY);
      pc.scale(P.halfWidth / P.radiusY, 1);
      const g = pc.createRadialGradient(0, 0, P.radiusY * 0.45, 0, 0, P.radiusY);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      pc.fillStyle = g;
      pc.fillRect(-P.radiusY * 2, -P.centreY, P.radiusY * 4, P.height);
      pc.restore();

      const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      let open = 0;
      const t0 = performance.now();
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        if (document.hidden) return;
        const t = now - t0;
        const { speaking: on, getLevel: lvl } = live.current;
        open = follow(open, mouthOpen(on ? lvl() ?? pretendLevel(t) : 0));
        const drop = open * maxDrop;

        ctx.clearRect(0, 0, W, H);
        ctx.save();
        if (!calm) {
          // Sway from the base of the neck, a slow breath, and a small nod with the voice.
          ctx.translate(W / 2, H);
          ctx.rotate(Math.sin(t / 2600) * 0.008);
          ctx.scale(1 + Math.sin(t / 1900) * 0.002, 1 + Math.sin(t / 1900) * 0.003);
          ctx.translate(-W / 2, -H + open * 1.5);
        }
        ctx.drawImage(img, 0, 0, W, H);
        if (drop > 0.6) {
          // The mouth inside: dark, a little wider as it opens, with the top teeth catching light.
          const rx = 26 + open * 10;
          const ry = drop * 0.5 + 1;
          const cy = mouth.y + drop * 0.5;
          const inner = ctx.createLinearGradient(0, mouth.y, 0, mouth.y + drop);
          inner.addColorStop(0, "#d9d3cd");
          inner.addColorStop(0.28, "#3a2a2d");
          inner.addColorStop(1, "#150d0f");
          ctx.fillStyle = inner;
          ctx.beginPath();
          ctx.ellipse(mouth.x, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.drawImage(patch, mouth.x - P.halfWidth, mouth.y + drop * 0.85);
        }
        ctx.restore();
      };
      raf = requestAnimationFrame(frame);
    }, () => {});
    return () => {
      gone = true;
      cancelAnimationFrame(raf);
    };
  }, [picture]);

  return <canvas className="avatar" ref={canvas} width={W} height={H} role="img" aria-label="Animated presenter" />;
}
