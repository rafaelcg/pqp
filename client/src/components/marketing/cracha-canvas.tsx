import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
  createRope,
  endAngle,
  grabEnd,
  settleRope,
  stepRope,
  type RopePoint,
} from "@/lib/rope";
import { DEFAULT_PALETTE, drawCrachaFace } from "./cracha-face";

/**
 * The crachá: a badge on a lanyard, in three.js, that you can grab and swing.
 *
 * LAZY-LOADED ON PURPOSE. This module pulls in three.js, which is the single
 * largest dependency in the client. Nothing outside `/garanta` imports it, and
 * `Cracha` only calls `import()` once it has decided the browser can actually
 * run it. The landing page, the app and every other marketing route pay
 * nothing.
 *
 * NO PHYSICS ENGINE AND NO GLB. The rope is Verlet integration from
 * `lib/rope.ts`, which is tested in Node; the badge is a box with a canvas
 * texture from `cracha-face.ts`. The usual build of this effect ships a rigid
 * body engine and a baked `card.glb`, and neither would work here: the badge
 * has to show a name the person is still typing, which a baked texture cannot
 * do, and a solver would be a quarter of a megabyte to hang one piece of string.
 *
 * EVERY RESOURCE IS DISPOSED. Geometries, materials, textures and the renderer
 * itself all have to be released by hand; WebGL contexts are a limited resource
 * and a browser will start dropping the oldest one when a route is entered and
 * left a few dozen times.
 */

const SEGMENTS = 11;
const SPACING = 0.2;
const BADGE_W = 1.15;
const BADGE_H = 1.57;
const ORIGIN_Y = 2.05;

/** Clamped so a backgrounded tab does not hand back a second-long frame. */
const MAX_DT = 1 / 30;

export default function CrachaCanvas({
  handle,
  edition,
}: {
  handle: string;
  edition: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // The face is repainted when the handle changes without rebuilding the scene,
  // so this ref is how the effect below reaches today's text.
  const repaintRef = useRef<((handle: string) => void) | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const palette = DEFAULT_PALETTE;
    const scene = new THREE.Scene();
    // Framed to hold the whole assembly: the pin sits at ORIGIN_Y and the
    // badge's bottom edge reaches roughly -1.5, so the camera is pulled back
    // far enough that a hard swing does not clip either end.
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 0.26, 6.2);
    camera.lookAt(0, 0.26, 0);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      // Caller already probed for WebGL, but a context can still be refused
      // under memory pressure. Silence beats a broken canvas.
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.style.cursor = "grab";

    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(2.4, 3.2, 3.4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(new THREE.Color(palette.accent), 0.9);
    rim.position.set(-3, 1.2, 1.6);
    scene.add(rim);

    // ---------------------------------------------------------------- badge
    const faceCanvas = document.createElement("canvas");
    drawCrachaFace(faceCanvas, { handle, edition, palette });
    const faceTexture = new THREE.CanvasTexture(faceCanvas);
    faceTexture.colorSpace = THREE.SRGBColorSpace;
    faceTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const edgeMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.ink),
      roughness: 0.75,
      metalness: 0.05,
    });
    const faceMaterial = new THREE.MeshStandardMaterial({
      map: faceTexture,
      roughness: 0.52,
      metalness: 0.12,
    });
    // BoxGeometry material order is +x, -x, +y, -y, +z, -z. Only the front
    // carries the print; the back is deliberately blank card stock, the way a
    // real badge is.
    const badge = new THREE.Mesh(
      new THREE.BoxGeometry(BADGE_W, BADGE_H, 0.022),
      [
        edgeMaterial,
        edgeMaterial,
        edgeMaterial,
        edgeMaterial,
        faceMaterial,
        edgeMaterial,
      ],
    );
    scene.add(badge);

    repaintRef.current = (next: string) => {
      drawCrachaFace(faceCanvas, { handle: next, edition, palette });
      faceTexture.needsUpdate = true;
    };

    // ---------------------------------------------------------------- strap
    const rope: RopePoint[] = createRope({
      segments: SEGMENTS,
      spacing: SPACING,
      originX: 0,
      originY: ORIGIN_Y,
    });

    // Two vertices per rope point, offset sideways, gives a flat ribbon that
    // faces the camera. Rebuilt in place every frame rather than regenerated,
    // because allocating a geometry per frame is how a smooth thing stutters.
    const strapPositions = new Float32Array(SEGMENTS * 2 * 3);
    const strapGeometry = new THREE.BufferGeometry();
    strapGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(strapPositions, 3),
    );
    const indices: number[] = [];
    for (let i = 0; i < SEGMENTS - 1; i += 1) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    strapGeometry.setIndex(indices);
    const strapMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.accent),
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const strap = new THREE.Mesh(strapGeometry, strapMaterial);
    scene.add(strap);

    function updateStrap() {
      for (let i = 0; i < rope.length; i += 1) {
        const point = rope[i]!;
        const next = rope[Math.min(i + 1, rope.length - 1)]!;
        const dx = next.x - point.x;
        const dy = next.y - point.y;
        const length = Math.hypot(dx, dy) || 1;
        // Perpendicular in the plane, so the ribbon twists with the strap
        // instead of staying a fixed vertical band.
        const nx = (-dy / length) * 0.055;
        const ny = (dx / length) * 0.055;
        const o = i * 6;
        strapPositions[o] = point.x - nx;
        strapPositions[o + 1] = point.y - ny;
        strapPositions[o + 2] = 0;
        strapPositions[o + 3] = point.x + nx;
        strapPositions[o + 4] = point.y + ny;
        strapPositions[o + 5] = 0;
      }
      strapGeometry.attributes.position!.needsUpdate = true;
      strapGeometry.computeVertexNormals();
    }

    // ------------------------------------------------------------ interaction
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const hit = new THREE.Vector3();
    let dragging = false;

    function toWorld(event: PointerEvent): THREE.Vector3 | null {
      const box = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - box.left) / box.width) * 2 - 1;
      pointer.y = -((event.clientY - box.top) / box.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      return raycaster.ray.intersectPlane(dragPlane, hit) ? hit : null;
    }

    function onDown(event: PointerEvent) {
      const world = toWorld(event);
      if (!world) {
        return;
      }
      // Grab anywhere on the badge, generously: this is a toy and a precise
      // hit test just makes it feel broken on a phone.
      const end = rope[rope.length - 1]!;
      if (
        Math.abs(world.x - end.x) < BADGE_W &&
        Math.abs(world.y - (end.y - BADGE_H / 2)) < BADGE_H
      ) {
        dragging = true;
        renderer.domElement.setPointerCapture(event.pointerId);
        renderer.domElement.style.cursor = "grabbing";
      }
    }
    function onMove(event: PointerEvent) {
      if (!dragging) {
        return;
      }
      const world = toWorld(event);
      if (world) {
        grabEnd(rope, world.x, world.y + BADGE_H / 2);
      }
    }
    function onUp() {
      dragging = false;
      renderer.domElement.style.cursor = "grab";
    }
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("pointercancel", onUp);

    // ------------------------------------------------------------- resize
    function resize() {
      const width = host!.clientWidth || 1;
      const height = host!.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    // A hidden tab stops getting frames, so the first one after it comes back
    // carries however long the visitor was away. The per-frame clamp already
    // stops that being catastrophic, but restarting the clock here means the
    // badge does not lurch on return.
    function onVisibility() {
      if (document.visibilityState === "visible") {
        last = performance.now();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    // --------------------------------------------------------------- loop
    const physics = {
      gravity: 9.8,
      damping: 0.985,
      spacing: SPACING,
      iterations: 7,
      dt: 1 / 60,
    };

    let frame = 0;
    let last = performance.now();

    // Settle first, THEN nudge. Drawing the straight line `createRope` builds
    // and letting it fall into shape reads as a glitch on load; and a tab that
    // is throttled or was opened in the background gets very few frames, so
    // whatever pose it has after one frame is the pose the visitor sees.
    settleRope(rope, physics);
    grabEnd(rope, 0.34, rope[rope.length - 1]!.y + 0.06);

    function tick(now: number) {
      const dt = Math.min((now - last) / 1000, MAX_DT);
      last = now;
      if (!dragging) {
        stepRope(rope, { ...physics, dt });
      }
      updateStrap();

      const end = rope[rope.length - 1]!;
      const lean = endAngle(rope);
      badge.position.set(end.x, end.y - BADGE_H / 2, 0);
      badge.rotation.z = -lean;
      // A little yaw from the swing, so the card catches the light rather than
      // staying a flat rectangle sliding sideways.
      badge.rotation.y = lean * 0.55;

      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointercancel", onUp);
      repaintRef.current = null;
      badge.geometry.dispose();
      strapGeometry.dispose();
      edgeMaterial.dispose();
      faceMaterial.dispose();
      strapMaterial.dispose();
      faceTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // The scene is built once. The handle rides in through `repaintRef` below,
    // because rebuilding a WebGL context on every keystroke is exactly the
    // thing this component exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition]);

  useEffect(() => {
    repaintRef.current?.(handle);
  }, [handle]);

  return <div ref={hostRef} className="h-full w-full" aria-hidden />;
}
