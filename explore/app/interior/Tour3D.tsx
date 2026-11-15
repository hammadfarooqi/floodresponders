"use client";
// The Matterport 3D tour of one scan, with the search route drawn on the floor as a green line and a numbered
// marker at each bedroom. The camera walks along the line to each bedroom with no clicks, and then starts again.
// Drawing our own 3D objects needs the Matterport "SDK Bundle": a copy of the viewer that
// this app serves itself (public/matterport-bundle/, not in git), and an SDK key. Set both up with
// scripts/get_matterport_bundle.sh. Without them the panel shows the plain public tour with no line.
import { useEffect, useRef, useState } from "react";
import { routeIn3d, type Layout, type Point3, type SearchRoute } from "../../lib/interior/route";

const BUNDLE = "/matterport-bundle";
const KEY = process.env.NEXT_PUBLIC_MATTERPORT_SDK_KEY;
const GREEN = 0x22c55e;
const LIFT_M = 0.05;      // the line lies this far above the floor, so the floor does not hide it
const MARKER_M = 1.2;     // height of the numbered marker above the floor
const WALK_MPS = 1.2;     // speed of the camera along the line
const MIN_MOVE_MS = 900;  // a very short move still takes this long, so the view does not jump
const LOOK_DPS = 60;      // in each bedroom the camera turns one full circle at this speed (degrees per second)
const AT_STOP_MS = 600;   // then it waits this long before it goes on
const AT_END_MS = 2500;   // and this long in the last bedroom, before the walk starts again
const LOOK_DOWN_DEG = -12; // the camera looks a little down, so the line is in view

let available: Promise<boolean> | null = null;
/** True when the viewer bundle is served by this app and an SDK key is set. */
export function tour3dAvailable(): Promise<boolean> {
  if (!KEY) return Promise.resolve(false);
  available ??= fetch(`${BUNDLE}/version.txt`, { method: "HEAD" }).then(r => r.ok, () => false);
  return available;
}

// The parts of the Matterport SDK and of three.js that this file uses (full types: the bundle's sdk.d.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
type Three = any;
interface Sdk {
  App: { state: { waitUntil(f: (s: { phase: string }) => boolean): Promise<unknown> }; Phase: { PLAYING: string } };
  Camera: { rotate(horizontal: number, vertical: number, options: { speed: number }): Promise<void> };
  Sweep: { moveTo(sweep: string, options: object): Promise<string>; Transition: { INSTANT: string; FLY: string; FADEOUT: string } };
  Scene: {
    register(name: string, factory: () => object): Promise<unknown>;
    createObjects(count: number): Promise<{ addNode(): { addComponent(name: string): void }; start(): void }[]>;
  };
}

/** A round sign with the stop number, as a texture. It always faces the camera. */
function numberSign(THREE: Three, n: number) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#22c55e"; g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
  g.lineWidth = 8; g.strokeStyle = "#052e16"; g.stroke();
  g.fillStyle = "#052e16"; g.font = "800 76px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(String(n), 64, 70);
  // depthTest off: the sign shows through walls, so the responder sees where the next bedroom is.
  const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  sign.scale.set(0.42, 0.42, 1);
  return sign;
}

/** Builds the line and the markers as one three.js group. */
function routeObject(THREE: Three, legs: Point3[][], stops: Point3[]) {
  const group = new THREE.Group();
  const green = new THREE.MeshBasicMaterial({ color: GREEN });
  const v = (p: Point3, up = LIFT_M) => new THREE.Vector3(p.x, p.y + up, p.z);
  for (const leg of legs) {
    // Tension 0 keeps the tube on the straight lines between the positions.
    const curve = new THREE.CatmullRomCurve3(leg.map(p => v(p)), false, "catmullrom", 0);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, leg.length * 12, 0.04, 8, false), green));
  }
  stops.forEach((p, i) => {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.02, 32), green);
    disc.position.copy(v(p));
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, MARKER_M, 8), green);
    pole.position.copy(v(p, MARKER_M / 2));
    const sign = numberSign(THREE, i + 1);
    sign.position.copy(v(p, MARKER_M));
    group.add(disc, pole, sign);
  });
  return group;
}

export default function Tour3D({ layout, route }: { layout: Layout; route: SearchRoute }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [reached, setReached] = useState(0);   // number of bedrooms that the camera reached in this pass of the walk

  useEffect(() => {
    const f = frame.current;
    if (!f) return;
    let gone = false;
    const onLoad = async () => {
      try {
        const w = f.contentWindow as unknown as { MP_SDK: { connect(w: unknown): Promise<Sdk> } };
        const sdk = await w.MP_SDK.connect(w);
        const { legs, stops, walk } = routeIn3d(layout, route);
        await sdk.Scene.register("rollcall.route", () => ({
          onInit(this: { context: { three: Three }; outputs: { objectRoot: unknown } }) {
            this.outputs.objectRoot = routeObject(this.context.three, legs, stops);
          },
        }));
        const [object] = await sdk.Scene.createObjects(1);
        object.addNode().addComponent("rollcall.route");
        object.start();
        await sdk.App.state.waitUntil(s => s.phase === sdk.App.Phase.PLAYING);
        const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
        const T = sdk.Sweep.Transition;
        for (let pass = 0; !gone; pass++) {
          for (const [i, s] of walk.entries()) {
            // The first move of a pass puts the camera at the start of the route. Each other move is one step along the line.
            const how = i > 0 ? { transition: T.FLY, transitionTime: Math.max(MIN_MOVE_MS, s.meters / WALK_MPS * 1000) }
              : { transition: pass ? T.FADEOUT : T.INSTANT };
            const move = sdk.Sweep.moveTo(s.sweep, { ...how, ...(s.yawDeg !== null && { rotation: { x: LOOK_DOWN_DEG, y: s.yawDeg } }) });
            // If the very first move fails, the scan data is wrong: show the plain tour. A later move can fail when the
            // user clicks in the tour at the same time; the walk then goes on with the next move.
            const warn = (e: unknown) => console.warn("3D tour move:", e);
            await (pass || i ? move.catch(warn) : move);
            if (gone) return;
            if (i === 0) { setReached(0); setState("ready"); await wait(MIN_MOVE_MS); }
            if (s.stop) {   // in a bedroom: look around the whole room
              setReached(s.stop);
              await sdk.Camera.rotate(360, 0, { speed: LOOK_DPS }).catch(warn);
              await wait(s.stop === stops.length ? AT_END_MS : AT_STOP_MS);
            }
            if (gone) return;
          }
          if (walk.length < 2) return;   // the start is the only stop: there is no walk to play again
        }
      } catch (e) {
        console.error("3D tour:", e);
        if (!gone) setState("failed");
      }
    };
    f.addEventListener("load", onLoad);
    return () => { gone = true; f.removeEventListener("load", onLoad); };
  }, [layout, route]);

  if (state === "failed") return <>
    <div className="il-warn">The route could not be drawn in the 3D tour (see the browser log). This is the plain tour.</div>
    <iframe src={`${layout.url}&play=1&qs=1&brand=0`} title="Matterport 3D tour" allow="fullscreen; xr-spatial-tracking" allowFullScreen />
  </>;
  return <>
    <iframe ref={frame} key={layout.id} title="Matterport 3D tour with the search route" allow="fullscreen; xr-spatial-tracking" allowFullScreen
      src={`${BUNDLE}/showcase.html?m=${layout.id}&applicationKey=${KEY}&play=1&qs=1&brand=0`} />
    <div className="il-legend">{state === "loading" ? "Loading the 3D tour…"
      : <><b>{reached < route.stops.length ? `Walking to bedroom ${reached + 1} of ${route.stops.length}` : route.stops.length > 1 ? "All bedrooms reached" : "Bedroom reached"}</b>
        <span>The camera follows the green line, looks around each bedroom, and then starts again. The numbered signs mark the bedrooms and show through walls.</span></>}</div>
  </>;
}
