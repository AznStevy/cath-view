import * as THREE from "three";

/** Resting sinus rhythm, about 72 beats per minute. Systole is the short first part. */
const CYCLE_SECONDS = 0.83;
const APEX = new THREE.Vector3(0.62, -1.2, 0.32);
const AXIS = new THREE.Vector3(0.12, 0.25, 0.08).sub(APEX);
const AXIS_LEN = AXIS.length();
const AXIS_N = AXIS.clone().normalize();
const LATERAL = new THREE.Vector3(1, 0, 0).addScaledVector(AXIS_N, -AXIS_N.x).normalize();
const ANTERIOR = new THREE.Vector3().crossVectors(LATERAL, AXIS_N).normalize();
if (ANTERIOR.z < 0) ANTERIOR.negate();

type Stenosis = { vesselId: string; t: number; severity: number };
type WallBand = { angle: number; spread: number; along0: number; along1: number };

type MorphItem = {
  kind: "morph";
  mesh: THREE.Mesh;
  rest: Float32Array;
  /** Per-vertex hypokinesis, sampled from the same field as the wall. */
  loss: Float32Array;
  open: Float32Array | null;
  semilunar: boolean;
};

type RigidItem = {
  kind: "rigid";
  obj: THREE.Object3D;
  rest: THREE.Vector3;
};

type BeatItem = MorphItem | RigidItem;

const scratch = new THREE.Vector3();

function smoother(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function ramp(edge0: number, edge1: number, value: number): number {
  return smoother((value - edge0) / (edge1 - edge0));
}

/** 0 outside [a, d], rising a→b and falling c→d. */
function pulse(phase: number, a: number, b: number, c: number, d: number): number {
  if (phase <= a || phase >= d) return 0;
  if (phase < b) return smoother((phase - a) / (b - a));
  if (phase > c) return 1 - smoother((phase - c) / (d - c));
  return 1;
}

/** Quick rise at the first heart sound, hold through ejection, release by the second. */
function ventricularDrive(phase: number): number {
  const riseEnd = 0.07;
  const holdEnd = 0.3;
  const rest = 0.44;
  if (phase >= rest) return 0;
  if (phase < riseEnd) {
    const x = phase / riseEnd;
    return 1 - (1 - x) * (1 - x);
  }
  if (phase < holdEnd) return 1;
  return 1 - smoother((phase - holdEnd) / (rest - holdEnd));
}

/** Atrial contraction in late diastole, ending as the ventricles begin. */
function atrialDrive(phase: number): number {
  const start = 0.86;
  const peak = 0.94;
  if (phase >= start) {
    if (phase < peak) {
      const x = (phase - start) / (peak - start);
      return 1 - (1 - x) * (1 - x);
    }
    return 1;
  }
  if (phase < 0.05) return 1 - phase / 0.05;
  return 0;
}

const ZONES: Record<string, WallBand> = {
  lad: { angle: -0.25, spread: 1.25, along0: 0, along1: 0.7 },
  d1: { angle: 0.75, spread: 0.5, along0: 0.28, along1: 0.62 },
  d2: { angle: 0.9, spread: 0.42, along0: 0.12, along1: 0.42 },
  d3: { angle: 0.95, spread: 0.4, along0: 0, along1: 0.26 },
  s1: { angle: -1.25, spread: 0.42, along0: 0.48, along1: 0.74 },
  s2: { angle: -1.2, spread: 0.4, along0: 0.3, along1: 0.55 },
  s3: { angle: -1.15, spread: 0.38, along0: 0.14, along1: 0.38 },
  s4: { angle: -1.05, spread: 0.38, along0: 0, along1: 0.22 },
  lcx: { angle: 1.65, spread: 0.85, along0: 0.12, along1: 0.68 },
  om1: { angle: 1.35, spread: 0.42, along0: 0.38, along1: 0.68 },
  om2: { angle: 1.6, spread: 0.4, along0: 0.22, along1: 0.52 },
  om3: { angle: 1.95, spread: 0.4, along0: 0.08, along1: 0.4 },
  lpl: { angle: 2.35, spread: 0.4, along0: 0.12, along1: 0.42 },
  pda: { angle: Math.PI, spread: 0.8, along0: 0, along1: 0.42 },
  rpl: { angle: 2.55, spread: 0.4, along0: 0.12, along1: 0.4 },
};

const GRAFT_BED: Record<string, string> = {
  lima: "lad",
  "svg-om": "om1",
  "svg-pda": "pda",
};

let affected: { id: string; t0: number; loss: number }[] = [];
let stenosisGen = 0;

/**
 * Resting hypokinesis from diameter stenosis (0–1, same scale as the lesion slider).
 * Nothing below 30%. A 50% narrowing loses about 40% of its squeeze, 70% about 70%,
 * and a critical or occluded lesion is nearly still. The climb is continuous.
 */
function lossAmount(severity: number): number {
  if (severity <= 0.3) return 0;
  const u = THREE.MathUtils.clamp((severity - 0.3) / 0.7, 0, 1);
  const shaped = u * (1.65 - 0.65 * u);
  return 0.96 * Math.min(1, shaped);
}

function displace(
  x: number,
  y: number,
  z: number,
  systole: number,
  atrial: number,
  out: THREE.Vector3,
  fixedLoss: number | null,
): void {
  const px = x - APEX.x;
  const py = y - APEX.y;
  const pz = z - APEX.z;
  const along = (px * AXIS_N.x + py * AXIS_N.y + pz * AXIS_N.z) / AXIS_LEN;
  const ax = AXIS_N.x * along * AXIS_LEN;
  const ay = AXIS_N.y * along * AXIS_LEN;
  const az = AXIS_N.z * along * AXIS_LEN;
  const rx = px - ax;
  const ry = py - ay;
  const rz = pz - az;
  const radial = Math.hypot(rx, ry, rz);
  // Circumferential shortening peaks in the mid ventricle. The apex stays planted.
  const ventricular = ramp(-0.02, 0.22, along) * (1 - ramp(0.6, 0.88, along));
  const atrialWall = ramp(0.78, 0.95, along) * (1 - ramp(1.22, 1.55, along));
  const inner = 1 - ramp(0.18, 0.5, radial);
  const loss = fixedLoss !== null ? fixedLoss : systole > 0.02 ? pointLoss(x, y, z) : 0;
  const squeeze = systole * (1 - loss);
  // Outer wall moves in a little; the cavity side moves in more, so the wall thickens.
  const toward = squeeze * ventricular * (0.04 + 0.05 * inner) + atrial * atrialWall * 0.025;
  // The base descends toward the apex. Ischemic muscle shortens less.
  const alongShift =
    -squeeze * ramp(0.22, 0.72, along) * (1 - ramp(0.8, 1.05, along)) * 0.1 -
    atrial * atrialWall * 0.02;
  const scale = radial > 1e-4 ? toward / radial : 0;
  out.set(-rx * scale + AXIS_N.x * alongShift, -ry * scale + AXIS_N.y * alongShift, -rz * scale + AXIS_N.z * alongShift);
}

function angMatch(angle: number, center: number, spread: number): number {
  const d = Math.abs(Math.atan2(Math.sin(angle - center), Math.cos(angle - center)));
  if (d >= spread) return 0;
  const u = d / spread;
  if (u <= 0.55) return 1;
  return 1 - smoother((u - 0.55) / 0.45);
}

function alongMatch(along: number, a0: number, a1: number): number {
  return ramp(a0 - 0.08, a0 + 0.05, along) * (1 - ramp(a1 - 0.05, a1 + 0.1, along));
}

/** Muscle supplied beyond the stenosis loses motion. Muscle proximal to it does not. */
function distalTo(along: number, t: number, a0: number, a1: number): number {
  const supply = a0 + (a1 - a0) * (1 - t);
  return 1 - ramp(supply, supply + 0.08, along);
}

function bandMatch(angle: number, along: number, t: number, band: WallBand): number {
  return angMatch(angle, band.angle, band.spread) * alongMatch(along, band.along0, band.along1) * distalTo(along, t, band.along0, band.along1);
}

function rvFreeWall(x: number, y: number, z: number): number {
  const right = 1 - ramp(-0.05, 0.4, x);
  const front = ramp(0.12, 0.5, z);
  const body = ramp(-0.95, -0.5, y) * (1 - ramp(0.05, 0.4, y));
  return right * front * body;
}

/** How much this point belongs to the muscle supplied beyond the stenosis. */
function territory(id: string, t: number, angle: number, along: number, x: number, y: number, z: number): number {
  if (id === "lm") return Math.max(territory("lad", 0, angle, along, x, y, z), territory("lcx", 0, angle, along, x, y, z));
  if (id === "lima") return territory("lad", 0, angle, along, x, y, z);
  if (id === "svg-om") return territory("om1", 0, angle, along, x, y, z);
  if (id === "svg-pda") return territory("pda", 0, angle, along, x, y, z);

  const zone = ZONES[id];
  if (zone) {
    const wall = bandMatch(angle, along, t, zone);
    if (id !== "lad") return wall;
    const tip = 1 - ramp(0.04, 0.3, along);
    const notInferior = 1 - angMatch(angle, Math.PI, 0.65);
    return Math.max(wall, tip * (0.35 + 0.65 * notInferior) * (t < 0.72 ? 1 : distalTo(along, t, 0, 0.3)));
  }
  if (id === "rca") {
    const inferior = bandMatch(angle, along, t, { angle: Math.PI, spread: 0.95, along0: 0.02, along1: 0.6 });
    const rv = t < 0.6 ? rvFreeWall(x, y, z) * (1 - smoother(t / 0.6)) : 0;
    return Math.max(inferior, rv);
  }
  if (id === "rv" || id === "am1" || id === "am2" || id === "conus") {
    return rvFreeWall(x, y, z) * (1 - 0.4 * t);
  }
  return 0;
}

/** Resting hypokinesis in muscle supplied past a stenosis. Worse lesions lose more motion. */
function regionalLoss(x: number, y: number, z: number, along: number, angle: number): number {
  let loss = 0;
  for (const hit of affected) {
    const share = territory(hit.id, hit.t0, angle, along, x, y, z);
    loss = Math.max(loss, hit.loss * share);
  }
  return loss;
}

/**
 * Hypokinesis at a resting point. It changes smoothly across the wall, so a
 * vessel, its branches, and the dye on it all shift together.
 */
function pointLoss(x: number, y: number, z: number): number {
  if (!affected.length) return 0;
  const px = x - APEX.x;
  const py = y - APEX.y;
  const pz = z - APEX.z;
  const along = (px * AXIS_N.x + py * AXIS_N.y + pz * AXIS_N.z) / AXIS_LEN;
  if (along <= -0.08 || along >= 0.92) return 0;
  const ax = AXIS_N.x * along * AXIS_LEN;
  const ay = AXIS_N.y * along * AXIS_LEN;
  const az = AXIS_N.z * along * AXIS_LEN;
  const rx = px - ax;
  const ry = py - ay;
  const rz = pz - az;
  const lat = rx * LATERAL.x + ry * LATERAL.y + rz * LATERAL.z;
  const ant = rx * ANTERIOR.x + ry * ANTERIOR.y + rz * ANTERIOR.z;
  return regionalLoss(x, y, z, along, Math.atan2(lat, ant));
}

function buildLoss(rest: Float32Array): Float32Array {
  const loss = new Float32Array(rest.length / 3);
  if (!affected.length) return loss;
  for (let i = 0, v = 0; i < rest.length; i += 3, v++) {
    loss[v] = pointLoss(rest[i]!, rest[i + 1]!, rest[i + 2]!);
  }
  return loss;
}

function cachedLoss(obj: THREE.Object3D, rest: Float32Array): Float32Array {
  const geo = obj instanceof THREE.Mesh ? obj.geometry : null;
  const cached = obj.userData.beatLoss as Float32Array | undefined;
  if (
    cached &&
    obj.userData.beatLossGen === stenosisGen &&
    obj.userData.beatLossGeo === geo &&
    cached.length === rest.length / 3
  ) {
    return cached;
  }
  const loss = buildLoss(rest);
  obj.userData.beatLoss = loss;
  obj.userData.beatLossGen = stenosisGen;
  obj.userData.beatLossGeo = geo;
  return loss;
}

function followsWall(mesh: THREE.Mesh): boolean {
  return mesh.name === "myocardium" || Boolean(mesh.userData.isVessel);
}

/** Marks the shell so the next frame picks up newly loaded meshes. */
export function touchBeat(shell: THREE.Object3D): void {
  shell.userData.beatStamp = (shell.userData.beatStamp ?? 0) + 1;
}

export function createHeartBeat(root: THREE.Object3D): {
  setEnabled: (on: boolean) => void;
  setStenoses: (items: Stenosis[]) => void;
  update: (dt: number) => void;
} {
  let enabled = false;
  let phase = 0;
  let seen = -1;
  const items: BeatItem[] = [];

  const restore = () => {
    for (const item of items) {
      if (item.kind === "rigid") {
        item.obj.position.copy(item.rest);
        continue;
      }
      const attr = item.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      attr.array.set(item.rest);
      attr.needsUpdate = true;
      item.mesh.geometry.computeVertexNormals();
    }
  };

  const capture = () => {
    restore();
    items.length = 0;
    root.traverse((obj) => {
      if (obj.userData.beatsRigid) {
        items.push({ kind: "rigid", obj, rest: obj.position.clone() });
        return;
      }
      if (!obj.userData.beats || !(obj instanceof THREE.Mesh)) return;
      const attr = obj.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (!attr) return;
      const rest = new Float32Array(attr.array);
      if (!obj.geometry.boundingSphere) obj.geometry.computeBoundingSphere();
      if (obj.geometry.boundingSphere) obj.geometry.boundingSphere.radius += 0.35;
      const open = obj.userData.openDelta instanceof Float32Array ? obj.userData.openDelta : null;
      items.push({
        kind: "morph",
        mesh: obj,
        rest,
        loss: followsWall(obj) ? buildLoss(rest) : new Float32Array(rest.length / 3),
        open,
        semilunar: Boolean(obj.userData.semilunar),
      });
    });
  };

  const followDye = (systole: number, atrial: number) => {
    root.traverse((obj) => {
      if (!obj.userData.isDyeOverlay || !(obj instanceof THREE.Mesh)) return;
      if (obj.geometry instanceof THREE.CircleGeometry) {
        let restPos = obj.userData.beatRestPos as THREE.Vector3 | undefined;
        if (!restPos) {
          restPos = obj.position.clone();
          obj.userData.beatRestPos = restPos;
        }
        if (!enabled) {
          if (obj.userData.beatDirty) {
            obj.position.copy(restPos);
            obj.userData.beatDirty = false;
          }
          return;
        }
        displace(restPos.x, restPos.y, restPos.z, systole, atrial, scratch, pointLoss(restPos.x, restPos.y, restPos.z));
        obj.position.copy(restPos).add(scratch);
        obj.userData.beatDirty = true;
        return;
      }
      const attr = obj.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (!attr) return;
      let rest = obj.userData.beatRest as Float32Array | undefined;
      if (obj.userData.beatGeo !== obj.geometry || !rest || rest.length !== attr.count * 3) {
        rest = new Float32Array(attr.array);
        obj.userData.beatRest = rest;
        obj.userData.beatGeo = obj.geometry;
      }
      if (!enabled) {
        if (obj.userData.beatDirty) {
          attr.array.set(rest);
          attr.needsUpdate = true;
          obj.userData.beatDirty = false;
        }
        return;
      }
      const loss = cachedLoss(obj, rest);
      for (let i = 0; i < rest.length; i += 3) {
        displace(rest[i]!, rest[i + 1]!, rest[i + 2]!, systole, atrial, scratch, loss[i / 3]!);
        attr.setXYZ(i / 3, rest[i] + scratch.x, rest[i + 1] + scratch.y, rest[i + 2] + scratch.z);
      }
      attr.needsUpdate = true;
      obj.userData.beatDirty = true;
    });
  };

  const followLesions = (systole: number, atrial: number) => {
    root.traverse((obj) => {
      if (!obj.userData.isLesionMesh || !(obj instanceof THREE.Mesh)) return;
      const attr = obj.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (!attr) return;
      let rest = obj.userData.beatRest as Float32Array | undefined;
      if (obj.userData.beatGeo !== obj.geometry || !rest || rest.length !== attr.count * 3) {
        rest = new Float32Array(attr.array);
        obj.userData.beatRest = rest;
        obj.userData.beatGeo = obj.geometry;
      }
      if (!enabled) {
        if (obj.userData.beatDirty) {
          attr.array.set(rest);
          attr.needsUpdate = true;
          obj.userData.beatDirty = false;
        }
        return;
      }
      const loss = cachedLoss(obj, rest);
      for (let i = 0; i < rest.length; i += 3) {
        displace(rest[i]!, rest[i + 1]!, rest[i + 2]!, systole, atrial, scratch, loss[i / 3]!);
        attr.setXYZ(i / 3, rest[i] + scratch.x, rest[i + 1] + scratch.y, rest[i + 2] + scratch.z);
      }
      attr.needsUpdate = true;
      obj.userData.beatDirty = true;
    });
  };

  const indexCoronaries = () => {
    type Node = { id: string; takeoffT: number };
    const children = new Map<string, Node[]>();
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const c = obj.userData.contrast as
        | { id: string; parentId: string | null; takeoffT: number; tubularSegments: number }
        | undefined;
      if (!c?.tubularSegments || !c.parentId) return;
      const list = children.get(c.parentId) ?? [];
      list.push({ id: c.id, takeoffT: c.takeoffT });
      children.set(c.parentId, list);
    });
    return children;
  };

  return {
    setStenoses(stenoses: Stenosis[]) {
      affected = [];
      const children = indexCoronaries();
      const seen = new Set<string>();
      const mark = (id: string, t0: number, loss: number) => {
        const key = `${id}:${t0.toFixed(3)}:${loss.toFixed(3)}`;
        if (seen.has(key)) return;
        seen.add(key);
        affected.push({ id, t0, loss });
        for (const child of children.get(id) ?? []) {
          if (child.takeoffT >= t0 - 0.04) mark(child.id, 0, loss);
        }
        const bed = GRAFT_BED[id];
        if (bed) mark(bed, 0, loss);
      };
      for (const lesion of stenoses) {
        const loss = lossAmount(lesion.severity);
        if (loss <= 0) continue;
        mark(lesion.vesselId, lesion.t, loss);
      }
      stenosisGen++;
      for (const item of items) {
        if (item.kind === "morph" && followsWall(item.mesh)) item.loss = buildLoss(item.rest);
      }
    },
    setEnabled(on: boolean) {
      enabled = on;
      if (!on) {
        phase = 0;
        restore();
        followDye(0, 0);
        followLesions(0, 0);
      }
    },
    update(dt: number) {
      const shell = root.getObjectByName("heartShell") ?? root;
      const stamp = shell.userData.beatStamp ?? 0;
      if (stamp !== seen) {
        capture();
        seen = stamp;
      }
      if (!enabled) return;
      if (items.length === 0) return;
      phase = (phase + dt / CYCLE_SECONDS) % 1;
      const systole = ventricularDrive(phase);
      const ejection = pulse(phase, 0.08, 0.14, 0.3, 0.4);
      const filling = phase >= 0.44 || phase < 0.02 ? 1 : 0;
      const atrial = atrialDrive(phase);
      for (const item of items) {
        if (item.kind === "rigid") {
          displace(
            item.rest.x,
            item.rest.y,
            item.rest.z,
            systole,
            atrial,
            scratch,
            pointLoss(item.rest.x, item.rest.y, item.rest.z),
          );
          item.obj.position.copy(item.rest).add(scratch);
          continue;
        }
        const attr = item.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
        const rest = item.rest;
        const open = item.open;
        const amount = open ? (item.semilunar ? ejection : filling) : 0;
        const wall = followsWall(item.mesh);
        const loss = item.loss;
        for (let i = 0; i < rest.length; i += 3) {
          displace(rest[i]!, rest[i + 1]!, rest[i + 2]!, systole, atrial, scratch, wall ? loss[i / 3]! : 0);
          const ox = open ? open[i] * amount : 0;
          const oy = open ? open[i + 1] * amount : 0;
          const oz = open ? open[i + 2] * amount : 0;
          attr.setXYZ(i / 3, rest[i] + scratch.x + ox, rest[i + 1] + scratch.y + oy, rest[i + 2] + scratch.z + oz);
        }
        attr.needsUpdate = true;
        if (item.mesh.name === "myocardium") item.mesh.geometry.computeVertexNormals();
      }
      followDye(systole, atrial);
      followLesions(systole, atrial);
    },
  };
}
