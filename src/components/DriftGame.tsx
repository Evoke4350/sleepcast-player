// drift — a 3D merge toy to fall asleep to, played while the podcast plays.
// Suika-shaped but sleepcast-souled: drop glowing motes into a glass bowl
// under the stars; twins merge upward (stardust → … → nebula). Custom soft
// sphere physics (no engine dep): underwater gravity reads dreamy AND makes
// stability trivial at this orb count. No sound — the night owns the audio.
// No fail state — an overfull bowl breathes out its oldest dust instead.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

const TIERS = [
  { name: "stardust", r: 0.3, color: 0x8a7a5c, glow: 0.55 },
  { name: "pebble", r: 0.42, color: 0x9c8468, glow: 0.5 },
  { name: "moonlet", r: 0.58, color: 0xb0a898, glow: 0.55 },
  { name: "moon", r: 0.78, color: 0xd9c9a8, glow: 0.7 },
  { name: "planet", r: 1.02, color: 0x7c88b8, glow: 0.75 },
  { name: "star", r: 1.3, color: 0xe8d9a0, glow: 1.1 },
  { name: "nebula", r: 1.62, color: 0xb48ad6, glow: 1.3 },
] as const;

const BOWL_R = 3.1;
const DROP_Y = 5.2;
const GRAVITY = -4.5; // slow, underwater — dreamy on purpose
const MAX_ORBS = 42;
const BEST_KEY = "drift.best";
const BOWL_KEY = "drift.bowl"; // the bowl survives the night
const REDUCED_MOTION = typeof matchMedia !== "undefined" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Orb {
  tier: number;
  mesh: THREE.Mesh;
  v: THREE.Vector3;
  born: number;
  dead?: boolean;
}

function loadBest(): number {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}

export default function DriftGame() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(loadBest);
  const [biggest, setBiggest] = useState(0);
  const [upcoming, setUpcoming] = useState(0);
  // Fullscreen is a CSS overlay, not the Fullscreen API — iPhones only
  // fullscreen <video>, and a fixed inset-0 layer behaves identically.
  const [full, setFull] = useState(false);

  useEffect(() => {
    document.body.style.overflow = full ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [full]);

  useEffect(() => {
    const host = hostRef.current!;
    const W = host.clientWidth;
    const H = host.clientHeight || 360;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x05060f, 12, 26);
    const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 60);
    camera.position.set(0, 6.4, 9.2);
    camera.lookAt(0, 1.6, 0);

    scene.add(new THREE.AmbientLight(0x8890b0, 0.55));
    const moonlight = new THREE.PointLight(0xd9c9a8, 60, 40);
    moonlight.position.set(4, 9, 5);
    scene.add(moonlight);

    // Stars: a scattered dome of points, twinkle via opacity oscillation.
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(220 * 3);
    for (let i = 0; i < 220; i++) {
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1) / 2;
      const R = 18 + Math.random() * 6;
      starPos[i * 3] = R * Math.sin(p) * Math.cos(t);
      starPos[i * 3 + 1] = Math.abs(R * Math.cos(p)) + 1;
      starPos[i * 3 + 2] = R * Math.sin(p) * Math.sin(t) - 6;
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xd9c9a8, size: 0.07, transparent: true, opacity: 0.8 });
    scene.add(new THREE.Points(starGeo, starMat));

    // Glass bowl: an open cylinder + faint floor disc + warm rim.
    const bowlMat = new THREE.MeshPhysicalMaterial({
      color: 0x39415f, transparent: true, opacity: 0.14, roughness: 0.15,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(BOWL_R + 0.08, BOWL_R * 0.86, 4.4, 48, 1, true), bowlMat);
    bowl.position.y = 2.2;
    scene.add(bowl);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(BOWL_R * 0.88, 48),
      new THREE.MeshStandardMaterial({ color: 0x11131f, roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(BOWL_R + 0.08, 0.035, 10, 64),
      new THREE.MeshStandardMaterial({ color: 0x7c6f5e, emissive: 0x3a3020, roughness: 0.4 })
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 4.4;
    scene.add(rim);

    const geos = TIERS.map((t) => new THREE.SphereGeometry(t.r, 28, 20));
    const mats = TIERS.map((t) => new THREE.MeshStandardMaterial({
      color: t.color, emissive: t.color, emissiveIntensity: t.glow * 0.35, roughness: 0.35,
    }));

    const orbs: Orb[] = [];
    let scoreNow = 0;
    let bestNow = loadBest();
    let biggestNow = 0;

    function saveBowl() {
      try {
        localStorage.setItem(BOWL_KEY, JSON.stringify({
          score: scoreNow,
          biggest: biggestNow,
          orbs: orbs.filter((o) => !o.dead).map((o) => ({
            t: o.tier,
            p: [o.mesh.position.x, o.mesh.position.y, o.mesh.position.z].map((v) => Math.round(v * 100) / 100),
          })),
        }));
      } catch { /* nicety */ }
    }

    function spawnOrb(tier: number, pos: THREE.Vector3, v = new THREE.Vector3()): Orb {
      const mesh = new THREE.Mesh(geos[tier], mats[tier]);
      mesh.position.copy(pos);
      scene.add(mesh);
      const orb: Orb = { tier, mesh, v: v.clone(), born: performance.now() };
      orbs.push(orb);
      return orb;
    }

    // Merge burst: an expanding, fading halo ring.
    const bursts: { mesh: THREE.Mesh; t: number }[] = [];
    const burstGeo = new THREE.RingGeometry(0.5, 0.62, 40);
    function burst(pos: THREE.Vector3, color: number, scale: number) {
      const m = new THREE.Mesh(burstGeo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
      }));
      m.position.copy(pos);
      m.rotation.x = -Math.PI / 2.4;
      m.scale.setScalar(scale);
      scene.add(m);
      bursts.push({ mesh: m, t: 0 });
    }

    function removeOrb(o: Orb) {
      o.dead = true;
      scene.remove(o.mesh);
    }

    // Last night's bowl, right where it was left.
    try {
      const saved = JSON.parse(localStorage.getItem(BOWL_KEY) || "null");
      if (saved?.orbs?.length) {
        for (const o of saved.orbs.slice(0, MAX_ORBS)) {
          if (typeof o.t === "number" && o.t >= 0 && o.t < TIERS.length) {
            spawnOrb(o.t, new THREE.Vector3(o.p[0], Math.max(TIERS[o.t].r, o.p[1]), o.p[2]));
          }
        }
        scoreNow = saved.score || 0;
        biggestNow = saved.biggest || 0;
        setScore(scoreNow);
        setBiggest(biggestNow);
      }
    } catch { /* fresh bowl */ }

    // ── aiming + dropping ──────────────────────────────────────────────
    const ray = new THREE.Raycaster();
    const dropPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -DROP_Y);
    let aimX = 0;
    const roll = () => (Math.random() < 0.55 ? 0 : Math.random() < 0.7 ? 1 : 2);
    let nextTier = roll();
    let upcomingTier = roll();
    setUpcoming(upcomingTier);
    const preview = new THREE.Mesh(geos[nextTier], mats[nextTier]);
    preview.position.set(0, DROP_Y, 0);
    scene.add(preview);

    function refreshPreview() {
      nextTier = upcomingTier;
      upcomingTier = roll();
      setUpcoming(upcomingTier);
      preview.geometry = geos[nextTier];
      preview.material = mats[nextTier];
    }

    function aimFromEvent(e: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      ray.setFromCamera(ndc, camera);
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(dropPlane, hit)) {
        const lim = BOWL_R - TIERS[nextTier].r - 0.1;
        aimX = Math.max(-lim, Math.min(lim, hit.x));
      }
    }

    // Landing guide — the game explains itself: a faint thread from the
    // held orb down to a glowing ring on the floor says "it falls here".
    const guideMat = new THREE.LineDashedMaterial({
      color: 0xd9c9a8, transparent: true, opacity: 0.28, dashSize: 0.18, gapSize: 0.14,
    });
    const guideGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, DROP_Y - 0.4, 0), new THREE.Vector3(0, 0.05, 0),
    ]);
    const guide = new THREE.Line(guideGeo, guideMat);
    guide.computeLineDistances();
    scene.add(guide);
    const target = new THREE.Mesh(
      new THREE.RingGeometry(0.26, 0.34, 36),
      new THREE.MeshBasicMaterial({ color: 0xd9c9a8, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false })
    );
    target.rotation.x = -Math.PI / 2;
    target.position.y = 0.02;
    scene.add(target);

    let coolUntil = 0;
    function drop() {
      const now = performance.now();
      if (now < coolUntil) return;
      coolUntil = now + 350;
      spawnOrb(nextTier, new THREE.Vector3(aimX, DROP_Y, 0));
      refreshPreview();
    }

    const onMove = (e: PointerEvent) => aimFromEvent(e);
    const onUp = (e: PointerEvent) => { aimFromEvent(e); drop(); };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.style.touchAction = "none";

    // ── physics + render loop ──────────────────────────────────────────
    let raf = 0;
    let last = performance.now();
    const tmp = new THREE.Vector3();

    function step(dt: number) {
      const now = performance.now();
      for (const o of orbs) {
        if (o.dead) continue;
        o.v.y += GRAVITY * dt;
        o.v.multiplyScalar(0.988); // thick night air
        o.mesh.position.addScaledVector(o.v, dt);
        const r = TIERS[o.tier].r;
        // floor
        if (o.mesh.position.y < r) {
          o.mesh.position.y = r;
          o.v.y = Math.abs(o.v.y) * 0.18;
        }
        // glass wall (cylindrical)
        tmp.set(o.mesh.position.x, 0, o.mesh.position.z);
        const d = tmp.length();
        const lim = BOWL_R - r;
        if (d > lim && d > 0) {
          tmp.normalize();
          o.mesh.position.x = tmp.x * lim;
          o.mesh.position.z = tmp.z * lim;
          const vn = o.v.x * tmp.x + o.v.z * tmp.z;
          if (vn > 0) { o.v.x -= 1.2 * vn * tmp.x; o.v.z -= 1.2 * vn * tmp.z; }
        }
      }
      // pairwise collide + merge
      for (let i = 0; i < orbs.length; i++) {
        const a = orbs[i];
        if (a.dead) continue;
        for (let j = i + 1; j < orbs.length; j++) {
          const b = orbs[j];
          if (b.dead) continue;
          const ra = TIERS[a.tier].r, rb = TIERS[b.tier].r;
          const dx = b.mesh.position.x - a.mesh.position.x;
          const dy = b.mesh.position.y - a.mesh.position.y;
          const dz = b.mesh.position.z - a.mesh.position.z;
          const dist2 = dx * dx + dy * dy + dz * dz;
          const min = ra + rb;
          if (dist2 >= min * min || dist2 === 0) continue;
          const dist = Math.sqrt(dist2);
          if (a.tier === b.tier && a.tier === TIERS.length - 1) {
            // two nebulas: supernova — they give themselves back to the sky
            const mid = a.mesh.position.clone().add(b.mesh.position).multiplyScalar(0.5);
            removeOrb(a); removeOrb(b);
            burst(mid, 0xffffff, 2.6);
            burst(mid, TIERS[a.tier].color, 1.8);
            navigator.vibrate?.(24);
            scoreNow += 2 ** (TIERS.length + 1);
            setScore(scoreNow);
            if (scoreNow > bestNow) {
              bestNow = scoreNow;
              setBest(bestNow);
              try { localStorage.setItem(BEST_KEY, String(bestNow)); } catch { /* nicety */ }
            }
            break;
          }
          if (a.tier === b.tier && a.tier < TIERS.length - 1) {
            // twins touch: they become one, a size up, with a halo sigh
            const mid = a.mesh.position.clone().add(b.mesh.position).multiplyScalar(0.5);
            removeOrb(a); removeOrb(b);
            const born = spawnOrb(a.tier + 1, mid, a.v.clone().add(b.v).multiplyScalar(0.25));
            born.mesh.scale.setScalar(0.4); // pops in via the loop below
            burst(mid, TIERS[a.tier + 1].color, TIERS[a.tier + 1].r * 1.6);
            navigator.vibrate?.(8);
            scoreNow += 2 ** (a.tier + 1);
            biggestNow = Math.max(biggestNow, a.tier + 1);
            setScore(scoreNow);
            setBiggest(biggestNow);
            if (scoreNow > bestNow) {
              bestNow = scoreNow;
              setBest(bestNow);
              try { localStorage.setItem(BEST_KEY, String(bestNow)); } catch { /* nicety */ }
            }
            break;
          }
          // soft push apart
          const nx = dx / dist, ny = dy / dist, nz = dz / dist;
          const overlap = min - dist;
          const wa = rb / min, wb = ra / min;
          a.mesh.position.x -= nx * overlap * wa; a.mesh.position.y -= ny * overlap * wa; a.mesh.position.z -= nz * overlap * wa;
          b.mesh.position.x += nx * overlap * wb; b.mesh.position.y += ny * overlap * wb; b.mesh.position.z += nz * overlap * wb;
          const rvx = b.v.x - a.v.x, rvy = b.v.y - a.v.y, rvz = b.v.z - a.v.z;
          const rel = rvx * nx + rvy * ny + rvz * nz;
          if (rel < 0) {
            const imp = -rel * 0.55;
            a.v.x -= imp * nx * wa; a.v.y -= imp * ny * wa; a.v.z -= imp * nz * wa;
            b.v.x += imp * nx * wb; b.v.y += imp * ny * wb; b.v.z += imp * nz * wb;
          }
        }
      }
      // pop-in tween for freshly merged orbs
      for (const o of orbs) {
        if (o.dead) continue;
        if (o.mesh.scale.x < 1) o.mesh.scale.setScalar(Math.min(1, o.mesh.scale.x + dt * 3));
      }
      // mercy: an overfull bowl breathes out its oldest dust, no fail state
      const alive = orbs.filter((o) => !o.dead);
      if (alive.length > MAX_ORBS) {
        const oldest = alive
          .filter((o) => o.tier <= 1)
          .sort((x, y) => x.born - y.born)[0];
        if (oldest) { burst(oldest.mesh.position, 0x4a4540, 0.6); removeOrb(oldest); }
      }
      // bursts fade + grow
      for (let k = bursts.length - 1; k >= 0; k--) {
        const bu = bursts[k];
        bu.t += dt;
        bu.mesh.scale.multiplyScalar(1 + dt * 2.4);
        const m = bu.mesh.material as THREE.MeshBasicMaterial;
        m.opacity = Math.max(0, 0.9 - bu.t * 1.6);
        if (bu.t > 0.6) { scene.remove(bu.mesh); m.dispose(); bursts.splice(k, 1); }
      }
      // gc dead orbs occasionally
      if (orbs.length > 120) {
        for (let k = orbs.length - 1; k >= 0; k--) if (orbs[k].dead) orbs.splice(k, 1);
      }
      preview.position.x += (aimX - preview.position.x) * Math.min(1, dt * 10);
      preview.position.y = DROP_Y + 0.1 * Math.sin(now / 700); // held, breathing
      // during the drop cooldown the next orb visibly gathers itself —
      // a tap that lands early reads as "not yet" instead of "ignored"
      const ready = now >= coolUntil;
      const targetScale = ready ? 1 : 0.55;
      preview.scale.setScalar(preview.scale.x + (targetScale - preview.scale.x) * Math.min(1, dt * 8));
      // the whole scene sways like water — barely, and never for
      // reduced-motion readers
      if (!REDUCED_MOTION) {
        camera.position.x = Math.sin(now / 9000) * 0.55;
        camera.lookAt(0, 1.6, 0);
      }
      guide.position.x = preview.position.x;
      target.position.x = preview.position.x;
      target.scale.setScalar(TIERS[nextTier].r / 0.3);
      (target.material as THREE.MeshBasicMaterial).opacity = 0.22 + 0.1 * Math.sin(now / 500);
      starMat.opacity = 0.65 + 0.2 * Math.sin(now / 1400);
    }

    function frame(t: number) {
      raf = requestAnimationFrame(frame);
      if (document.hidden) { last = t; return; } // don't simulate blind
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      step(dt);
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);

    const onResize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight || 360;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);
    window.addEventListener("resize", onResize);
    const onHide = () => { if (document.hidden) saveBowl(); };
    document.addEventListener("visibilitychange", onHide);

    return () => {
      saveBowl();
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("resize", onResize);
      guideGeo.dispose();
      guideMat.dispose();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerup", onUp);
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      burstGeo.dispose();
      starGeo.dispose();
      starMat.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={full
      ? "fixed inset-0 z-50 flex flex-col bg-[#05060f] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      : "space-y-1"}>
      <div className="relative flex-1">
        <div
          ref={hostRef}
          className={`w-full overflow-hidden ${full ? "h-full rounded-lg" : "h-[360px] rounded-xl border border-[#1e1d2a]"}`}
        />
        <button
          onClick={() => setFull((f) => !f)}
          aria-label={full ? "close fullscreen" : "fullscreen"}
          className="absolute right-2 top-2 rounded-full bg-[#11131f]/70 px-3 py-1.5 text-sm text-[#7a7264] active:scale-95"
        >
          {full ? "✕" : "⛶"}
        </button>
      </div>
      {/* the merge ladder, wordless: this becomes that becomes that… */}
      <div className="flex items-center justify-center gap-2 py-1" aria-hidden="true">
        {TIERS.map((t, i) => (
          <span
            key={t.name}
            className="rounded-full transition-opacity"
            style={{
              width: 6 + i * 3.2,
              height: 6 + i * 3.2,
              background: `#${t.color.toString(16).padStart(6, "0")}`,
              opacity: i <= Math.max(2, biggest) ? 0.9 : 0.25,
            }}
          />
        ))}
      </div>
      <div className="flex items-center justify-between px-1 text-[11px] tabular-nums text-[#4a4540]">
        <span>stardust {score}</span>
        <span className="flex items-center gap-1.5 opacity-70">
          then
          <span
            className="inline-block rounded-full"
            style={{
              width: 8 + upcoming * 3,
              height: 8 + upcoming * 3,
              background: `#${TIERS[upcoming].color.toString(16).padStart(6, "0")}`,
            }}
          />
        </span>
        <span>best {best}</span>
      </div>
    </div>
  );
}
