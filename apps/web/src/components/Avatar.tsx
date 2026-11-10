import { useEffect, useRef } from "react";
import { blinkAmount, follow, mouthOpen, nextBlinkIn, pretendLevel } from "../avatarMath";
import { PORTRAIT } from "../portrait";

const { width: W, height: H, mouth, patch: P, maxDrop, eyes } = PORTRAIT;

/**
 * The presenter: the owner's picture, with the lower lip and chin sliding down along the lip line
 * and a dark mouth showing in the gap, scaled by how loud the voice is. A slow sway and breath keep
 * her alive. `getLevel` returns the voice's loudness (0-1), or null when the page cannot hear it
 * (the browser's own voices), in which case the mouth moves on a gentle pattern while speaking.
 */
export function Avatar({ picture, speaking, getLevel, forceBlink }: { picture: ArrayBuffer; speaking: boolean; getLevel: () => number | null; /** Hold the eyes at this closedness (0-1), for previews. */ forceBlink?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef<{ speaking: boolean; getLevel: () => number | null; forceBlink?: number }>({ speaking, getLevel, forceBlink });
  live.current = { speaking, getLevel, forceBlink };

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

      // The lids are painted in the skin just above each eye, so they suit whatever picture this is.
      const lidColour = (x: number, y: number): string => {
        try {
          const probe = document.createElement("canvas");
          probe.width = probe.height = 1;
          const pc2 = probe.getContext("2d")!;
          pc2.drawImage(img, x - 8, y + eyes.ry + 8, 16, 5, 0, 0, 1, 1); // the cheek just below, averaged down to one pixel
          const d = pc2.getImageData(0, 0, 1, 1).data;
          return [d[0]! * 0.89, d[1]! * 0.86, d[2]! * 0.85].map(Math.round).join(", "); // a lid is a touch shadowed
        } catch {
          return "205, 170, 150";
        }
      };
      const lids = eyes ? eyes.points.map((e) => lidColour(e.x, e.y)) : [];
      let blinkAt = performance.now() + 1500;
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
        if (eyes) {
          const f = live.current.forceBlink;
          if (f === undefined && now >= blinkAt + 189) blinkAt = now + nextBlinkIn() + (Math.random() < 0.15 ? -2000 : 0); // now and then, twice in a row
          const b = f ?? blinkAmount(now - blinkAt);
          if (b > 0.04) {
            eyes.points.forEach((e, k) => {
              const edge = e.y - eyes.ry + 2 * eyes.ry * b;
              ctx.save();
              ctx.beginPath();
              ctx.rect(e.x - eyes.rx - 4, e.y - eyes.ry - 4, eyes.rx * 2 + 8, edge - (e.y - eyes.ry) + 4);
              ctx.clip();
              // The lid: skin colour, solid in the middle and fading at the rim so it melts into the face.
              ctx.translate(e.x, e.y);
              ctx.scale(1, (eyes.ry + 2) / (eyes.rx + 3));
              const g = ctx.createRadialGradient(0, 0, 0, 0, 0, eyes.rx + 3);
              g.addColorStop(0, `rgba(${lids[k]}, 1)`);
              g.addColorStop(0.7, `rgba(${lids[k]}, 0.97)`);
              g.addColorStop(1, `rgba(${lids[k]}, 0)`);
              ctx.fillStyle = g;
              ctx.fillRect(-eyes.rx - 4, -eyes.rx - 4, eyes.rx * 2 + 8, eyes.rx * 2 + 8);
              ctx.restore();
              ctx.save();
              // The lash line along the lid's edge, bowed like a closed eye.
              ctx.strokeStyle = `rgba(45, 32, 28, ${0.55 * Math.min(1, b * 1.4)})`;
              ctx.lineWidth = 1.8;
              ctx.beginPath();
              ctx.moveTo(e.x - eyes.rx, edge - 1);
              ctx.quadraticCurveTo(e.x, edge + 2.5 * b, e.x + eyes.rx, edge - 1);
              ctx.stroke();
              ctx.restore();
            });
          }
        }
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
