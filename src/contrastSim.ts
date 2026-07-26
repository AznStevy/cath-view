import * as THREE from "three";

/**
 * Epicardial coronary contrast velocity at 100% sim speed.
 * ~3.1 units/s → longest root→tip path fills in ~1.3–1.5 s,
 * closer to selective-injection opacification / epicardial flow.
 */
const FLOW_UNITS_PER_SEC = 3.1;
const HOLD_SEC = 0.55;
const CLEAR_PAUSE_SEC = 0.28;

const DYE_COLOR = 0xd8e8f0;

/** Dimmed anatomy so dye reads clearly (fluoro-style). */
const DIM_VESSEL_OPACITY = 0.1;
const DIM_HEART_OPACITY = 0.06;
const DIM_FLOOR_OPACITY = 0.06;
const DIM_EMISSIVE = 0.015;

export type InjectionSide = "left" | "right" | "both" | "lad" | "lcx";

/** Stenosis segment that slows / blocks contrast along a vessel. */
export type LesionFlow = {
  vesselId: string;
  t0: number;
  t1: number;
  /** Residual lumen area fraction ∈ [0, 1]. */
  residualArea: number;
  /** Residual radius samples around the circumference. */
  profile: number[];
};

export type DyeUniforms = {
  front: { value: number };
  wash: { value: number };
  amount: { value: number };
  soft: { value: number };
  color: { value: THREE.Color };
  time: { value: number };
  capRole: { value: number };
};

export type ContrastVessel = {
  id: string;
  parentId: string | null;
  length: number;
  curve: THREE.CatmullRomCurve3;
  takeoffT: number;
  startDelay: number;
  dye: DyeUniforms;
  mesh: THREE.Mesh;
  materials: THREE.MeshStandardMaterial[];
  indexCount: number;
  tubularSegments: number;
  radialSegments: number;
};

type Phase = "fill" | "hold" | "wash" | "pause";

export type ContrastSim = {
  readonly active: boolean;
  readonly speed: number;
  readonly side: InjectionSide | null;
  setActive(on: boolean): void;
  setSpeed(speed01: number): void;
  /** Start / restart injection (LCA, RCA, both, or selective LAD / LCx). */
  engage(side: InjectionSide): void;
  /** Keep sim armed but clear dye, undim, and wait for another vessel click. */
  clearSelection(): void;
  /**
   * Lesions affect fill: CTO stops dye, partial stenoses slow the front
   * and thin opacification distal to the narrowing. Eccentric plaque can
   * also seal a branch takeoff when residual radius at that angle is ~0.
   */
  setLesionFlows(flows: LesionFlow[]): void;
  /**
   * Resolve click → injection target.
   * LAD / LCx (and their branches) are selective; LM = whole left;
   * near the gap between ostia → both.
   */
  pickSide(
    ray: THREE.Ray,
    hitMesh: THREE.Mesh | null,
    hitPoint: THREE.Vector3 | null,
  ): InjectionSide | null;
  update(dt: number): void;
  dispose(): void;
};

export function createDyeUniforms(capRole: 0 | 1 | 2 = 0): DyeUniforms {
  return {
    front: { value: 0 },
    wash: { value: 0 },
    amount: { value: 0 },
    soft: { value: 0.04 },
    color: { value: new THREE.Color(DYE_COLOR) },
    time: { value: 0 },
    capRole: { value: capRole },
  };
}

export function closestParamOnCurve(
  curve: THREE.CatmullRomCurve3,
  point: THREE.Vector3,
  samples = 64,
): number {
  let bestT = 0;
  let bestD = Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    curve.getPointAt(t, p);
    const d = p.distanceToSquared(point);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  const span = 1 / samples;
  const t0 = Math.max(0, bestT - span);
  const t1 = Math.min(1, bestT + span);
  for (let i = 0; i <= 16; i++) {
    const t = t0 + ((t1 - t0) * i) / 16;
    curve.getPointAt(t, p);
    const d = p.distanceToSquared(point);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  return bestT;
}

type DyeOverlay = {
  vessel: ContrastVessel;
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  startCap: THREE.Mesh;
  endCap: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  /** Opacity scale from parent lesions proximal to this vessel's takeoff. */
  uBaseAmt: { value: number };
  uLesionCount: { value: number };
  uLesionT0: { value: Float32Array };
  uLesionT1: { value: Float32Array };
  uLesionFac: { value: Float32Array };
};

type MatBackup = {
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
  emissiveIntensity?: number;
  visible?: boolean;
};

/** Classify a vessel into the finest selectable injection target. */
function vesselTarget(
  byId: Map<string, ContrastVessel>,
  id: string,
): InjectionSide | null {
  let cur: string | null = id;
  for (let i = 0; i < 24 && cur; i++) {
    if (cur === "lad") return "lad";
    if (cur === "lcx") return "lcx";
    if (cur === "lm") return "left";
    if (cur === "rca") return "right";
    cur = byId.get(cur)?.parentId ?? null;
  }
  return null;
}

function isInSubtree(
  byId: Map<string, ContrastVessel>,
  id: string,
  rootId: string,
): boolean {
  let cur: string | null = id;
  for (let i = 0; i < 24 && cur; i++) {
    if (cur === rootId) return true;
    if (cur === "lm" || cur === "rca") return false;
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

function rayPointDistance(ray: THREE.Ray, point: THREE.Vector3): number {
  const closest = new THREE.Vector3();
  ray.closestPointToPoint(point, closest);
  return closest.distanceTo(point);
}

export function createContrastSim(
  anatomy: THREE.Object3D,
  dimExtras: THREE.Object3D[] = [],
): ContrastSim {
  const vessels: ContrastVessel[] = [];
  const byId = new Map<string, ContrastVessel>();

  anatomy.traverse((obj) => {
    const c = obj.userData.contrast as ContrastVessel | undefined;
    if (c && obj instanceof THREE.Mesh) {
      vessels.push(c);
      byId.set(c.id, c);
    }
  });

  for (const v of vessels) {
    if (!v.parentId) {
      v.takeoffT = 0;
      continue;
    }
    const parent = byId.get(v.parentId);
    if (!parent) {
      v.takeoffT = 0;
      continue;
    }
    v.takeoffT = closestParamOnCurve(parent.curve, v.curve.getPointAt(0));
  }

  const order = [...vessels].sort((a, b) => {
    const depth = (id: string | null, guard = 0): number => {
      if (!id || guard > 20) return 0;
      const n = byId.get(id);
      if (!n?.parentId) return guard;
      return depth(n.parentId, guard + 1);
    };
    return depth(a.id) - depth(b.id);
  });

  for (const v of order) {
    if (!v.parentId) {
      v.startDelay = 0;
      continue;
    }
    const parent = byId.get(v.parentId);
    if (!parent) {
      v.startDelay = 0;
      continue;
    }
    v.startDelay = parent.startDelay + parent.length * v.takeoffT;
  }

  const leftOstLocal = byId.get("lm")?.curve.getPointAt(0).clone() ?? new THREE.Vector3();
  const rightOstLocal = byId.get("rca")?.curve.getPointAt(0).clone() ?? new THREE.Vector3();

  const dyeMat = new THREE.MeshStandardMaterial({
    color: DYE_COLOR,
    emissive: DYE_COLOR,
    emissiveIntensity: 0.75,
    roughness: 0.32,
    metalness: 0.04,
    transparent: true,
    opacity: 0.95,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const MAX_DYE_LESIONS = 8;

  function dyeBaseRadius(v: ContrastVessel, t: number): number {
    const startCap = v.mesh.children.find(
      (c) =>
        c instanceof THREE.Mesh &&
        c.geometry instanceof THREE.CircleGeometry &&
        c.position.distanceTo(v.curve.getPointAt(0)) < 0.05,
    ) as THREE.Mesh | undefined;
    const endCap = v.mesh.children.find(
      (c) =>
        c instanceof THREE.Mesh &&
        c.geometry instanceof THREE.CircleGeometry &&
        c !== startCap,
    ) as THREE.Mesh | undefined;
    const r0 =
      startCap?.geometry instanceof THREE.CircleGeometry
        ? (startCap.geometry.parameters.radius ?? 0.04)
        : 0.04;
    const r1 =
      endCap?.geometry instanceof THREE.CircleGeometry
        ? (endCap.geometry.parameters.radius ?? r0 * 0.6)
        : r0 * 0.6;
    return THREE.MathUtils.lerp(r0, r1, THREE.MathUtils.clamp(t, 0, 1));
  }

  function sampleLesionProfile(profile: number[], angle: number): number {
    const n = profile.length;
    if (!n) return 1;
    const u = ((angle / (Math.PI * 2)) % 1 + 1) % 1;
    const x = u * n;
    const i0 = Math.floor(x) % n;
    const i1 = (i0 + 1) % n;
    const f = x - Math.floor(x);
    return profile[i0] * (1 - f) + profile[i1] * f;
  }

  /** Residual-lumen scale at (t, angle) from overlapping lesions (1 = full caliber). */
  function lumenScaleAt(
    lesions: LesionFlow[],
    t: number,
    angle: number,
  ): number {
    let scale = 1;
    for (const f of lesions) {
      if (t < f.t0 || t > f.t1) continue;
      const u = (t - f.t0) / Math.max(1e-4, f.t1 - f.t0);
      const pinch = 0.5 - 0.5 * Math.cos(u * Math.PI * 2);
      const residual = Math.max(0.03, sampleLesionProfile(f.profile, angle));
      const local = THREE.MathUtils.lerp(1, residual, pinch);
      scale = Math.min(scale, local);
    }
    return scale;
  }

  /**
   * Dye tube matching vessel topology, pinched to residual lumen through lesions
   * so contrast fills the stenosis channel — not the full vessel outline.
   */
  function buildDyeGeometry(
    v: ContrastVessel,
    lesions: LesionFlow[],
  ): THREE.BufferGeometry {
    const tubular = v.tubularSegments;
    const radial = v.radialSegments;
    const frames = v.curve.computeFrenetFrames(tubular, false);
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const normal = new THREE.Vector3();
    const vertex = new THREE.Vector3();

    for (let i = 0; i <= tubular; i++) {
      const t = i / tubular;
      const p = v.curve.getPointAt(t);
      const N = frames.normals[i];
      const B = frames.binormals[i];
      const rBase = dyeBaseRadius(v, t) * 0.92;

      for (let j = 0; j <= radial; j++) {
        const vv = j / radial;
        const angle = vv * Math.PI * 2;
        const sin = Math.sin(angle);
        const cos = -Math.cos(angle);
        const scale = lumenScaleAt(lesions, t, angle);
        const radius = rBase * scale;

        normal
          .set(cos * N.x + sin * B.x, cos * N.y + sin * B.y, cos * N.z + sin * B.z)
          .normalize();
        vertex.copy(p).addScaledVector(normal, radius);
        positions.push(vertex.x, vertex.y, vertex.z);
        normals.push(normal.x, normal.y, normal.z);
        uvs.push(t, vv);
      }
    }

    for (let i = 0; i < tubular; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * (radial + 1) + j;
        const b = (i + 1) * (radial + 1) + j;
        const c = (i + 1) * (radial + 1) + j + 1;
        const d = i * (radial + 1) + j + 1;
        indices.push(a, b, d, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setIndex(indices);
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    return geo;
  }

  function patchDyeLesionShader(
    mat: THREE.MeshStandardMaterial,
    uBaseAmt: { value: number },
    uLesionCount: { value: number },
    uLesionT0: { value: Float32Array },
    uLesionT1: { value: Float32Array },
    uLesionFac: { value: Float32Array },
  ) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uBaseAmt = uBaseAmt;
      shader.uniforms.uLesionCount = uLesionCount;
      shader.uniforms.uLesionT0 = uLesionT0;
      shader.uniforms.uLesionT1 = uLesionT1;
      shader.uniforms.uLesionFac = uLesionFac;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\nvarying float vDyeAlong;`,
        )
        .replace(
          "#include <uv_vertex>",
          `#include <uv_vertex>\nvDyeAlong = uv.x;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying float vDyeAlong;
uniform float uBaseAmt;
uniform float uLesionCount;
uniform float uLesionT0[${MAX_DYE_LESIONS}];
uniform float uLesionT1[${MAX_DYE_LESIONS}];
uniform float uLesionFac[${MAX_DYE_LESIONS}];`,
        )
        .replace(
          "#include <tonemapping_fragment>",
          `float dyeMul = uBaseAmt;
for (int i = 0; i < ${MAX_DYE_LESIONS}; i++) {
  if (float(i) >= uLesionCount) break;
  // Smooth ramp through the lesion and a soft tail distal to it
  float t0 = uLesionT0[i];
  float t1 = uLesionT1[i];
  float soft = max(0.08, (t1 - t0) * 0.9 + 0.05);
  float blendEnd = min(1.0, t1 + soft);
  float w = smoothstep(t0, blendEnd, vDyeAlong);
  dyeMul *= mix(1.0, uLesionFac[i], w);
}
gl_FragColor.a *= dyeMul;
#include <tonemapping_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => "dye-lesion-dim-v3";
  }

  /** How much contrast remains distal to a stenosis (0–1). */
  function lesionTransmit(residualArea: number): number {
    return Math.max(0.28, Math.pow(Math.max(0.02, residualArea), 0.35));
  }

  const overlays: DyeOverlay[] = vessels.map((v) => {
    const geo = buildDyeGeometry(v, []);
    const uBaseAmt = { value: 1 };
    const uLesionCount = { value: 0 };
    const uLesionT0 = { value: new Float32Array(MAX_DYE_LESIONS) };
    const uLesionT1 = { value: new Float32Array(MAX_DYE_LESIONS) };
    const uLesionFac = { value: new Float32Array(MAX_DYE_LESIONS).fill(1) };
    const mat = dyeMat.clone();
    patchDyeLesionShader(
      mat,
      uBaseAmt,
      uLesionCount,
      uLesionT0,
      uLesionT1,
      uLesionFac,
    );

    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.userData.isDyeOverlay = true;
    geo.setDrawRange(0, 0);

    const capMat = dyeMat.clone();
    const startCap = new THREE.Mesh(new THREE.CircleGeometry(0.01, 10), capMat);
    startCap.visible = false;
    startCap.userData.isDyeOverlay = true;
    const endCap = new THREE.Mesh(
      new THREE.CircleGeometry(0.01, 10),
      capMat.clone(),
    );
    endCap.visible = false;
    endCap.userData.isDyeOverlay = true;

    v.mesh.children.forEach((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (!(child.geometry instanceof THREE.CircleGeometry)) return;
      if (child.userData.isDyeOverlay) return;
      const params = child.geometry.parameters;
      const r = (params.radius ?? 0.02) * 1.06;
      const isStart = child.position.distanceTo(v.curve.getPointAt(0)) < 0.05;
      const cap = isStart ? startCap : endCap;
      cap.geometry.dispose();
      cap.geometry = new THREE.CircleGeometry(r, 12);
      cap.position.copy(child.position);
      cap.quaternion.copy(child.quaternion);
    });

    mesh.add(startCap, endCap);
    v.mesh.add(mesh);
    return {
      vessel: v,
      mesh,
      geo,
      startCap,
      endCap,
      mat,
      uBaseAmt,
      uLesionCount,
      uLesionT0,
      uLesionT1,
      uLesionFac,
    };
  });

  function rebuildDyeGeometries() {
    for (const o of overlays) {
      const lesions = flowsByVessel.get(o.vessel.id) ?? [];
      const next = buildDyeGeometry(o.vessel, lesions);
      o.mesh.geometry.dispose();
      o.mesh.geometry = next;
      o.geo = next;
      o.geo.setDrawRange(0, 0);
    }
  }

  const leftWorld = new THREE.Vector3();
  const rightWorld = new THREE.Vector3();
  const midWorld = new THREE.Vector3();

  const matBackups = new Map<object, MatBackup>();

  let active = false;
  let speed = 1;
  let side: InjectionSide | null = null;
  let phase: Phase = "fill";
  let injectDist = 0;
  let washDist = 0;
  let phaseTimer = 0;
  let simTime = 0;
  let maxEnd = 0;
  let lesionFlows: LesionFlow[] = [];
  const flowsByVessel = new Map<string, LesionFlow[]>();

  function rebuildFlowIndex() {
    flowsByVessel.clear();
    for (const f of lesionFlows) {
      const list = flowsByVessel.get(f.vesselId) ?? [];
      list.push(f);
      flowsByVessel.set(f.vesselId, list);
    }
  }

  function sampleProfile(profile: number[], angle: number): number {
    const n = profile.length;
    if (!n) return 1;
    const u = ((angle / (Math.PI * 2)) % 1 + 1) % 1;
    const x = u * n;
    const i0 = Math.floor(x) % n;
    const i1 = (i0 + 1) % n;
    const frac = x - Math.floor(x);
    return profile[i0] * (1 - frac) + profile[i1] * frac;
  }

  /** Resistance multiplier along vessel at parameter t (≥1). */
  function resistanceAt(vesselId: string, t: number): number {
    const list = flowsByVessel.get(vesselId);
    if (!list?.length) return 1;
    let r = 1;
    for (const f of list) {
      if (t < f.t0 || t > f.t1) continue;
      if (f.residualArea < 0.02) return 1e6;
      // Poiseuille-ish: flow ~ area² → resistance ~ 1/area², soft-clamped
      const local = 1 / Math.max(0.04, f.residualArea * f.residualArea);
      r = Math.max(r, local);
    }
    return r;
  }

  /**
   * Effective path length of a vessel (physical length stretched by stenoses).
   * Used so dye advances slower through narrow segments.
   */
  function effectiveVesselLength(v: ContrastVessel): number {
    const list = flowsByVessel.get(v.id);
    if (!list?.length) return v.length;
    let extra = 0;
    for (const f of list) {
      if (f.residualArea < 0.02) continue; // hard-capped separately
      const span = Math.max(0, f.t1 - f.t0) * v.length;
      const factor = 1 / Math.max(0.06, Math.sqrt(f.residualArea));
      extra += span * (factor - 1);
    }
    return v.length + extra;
  }

  /** Max dye front t along this vessel (CTO + sealed branch takeoffs). */
  function occlusionCap(v: ContrastVessel): number {
    // Ancestor CTO / sealed takeoff
    let child: ContrastVessel = v;
    let parent = v.parentId ? byId.get(v.parentId) : undefined;
    let guard = 0;
    while (parent && guard++ < 24) {
      const list = flowsByVessel.get(parent.id);
      if (list) {
        for (const f of list) {
          if (f.residualArea < 0.02 && child.takeoffT >= f.t0 - 1e-4) {
            return 0;
          }
          // Eccentric plaque covering this child's takeoff angle
          if (
            child.takeoffT >= f.t0 - 1e-4 &&
            child.takeoffT <= f.t1 + 1e-4 &&
            f.profile.length
          ) {
            const frames = parent.curve.computeFrenetFrames(24, false);
            const fi = Math.round(child.takeoffT * 24);
            const N = frames.normals[fi] ?? frames.normals[0];
            const B = frames.binormals[fi] ?? frames.binormals[0];
            const dir = child.curve.getTangentAt(0).normalize();
            const ang = Math.atan2(dir.dot(B), dir.dot(N));
            if (sampleProfile(f.profile, ang) < 0.06) return 0;
          }
        }
      }
      child = parent;
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }

    // Own CTO: stop at earliest occlusive start
    const own = flowsByVessel.get(v.id);
    let cap = 1;
    if (own) {
      for (const f of own) {
        if (f.residualArea < 0.02) cap = Math.min(cap, f.t0);
      }
    }
    return cap;
  }

  /** Inherited thinning from parent lesions that sit proximal to this takeoff. */
  function inheritedAmountFactor(v: ContrastVessel): number {
    let factor = 1;
    let cur: ContrastVessel | undefined = v;
    let guard = 0;
    while (cur?.parentId && guard++ < 24) {
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      const list = flowsByVessel.get(parent.id);
      if (list) {
        for (const f of list) {
          // Only if this branch originates distal to the lesion
          if (cur.takeoffT > f.t1) {
            factor *= lesionTransmit(f.residualArea);
          }
        }
      }
      cur = parent;
    }
    return THREE.MathUtils.clamp(factor, 0.2, 1);
  }

  function syncOverlayLesionUniforms(o: DyeOverlay) {
    const v = o.vessel;
    o.uBaseAmt.value = inheritedAmountFactor(v);
    const own = flowsByVessel.get(v.id) ?? [];
    const sorted = [...own].sort((a, b) => a.t0 - b.t0);
    const n = Math.min(MAX_DYE_LESIONS, sorted.length);
    o.uLesionCount.value = n;
    for (let i = 0; i < MAX_DYE_LESIONS; i++) {
      if (i < n) {
        o.uLesionT0.value[i] = sorted[i].t0;
        o.uLesionT1.value[i] = sorted[i].t1;
        o.uLesionFac.value[i] = lesionTransmit(sorted[i].residualArea);
      } else {
        o.uLesionT0.value[i] = 1;
        o.uLesionT1.value[i] = 1;
        o.uLesionFac.value[i] = 1;
      }
    }
  }

  function isEngaged(v: ContrastVessel): boolean {
    if (!side) return false;
    if (side === "both") return true;
    if (side === "left") {
      const t = vesselTarget(byId, v.id);
      return t === "left" || t === "lad" || t === "lcx";
    }
    if (side === "right") return vesselTarget(byId, v.id) === "right";
    if (side === "lad") return isInSubtree(byId, v.id, "lad");
    if (side === "lcx") return isInSubtree(byId, v.id, "lcx");
    return false;
  }

  /** Ostium-relative delay in effective (stenosis-stretched) distance. */
  function effectiveStart(v: ContrastVessel): number {
    const phys = (() => {
      if (side === "lad") {
        const root = byId.get("lad");
        return Math.max(0, v.startDelay - (root?.startDelay ?? 0));
      }
      if (side === "lcx") {
        const root = byId.get("lcx");
        return Math.max(0, v.startDelay - (root?.startDelay ?? 0));
      }
      return v.startDelay;
    })();

    // Inflate ancestor path by stenosis resistance (approx via takeoff fractions)
    let extra = 0;
    let cur: ContrastVessel | undefined = v;
    let guard = 0;
    while (cur?.parentId && guard++ < 24) {
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      // Cost along parent from 0 → takeoff, vs plain length * takeoff
      const takeoff = cur.takeoffT;
      const plain = parent.length * takeoff;
      let costly = 0;
      const steps = 20;
      for (let i = 0; i < steps; i++) {
        const t = ((i + 0.5) / steps) * takeoff;
        const seg = (takeoff / steps) * parent.length;
        costly += seg * Math.min(40, resistanceAt(parent.id, t));
      }
      extra += Math.max(0, costly - plain);

      // Selective roots: stop accumulating above LAD/LCx origin
      if (side === "lad" && parent.id === "lad") break;
      if (side === "lcx" && parent.id === "lcx") break;
      cur = parent;
    }
    return phys + extra;
  }

  /** Map effective inject distance → physical front t on this vessel. */
  function physicalFrontT(v: ContrastVessel, dist: number): number {
    // Never opacify a branch before dye on the parent has reached its takeoff.
    if (v.parentId) {
      const parent = byId.get(v.parentId);
      if (parent && isEngaged(parent)) {
        const parentFront = physicalFrontT(parent, dist);
        if (parentFront < v.takeoffT - 0.004) return 0;
      } else if (parent && !isEngaged(parent)) {
        // Selective injection: parent (e.g. LM) not engaged — still require
        // that effective distance has reached this vessel's origin.
        if (dist < effectiveStart(v) - 1e-4) return 0;
      }
    }

    const local = dist - effectiveStart(v);
    if (local <= 0) return 0;
    const cap = occlusionCap(v);
    if (cap <= 0) return 0;

    let spent = 0;
    const steps = 48;
    for (let i = 0; i < steps; i++) {
      const tA = i / steps;
      const tB = (i + 1) / steps;
      if (tA >= cap) return cap;
      const mid = (tA + tB) * 0.5;
      const segPhys = (tB - tA) * v.length;
      const segEff = segPhys * Math.min(40, resistanceAt(v.id, mid));
      if (spent + segEff >= local) {
        const frac = (local - spent) / Math.max(segEff, 1e-8);
        return Math.min(cap, tA + (tB - tA) * frac);
      }
      spent += segEff;
    }
    return Math.min(cap, 1);
  }

  function recomputeMaxEnd() {
    maxEnd = 0;
    for (const v of vessels) {
      if (!isEngaged(v)) continue;
      maxEnd = Math.max(maxEnd, effectiveStart(v) + effectiveVesselLength(v));
    }
  }

  function dimMaterial(
    m: THREE.Material,
    opacity: number,
    opts?: { emissive?: boolean },
  ) {
    if (!("opacity" in m)) return;
    const mat = m as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
    if (!matBackups.has(mat)) {
      matBackups.set(mat, {
        opacity: mat.opacity,
        transparent: mat.transparent,
        depthWrite: mat.depthWrite,
        emissiveIntensity:
          mat instanceof THREE.MeshStandardMaterial ? mat.emissiveIntensity : undefined,
      });
    }
    mat.transparent = true;
    mat.opacity = opacity;
    mat.depthWrite = false;
    if (opts?.emissive && mat instanceof THREE.MeshStandardMaterial) {
      mat.emissiveIntensity = DIM_EMISSIVE;
    }
    mat.needsUpdate = true;
  }

  function restoreMaterial(m: THREE.Material) {
    const b = matBackups.get(m);
    if (!b || !("opacity" in m)) return;
    const mat = m as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
    mat.opacity = b.opacity;
    mat.transparent = b.transparent;
    mat.depthWrite = b.depthWrite;
    if (
      mat instanceof THREE.MeshStandardMaterial &&
      b.emissiveIntensity != null
    ) {
      mat.emissiveIntensity = b.emissiveIntensity;
    }
    mat.needsUpdate = true;
  }

  function setDimmed(on: boolean) {
    anatomy.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj.userData.isDyeOverlay) return;

      // Tube end-disks at ostia / branch takeoffs read as bright circles in
      // fluoro inject — hide them while dimmed (junction beads seal the joins).
      const isTubeCap =
        obj.geometry instanceof THREE.CircleGeometry &&
        !!(obj.parent && (obj.parent as THREE.Object3D).userData?.contrast);
      if (isTubeCap) {
        if (on) {
          if (!matBackups.has(obj)) {
            matBackups.set(obj, {
              opacity: 1,
              transparent: false,
              depthWrite: true,
              visible: obj.visible,
            });
          }
          obj.visible = false;
        } else {
          const b = matBackups.get(obj);
          obj.visible = b?.visible ?? true;
        }
        return;
      }

      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (on) {
          const isHeart =
            obj.parent?.name === "heartShell" || obj.name === "heartShell";
          dimMaterial(m, isHeart ? DIM_HEART_OPACITY : DIM_VESSEL_OPACITY, {
            emissive: m instanceof THREE.MeshStandardMaterial,
          });
        } else {
          restoreMaterial(m);
        }
      }
    });

    for (const extra of dimExtras) {
      extra.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (on) {
            if (!matBackups.has(obj)) {
              matBackups.set(obj, {
                opacity: 1,
                transparent: true,
                depthWrite: true,
                visible: obj.visible,
              });
            }
            dimMaterial(m, DIM_FLOOR_OPACITY);
            obj.visible = true;
          } else {
            restoreMaterial(m);
            const b = matBackups.get(obj);
            if (b?.visible != null) obj.visible = b.visible;
          }
        }
      });
    }

    if (!on) matBackups.clear();
  }

  function clearDyeVisuals() {
    injectDist = 0;
    washDist = 0;
    phase = "fill";
    phaseTimer = 0;
    for (const v of vessels) {
      v.dye.front.value = 0;
      v.dye.wash.value = 0;
      v.dye.amount.value = 0;
    }
    for (const o of overlays) {
      o.geo.setDrawRange(0, 0);
      o.mesh.visible = false;
      o.startCap.visible = false;
      o.endCap.visible = false;
    }
  }

  function applyFronts() {
    for (const o of overlays) {
      const v = o.vessel;
      if (!isEngaged(v)) {
        v.dye.front.value = 0;
        v.dye.wash.value = 0;
        v.dye.amount.value = 0;
        o.geo.setDrawRange(0, 0);
        o.mesh.visible = false;
        o.startCap.visible = false;
        o.endCap.visible = false;
        continue;
      }

      syncOverlayLesionUniforms(o);

      const front = physicalFrontT(v, injectDist);
      const wash = physicalFrontT(v, washDist);
      v.dye.front.value = front;
      v.dye.wash.value = wash;
      v.dye.amount.value = front > 0.001 && wash < 0.999 ? 1 : 0;
      v.dye.time.value = simTime;

      const idxCount = o.geo.index?.count ?? v.indexCount;
      const start = Math.floor((wash * idxCount) / 3) * 3;
      const end = Math.floor((front * idxCount) / 3) * 3;
      const count = Math.max(0, end - start);
      o.geo.setDrawRange(start, count);
      o.mesh.visible = count > 0 && v.mesh.visible;

      // Tube opacity stays full; along-tube dimming is in the shader.
      o.mat.opacity = 0.95;
      o.mat.emissiveIntensity = 0.75;

      // Never show dye end-disks — they flash as circles at every branch takeoff.
      o.startCap.visible = false;
      o.endCap.visible = false;
    }
  }

  function resolveVesselId(mesh: THREE.Mesh): string | null {
    if (mesh.userData.contrast?.id) return String(mesh.userData.contrast.id);
    let cur: THREE.Object3D | null = mesh;
    while (cur) {
      const c = cur.userData.contrast as ContrastVessel | undefined;
      if (c?.id) return c.id;
      cur = cur.parent;
    }
    const group = mesh.userData.vesselGroup as string | undefined;
    if (group === "lm") return "lm";
    if (group === "rca") return "rca";
    if (group) {
      for (const v of vessels) {
        if (v.mesh.userData.vesselGroup === group) return v.id;
      }
    }
    return null;
  }

  const api: ContrastSim = {
    get active() {
      return active;
    },
    get speed() {
      return speed;
    },
    get side() {
      return side;
    },
    setActive(on: boolean) {
      active = on;
      if (!on) {
        side = null;
        clearDyeVisuals();
        setDimmed(false);
      } else {
        // Armed only — keep anatomy visible until a vessel is clicked
        side = null;
        clearDyeVisuals();
        setDimmed(false);
        maxEnd = 0;
      }
    },
    setSpeed(speed01: number) {
      speed = THREE.MathUtils.clamp(speed01, 0, 1);
    },
    engage(next: InjectionSide) {
      if (!active) {
        active = true;
      }
      side = next;
      clearDyeVisuals();
      setDimmed(true);
      recomputeMaxEnd();
    },
    clearSelection() {
      if (!active) return;
      side = null;
      clearDyeVisuals();
      setDimmed(false);
      maxEnd = 0;
    },
    setLesionFlows(flows: LesionFlow[]) {
      lesionFlows = flows;
      rebuildFlowIndex();
      rebuildDyeGeometries();
      if (active && side) recomputeMaxEnd();
    },
    pickSide(ray, hitMesh, _hitPoint) {
      anatomy.updateWorldMatrix(true, false);
      leftWorld.copy(leftOstLocal);
      rightWorld.copy(rightOstLocal);
      anatomy.localToWorld(leftWorld);
      anatomy.localToWorld(rightWorld);
      midWorld.copy(leftWorld).add(rightWorld).multiplyScalar(0.5);
      const ostiaSpan = Math.max(0.01, leftWorld.distanceTo(rightWorld));

      // Prefer an actual vessel / ostium hit over the between-ostia heuristic
      if (hitMesh && !hitMesh.userData.isDyeOverlay) {
        const id = resolveVesselId(hitMesh);
        if (id) {
          const t = vesselTarget(byId, id);
          if (t) return t;
        }
        const name = hitMesh.userData.vesselName;
        if (typeof name === "string") {
          const lower = name.toLowerCase();
          if (lower.includes("left main") || lower === "left coronary ostium") {
            return "left";
          }
          if (lower.includes("right")) return "right";
          if (lower.includes("lad") || lower.includes("diagonal") || lower.includes("septal")) {
            return "lad";
          }
          if (
            lower.includes("lcx") ||
            lower.includes("circumflex") ||
            lower.includes("obtuse") ||
            lower.includes("om")
          ) {
            return "lcx";
          }
        }
        const group = hitMesh.userData.vesselGroup as string | undefined;
        if (group === "lm") return "left";
        if (group === "lad" || group === "septal" || group === "diag") return "lad";
        if (group === "lcx" || group === "om" || group === "lpl") return "lcx";
        if (
          group === "rca" ||
          group === "sn" ||
          group === "conus" ||
          group === "rv" ||
          group === "am" ||
          group === "pda" ||
          group === "rpl"
        ) {
          return "right";
        }
      }

      const dMid = rayPointDistance(ray, midWorld);
      const dLeft = rayPointDistance(ray, leftWorld);
      const dRight = rayPointDistance(ray, rightWorld);

      // Click in the gap between left / right ostia → both coronaries
      if (
        dMid < ostiaSpan * 0.65 &&
        Math.abs(dLeft - dRight) < ostiaSpan * 0.45 &&
        Math.min(dLeft, dRight) < ostiaSpan * 0.95
      ) {
        return "both";
      }

      if (dLeft < 0.25 && dLeft <= dRight) return "left";
      if (dRight < 0.25 && dRight < dLeft) return "right";

      return null;
    },
    update(dt: number) {
      if (!active) return;
      simTime += dt * Math.max(speed, 0.0001);

      if (side && speed > 0 && maxEnd > 0) {
        const advance = FLOW_UNITS_PER_SEC * speed * dt;
        if (phase === "fill") {
          injectDist += advance;
          if (injectDist >= maxEnd) {
            injectDist = maxEnd;
            phase = "hold";
            phaseTimer = 0;
          }
        } else if (phase === "hold") {
          phaseTimer += dt * speed;
          if (phaseTimer >= HOLD_SEC) {
            phase = "wash";
            washDist = 0;
          }
        } else if (phase === "wash") {
          washDist += advance;
          if (washDist >= maxEnd) {
            washDist = maxEnd;
            phase = "pause";
            phaseTimer = 0;
          }
        } else {
          phaseTimer += dt * speed;
          if (phaseTimer >= CLEAR_PAUSE_SEC) {
            injectDist = 0;
            washDist = 0;
            phase = "fill";
            phaseTimer = 0;
          }
        }
      }

      applyFronts();
    },
    dispose() {
      active = false;
      side = null;
      clearDyeVisuals();
      setDimmed(false);
      for (const o of overlays) {
        o.mesh.removeFromParent();
        o.geo.dispose();
        o.mat.dispose();
        (o.startCap.material as THREE.Material).dispose();
        (o.endCap.material as THREE.Material).dispose();
        o.startCap.geometry.dispose();
        o.endCap.geometry.dispose();
      }
      dyeMat.dispose();
    },
  };

  return api;
}
