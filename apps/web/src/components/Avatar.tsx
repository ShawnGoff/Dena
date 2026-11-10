import { useEffect, useRef, useState } from "react";
import type * as T from "three";
import { apiBuffer } from "../api";
import { follow, mouthOpen, pretendLevel } from "../avatarMath";
import { BUST } from "../bust";

const W = 180;
const H = 220;
const defaultModel = () => apiBuffer("presenter/bust");

/**
 * A small 3D presenter whose mouth follows the voice. If the owner has put a bust model at
 * ~/.dena/presenter/bust.glb it is shown as white marble with a moving jaw; otherwise a plain
 * built-in character is drawn. three.js loads only when the avatar is switched on. `getLevel`
 * returns the voice's loudness (0-1), or null when the page cannot hear it (the browser's own
 * voices), in which case the mouth moves on a gentle pattern while speaking.
 */
export function Avatar({ speaking, getLevel, loadModel = defaultModel }: { speaking: boolean; getLevel: () => number | null; loadModel?: () => Promise<ArrayBuffer | null> }) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ speaking, getLevel });
  live.current = { speaking, getLevel };
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let stop = () => {};
    let gone = false;
    (async () => {
      const [THREE, { GLTFLoader }, buf] = await Promise.all([
        import("three"),
        import("three/addons/loaders/GLTFLoader.js"),
        loadModel().catch(() => null),
      ]);
      if (gone) return;
      type Mesh = InstanceType<typeof THREE.Mesh>;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch {
        setFailed(true); // no WebGL: the voice carries on without a face
        return;
      }
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setSize(W, H);
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 50);
      camera.position.set(0, 0.15, 7);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.4));
      const key = new THREE.DirectionalLight(0xffffff, 1.8);
      key.position.set(-2, 3, 4);
      scene.add(key);
      const rig = new THREE.Group();
      scene.add(rig);
      const disposables: { dispose(): void }[] = [];

      // Each face says how to move its mouth for an opening of 0-1, and how much the head may sway.
      let setOpen: (o: number) => void = () => {};
      let sway = 1;
      const eyes: InstanceType<typeof THREE.Group>[] = [];

      const buildBust = async (data: ArrayBuffer): Promise<boolean> => {
        const gltf = await new GLTFLoader().parseAsync(data, "").catch(() => null);
        let mesh: Mesh | undefined;
        gltf?.scene.traverse((o) => { if (!mesh && (o as Mesh).isMesh) mesh = o as Mesh; });
        if (!mesh) return false;
        const geo = mesh.geometry as unknown as T.BufferGeometry<T.NormalBufferAttributes>;
        geo.computeBoundingBox();
        const box = geo.boundingBox!;
        if (!geo.getAttribute("normal")) geo.computeVertexNormals();
        const size = box.getSize(new THREE.Vector3());
        const centre = box.getCenter(new THREE.Vector3());
        const u = {
          uMouthY: { value: box.min.y + size.y * BUST.mouth },
          uSoft: { value: size.y * BUST.soft },
          uJaw: { value: size.y * BUST.jaw },
          uAmt: { value: size.y * BUST.amount },
          uCentreX: { value: centre.x },
          uHalfW: { value: size.x * BUST.halfWidth },
          uOpen: { value: 0 },
        };
        const mat = new THREE.MeshPhysicalMaterial({ color: 0xf1eee8, roughness: 0.38, clearcoat: 0.25, clearcoatRoughness: 0.5 });
        mat.onBeforeCompile = (sh) => {
          Object.assign(sh.uniforms, u);
          sh.vertexShader = sh.vertexShader
            .replace("#include <common>", `#include <common>
uniform float uMouthY, uSoft, uJaw, uAmt, uCentreX, uHalfW, uOpen;
varying float vBand; varying vec3 vObj;`)
            .replace("#include <begin_vertex>", `#include <begin_vertex>
vObj = position;
float below = smoothstep(uMouthY, uMouthY - uSoft, position.y);
float toChin = 1.0 - smoothstep(uMouthY - uJaw, uMouthY - uJaw - uSoft * 2.0, position.y);
float inFace = 1.0 - smoothstep(uHalfW * 0.8, uHalfW, abs(position.x - uCentreX));
transformed.y -= uOpen * uAmt * below * toChin * inFace;
vBand = uOpen * (1.0 - smoothstep(0.0, uSoft, uMouthY - position.y)) * step(position.y, uMouthY) * inFace;`);
          sh.fragmentShader = sh.fragmentShader
            .replace("#include <common>", `#include <common>
varying float vBand; varying vec3 vObj;`)
            .replace("#include <color_fragment>", `#include <color_fragment>
float vein = sin(vObj.x * 520.0 + sin(vObj.y * 380.0) * 2.2 + sin(vObj.z * 900.0));
diffuseColor.rgb -= 0.03 * smoothstep(0.93, 1.0, vein);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.05, 0.06), clamp(vBand * 1.6, 0.0, 1.0));`);
        };
        const m = new THREE.Mesh(geo, mat);
        // Stand it upright and fit the frame: height 2.6, centred.
        const s = (2.6 * BUST.zoom) / size.y;
        m.scale.setScalar(s);
        m.position.set(-centre.x * s, -(box.min.y + size.y * BUST.focus) * s, -centre.z * s);
        rig.add(m);
        disposables.push(geo, mat);
        setOpen = (o) => { u.uOpen.value = o; };
        sway = BUST.sway;
        return true;
      };

      const buildHead = () => {
        const skin = new THREE.MeshStandardMaterial({ color: 0x7aa2f7, roughness: 0.55 });
        const dark = new THREE.MeshStandardMaterial({ color: 0x1c2233, roughness: 0.4 });
        const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
        const geos: { dispose(): void }[] = [];
        const mk = (g: T.BufferGeometry<T.NormalBufferAttributes>, m: InstanceType<typeof THREE.Material>) => { geos.push(g); return new THREE.Mesh(g, m); };
        const head = mk(new THREE.SphereGeometry(1, 48, 32), skin);
        head.scale.set(1, 1.08, 0.95);
        const antenna = mk(new THREE.CylinderGeometry(0.03, 0.03, 0.35, 12), dark);
        antenna.position.set(0, 1.22, 0);
        const bulb = mk(new THREE.SphereGeometry(0.1, 16, 12), skin);
        bulb.position.set(0, 1.45, 0);
        rig.add(head, antenna, bulb);
        for (const x of [-0.37, 0.37]) {
          const eye = new THREE.Group();
          const pupil = mk(new THREE.SphereGeometry(0.09, 16, 12), dark);
          pupil.position.z = 0.15;
          eye.add(mk(new THREE.SphereGeometry(0.2, 24, 16), white), pupil);
          eye.position.set(x, 0.2, 0.82);
          rig.add(eye);
          eyes.push(eye);
        }
        const mouth = mk(new THREE.SphereGeometry(0.3, 24, 16), dark);
        mouth.position.set(0, -0.38, 0.88);
        mouth.scale.set(1, 0.1, 0.35);
        rig.add(mouth);
        disposables.push(...geos, skin, dark, white);
        setOpen = (o) => { mouth.scale.y = 0.1 + o * 0.55; };
      };

      if (!(buf && (await buildBust(buf)))) buildHead();
      if (gone) {
        for (const d of disposables) d.dispose();
        renderer.dispose();
        return;
      }

      const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      let open = 0;
      let nextBlink = 1500;
      let raf = 0;
      const t0 = performance.now();
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        if (document.hidden) return;
        const t = now - t0;
        const { speaking: on, getLevel: lvl } = live.current;
        const raw = on ? lvl() ?? pretendLevel(t) : 0;
        open = follow(open, mouthOpen(raw));
        setOpen(open);
        if (!calm) {
          rig.rotation.y = Math.sin(t / 1800) * 0.12 * sway;
          rig.rotation.x = (Math.sin(t / 2300) * 0.04 + (on ? open * 0.05 : 0)) * sway;
          rig.position.y = Math.sin(t / 1400) * 0.03;
        }
        const blinking = t > nextBlink && t < nextBlink + 140;
        for (const e of eyes) e.scale.y = blinking ? 0.1 : 1;
        if (t > nextBlink + 140) nextBlink = t + 2000 + Math.random() * 3000;
        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(frame);

      stop = () => {
        cancelAnimationFrame(raf);
        for (const d of disposables) d.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })().catch(() => setFailed(true));
    return () => {
      gone = true;
      stop();
    };
  }, []);

  if (failed) return null;
  return <div className="avatar" ref={host} role="img" aria-label="Animated presenter" />;
}
