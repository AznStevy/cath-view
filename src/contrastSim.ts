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

function closestParamOnCurve(
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

  const overlays: DyeOverlay[] = vessels.map((v) => {
    const geo = v.mesh.geometry.clone();
    const mesh = new THREE.Mesh(geo, dyeMat);
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.userData.isDyeOverlay = true;
    geo.setDrawRange(0, 0);

    const startCap = new THREE.Mesh(new THREE.CircleGeometry(0.01, 10), dyeMat);
    startCap.visible = false;
    startCap.userData.isDyeOverlay = true;
    const endCap = new THREE.Mesh(new THREE.CircleGeometry(0.01, 10), dyeMat);
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
    return { vessel: v, mesh, geo, startCap, endCap };
  });

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

  /** Ostium-relative delay, shifted so selective LAD/LCx start at t=0. */
  function effectiveStart(v: ContrastVessel): number {
    if (side === "lad") {
      const root = byId.get("lad");
      return Math.max(0, v.startDelay - (root?.startDelay ?? 0));
    }
    if (side === "lcx") {
      const root = byId.get("lcx");
      return Math.max(0, v.startDelay - (root?.startDelay ?? 0));
    }
    return v.startDelay;
  }

  function recomputeMaxEnd() {
    maxEnd = 0;
    for (const v of vessels) {
      if (!isEngaged(v)) continue;
      maxEnd = Math.max(maxEnd, effectiveStart(v) + v.length);
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

      const localInject =
        (injectDist - effectiveStart(v)) / Math.max(v.length, 1e-4);
      const localWash =
        (washDist - effectiveStart(v)) / Math.max(v.length, 1e-4);
      const front = THREE.MathUtils.clamp(localInject, 0, 1);
      const wash = THREE.MathUtils.clamp(localWash, 0, 1);
      v.dye.front.value = front;
      v.dye.wash.value = wash;
      v.dye.amount.value = front > 0.001 && wash < 0.999 ? 1 : 0;
      v.dye.time.value = simTime;

      const idxCount = v.indexCount;
      const start = Math.floor((wash * idxCount) / 3) * 3;
      const end = Math.floor((front * idxCount) / 3) * 3;
      const count = Math.max(0, end - start);
      o.geo.setDrawRange(start, count);
      o.mesh.visible = count > 0 && v.mesh.visible;

      o.startCap.visible = front > 0.001 && wash < 0.02;
      o.endCap.visible = front > 0.96 && wash < 0.96;
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
        o.startCap.geometry.dispose();
        o.endCap.geometry.dispose();
      }
      dyeMat.dispose();
    },
  };

  return api;
}
