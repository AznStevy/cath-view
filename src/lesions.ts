import * as THREE from "three";
import {
  closestParamOnCurve,
  type ContrastVessel,
  type LesionFlow,
} from "./contrastSim";

/** Angular samples for eccentric / irregular lumen profiles. */
export const PROFILE_SAMPLES = 24;

/** Default half-length in curve parameter space — short focal lesion. */
export const DEFAULT_LENGTH_T = 0.028;

export type LesionRecord = {
  id: string;
  vesselId: string;
  /** Position along vessel curve ∈ [0, 1]. */
  t: number;
  /**
   * Effective diameter stenosis ∈ [0, 1] derived from profile
   * (1 − mean residual radius). Kept for list display / legacy.
   */
  severity: number;
  /** Axial half-length in curve parameter space. */
  lengthT: number;
  /**
   * Residual lumen radius at PROFILE_SAMPLES angles ∈ [0, 1]
   * (fraction of vessel radius). 0 = occluded at that angle.
   * Angle i → 2π·i/N, same frame as branch marks (0 = +N).
   */
  profile: number[];
};

export type LesionFile = {
  version: 1 | 2;
  lesions: LesionRecord[];
};

export type BranchMark = {
  id: string;
  name: string;
  /** Angle around vessel cross-section (radians, 0 = +N). */
  angle: number;
};

export type { LesionFlow };

type VesselIndex = {
  vessels: ContrastVessel[];
  byId: Map<string, ContrastVessel>;
};

const PLAQUE_COLOR = 0xb85a4a;
const SELECTED_COLOR = 0xe8c040;
const BRANCH_WINDOW = 0.07;
const LENGTH_T_MIN = 0.015;
const LENGTH_T_MAX = 0.14;
/** Model-unit → mm (LAD ≈ 2.8 units ≈ 100 mm epicardial). */
const MM_PER_UNIT = 36;

function uid(): string {
  return `les_${Math.random().toString(36).slice(2, 10)}`;
}

export function uniformProfile(residual01: number): number[] {
  const r = THREE.MathUtils.clamp(residual01, 0, 1);
  return Array.from({ length: PROFILE_SAMPLES }, () => r);
}

export function severityFromProfile(profile: number[]): number {
  if (!profile.length) return 0;
  const mean = profile.reduce((a, b) => a + b, 0) / profile.length;
  return THREE.MathUtils.clamp(1 - mean, 0, 1);
}

/** Residual lumen area / vessel area from polar samples. */
export function residualAreaFromProfile(profile: number[]): number {
  if (!profile.length) return 1;
  const meanSq =
    profile.reduce((a, r) => a + r * r, 0) / profile.length;
  return THREE.MathUtils.clamp(meanSq, 0, 1);
}

export function normalizeProfile(raw: unknown, fallbackSeverity = 0.5): number[] {
  if (Array.isArray(raw) && raw.length >= 3) {
    const samples = raw.map((v) => THREE.MathUtils.clamp(Number(v) || 0, 0, 1));
    // Resample to PROFILE_SAMPLES if needed
    if (samples.length === PROFILE_SAMPLES) return samples;
    const out: number[] = [];
    for (let i = 0; i < PROFILE_SAMPLES; i++) {
      const u = (i / PROFILE_SAMPLES) * samples.length;
      const i0 = Math.floor(u) % samples.length;
      const i1 = (i0 + 1) % samples.length;
      const f = u - Math.floor(u);
      out.push(samples[i0] * (1 - f) + samples[i1] * f);
    }
    return out;
  }
  return uniformProfile(1 - THREE.MathUtils.clamp(fallbackSeverity, 0, 1));
}

function collectVessels(anatomy: THREE.Object3D): VesselIndex {
  const vessels: ContrastVessel[] = [];
  const byId = new Map<string, ContrastVessel>();
  anatomy.traverse((obj) => {
    const c = obj.userData.contrast as ContrastVessel | undefined;
    if (c && obj instanceof THREE.Mesh) {
      vessels.push(c);
      byId.set(c.id, c);
    }
  });
  return { vessels, byId };
}

function vesselRadiusAt(v: ContrastVessel, t: number): number {
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

function sampleProfile(profile: number[], angle: number): number {
  const n = profile.length;
  if (!n) return 1;
  const u = ((angle / (Math.PI * 2)) % 1 + 1) % 1;
  const x = u * n;
  const i0 = Math.floor(x) % n;
  const i1 = (i0 + 1) % n;
  const f = x - Math.floor(x);
  return profile[i0] * (1 - f) + profile[i1] * f;
}

/** Irregular pinched tube from a polar residual-radius profile. */
function createStenosisGeometry(
  curve: THREE.CatmullRomCurve3,
  tCenter: number,
  halfLen: number,
  radiusBase: number,
  profile: number[],
  segments = 18,
): THREE.BufferGeometry {
  const t0 = Math.max(0, tCenter - halfLen);
  const t1 = Math.min(1, tCenter + halfLen);
  const frames = curve.computeFrenetFrames(64, false);
  const radial = PROFILE_SAMPLES;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const normal = new THREE.Vector3();
  const vertex = new THREE.Vector3();

  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const t = t0 + (t1 - t0) * u;
    const p = curve.getPointAt(t);
    const fi = Math.round(t * 64);
    const N = frames.normals[fi] ?? frames.normals[frames.normals.length - 1];
    const B = frames.binormals[fi] ?? frames.binormals[frames.binormals.length - 1];

    // Cosine envelope: full vessel caliber at ends, profile pinch at center
    const pinch = 0.5 - 0.5 * Math.cos(u * Math.PI * 2);

    for (let j = 0; j <= radial; j++) {
      const v = j / radial;
      const angle = v * Math.PI * 2;
      const sin = Math.sin(angle);
      const cos = -Math.cos(angle);
      const residual = sampleProfile(profile, angle);
      const factor = THREE.MathUtils.lerp(1, Math.max(0.03, residual), pinch);
      const radius = radiusBase * factor * 1.02;

      normal
        .set(cos * N.x + sin * B.x, cos * N.y + sin * B.y, cos * N.z + sin * B.z)
        .normalize();
      vertex.copy(p).addScaledVector(normal, radius);
      positions.push(vertex.x, vertex.y, vertex.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(u, v);
    }
  }

  for (let i = 0; i < segments; i++) {
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

function resolveContrastMesh(mesh: THREE.Mesh): ContrastVessel | null {
  let cur: THREE.Object3D | null = mesh;
  while (cur) {
    const c = cur.userData.contrast as ContrastVessel | undefined;
    if (c) return c;
    cur = cur.parent;
  }
  return null;
}

export function segmentLabel(t: number): string {
  if (t < 0.33) return "prox";
  if (t < 0.66) return "mid";
  return "dist";
}

export function severityPct(severity: number): number {
  return Math.round(THREE.MathUtils.clamp(severity, 0, 1) * 100);
}

export function lengthLabel(lengthT: number): string {
  if (lengthT < 0.035) return "focal";
  if (lengthT < 0.07) return "short";
  return "diffuse";
}

/** Full axial lesion length in mm from half-length param and vessel mm length. */
export function lesionLengthMm(lengthT: number, vesselLengthMm: number): number {
  return 2 * lengthT * vesselLengthMm;
}

export type LesionManager = {
  readonly lesions: readonly LesionRecord[];
  readonly selectedId: string | null;
  readonly placing: boolean;
  setPlacing(on: boolean): void;
  select(id: string | null): void;
  tryPlaceFromClick(
    mesh: THREE.Mesh | null,
    point: THREE.Vector3 | null,
  ): LesionRecord | null;
  update(
    id: string,
    patch: Partial<Pick<LesionRecord, "severity" | "t" | "lengthT" | "profile">>,
  ): void;
  remove(id: string): void;
  get(id: string): LesionRecord | undefined;
  vesselName(vesselId: string): string;
  /** Approximate vessel length in mm (model units × scale). */
  vesselLengthMm(vesselId: string): number;
  branchMarks(lesion: LesionRecord): BranchMark[];
  /** Lesion flow effects for contrast simulation. */
  lesionFlows(): LesionFlow[];
  toJSON(): LesionFile;
  loadJSON(data: unknown): { ok: true } | { ok: false; error: string };
  download(): void;
  dispose(): void;
  onChange(cb: () => void): void;
};

export function createLesionManager(anatomy: THREE.Object3D): LesionManager {
  const { vessels, byId } = collectVessels(anatomy);
  const group = new THREE.Group();
  group.name = "lesionMeshes";
  anatomy.add(group);

  const lesions: LesionRecord[] = [];
  const meshById = new Map<string, THREE.Mesh>();
  let selectedId: string | null = null;
  let placing = false;
  const listeners = new Set<() => void>();

  function notify() {
    for (const cb of listeners) cb();
  }

  function rebuildMesh(lesion: LesionRecord) {
    const prev = meshById.get(lesion.id);
    if (prev) {
      group.remove(prev);
      prev.geometry.dispose();
      if (Array.isArray(prev.material)) prev.material.forEach((m) => m.dispose());
      else (prev.material as THREE.Material).dispose();
      meshById.delete(lesion.id);
    }

    const v = byId.get(lesion.vesselId);
    if (!v) return;

    const rBase = vesselRadiusAt(v, lesion.t);
    const geo = createStenosisGeometry(
      v.curve,
      lesion.t,
      lesion.lengthT,
      rBase,
      lesion.profile,
    );
    const selected = lesion.id === selectedId;
    const area = residualAreaFromProfile(lesion.profile);
    const mat = new THREE.MeshStandardMaterial({
      color: selected ? SELECTED_COLOR : PLAQUE_COLOR,
      emissive: selected ? SELECTED_COLOR : PLAQUE_COLOR,
      emissiveIntensity: selected ? 0.45 : 0.22,
      roughness: 0.55,
      metalness: 0.08,
      transparent: true,
      opacity: area < 0.02 ? 0.95 : 0.88,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    mesh.userData.isLesionMesh = true;
    mesh.userData.lesionId = lesion.id;
    mesh.name = `lesion-${lesion.id}`;
    group.add(mesh);
    meshById.set(lesion.id, mesh);
  }

  function rebuildAll() {
    for (const L of lesions) rebuildMesh(L);
  }

  function parseLesion(raw: Record<string, unknown>): LesionRecord | null {
    const vesselId = String(raw.vesselId ?? "");
    if (!byId.has(vesselId)) return null;
    const severityFallback = THREE.MathUtils.clamp(Number(raw.severity) || 0.5, 0, 1);
    const profile = normalizeProfile(raw.profile, severityFallback);
    return {
      id: typeof raw.id === "string" ? raw.id : uid(),
      vesselId,
      t: THREE.MathUtils.clamp(Number(raw.t) || 0, 0, 1),
      severity: severityFromProfile(profile),
      lengthT: THREE.MathUtils.clamp(
        Number(raw.lengthT) || DEFAULT_LENGTH_T,
        LENGTH_T_MIN,
        LENGTH_T_MAX,
      ),
      profile,
    };
  }

  const api: LesionManager = {
    get lesions() {
      return lesions;
    },
    get selectedId() {
      return selectedId;
    },
    get placing() {
      return placing;
    },
    setPlacing(on: boolean) {
      placing = on;
      if (on) selectedId = null;
      rebuildAll();
      notify();
    },
    select(id: string | null) {
      selectedId = id;
      placing = false;
      rebuildAll();
      notify();
    },
    tryPlaceFromClick(mesh, point) {
      if (!placing || !mesh || !point) return null;
      const localPoint = point.clone();
      anatomy.worldToLocal(localPoint);
      const contrast = resolveContrastMesh(mesh);
      if (!contrast) return null;
      const t = closestParamOnCurve(contrast.curve, localPoint);
      const profile = uniformProfile(0.5);
      const lesion: LesionRecord = {
        id: uid(),
        vesselId: contrast.id,
        t,
        severity: severityFromProfile(profile),
        lengthT: DEFAULT_LENGTH_T,
        profile,
      };
      lesions.push(lesion);
      placing = false;
      selectedId = lesion.id;
      rebuildMesh(lesion);
      notify();
      return lesion;
    },
    update(id, patch) {
      const L = lesions.find((x) => x.id === id);
      if (!L) return;
      if (patch.profile) {
        L.profile = normalizeProfile(patch.profile, L.severity);
        L.severity = severityFromProfile(L.profile);
      } else if (patch.severity != null) {
        L.severity = THREE.MathUtils.clamp(patch.severity, 0, 1);
        L.profile = uniformProfile(1 - L.severity);
      }
      if (patch.t != null) L.t = THREE.MathUtils.clamp(patch.t, 0, 1);
      if (patch.lengthT != null) {
        L.lengthT = THREE.MathUtils.clamp(patch.lengthT, LENGTH_T_MIN, LENGTH_T_MAX);
      }
      rebuildMesh(L);
      notify();
    },
    remove(id) {
      const idx = lesions.findIndex((x) => x.id === id);
      if (idx < 0) return;
      lesions.splice(idx, 1);
      const mesh = meshById.get(id);
      if (mesh) {
        group.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        meshById.delete(id);
      }
      if (selectedId === id) selectedId = null;
      notify();
    },
    get(id) {
      return lesions.find((x) => x.id === id);
    },
    vesselName(vesselId) {
      const v = byId.get(vesselId);
      return String(v?.mesh.userData.vesselName ?? vesselId.toUpperCase());
    },
    vesselLengthMm(vesselId) {
      const v = byId.get(vesselId);
      return (v?.length ?? 1) * MM_PER_UNIT;
    },
    branchMarks(lesion) {
      const parent = byId.get(lesion.vesselId);
      if (!parent) return [];
      const frames = parent.curve.computeFrenetFrames(32, false);
      const fi = Math.round(lesion.t * 32);
      const N = frames.normals[fi] ?? frames.normals[0];
      const B = frames.binormals[fi] ?? frames.binormals[0];
      const marks: BranchMark[] = [];
      const half = lesion.lengthT + BRANCH_WINDOW;

      for (const child of vessels) {
        if (child.parentId !== lesion.vesselId) continue;
        if (Math.abs(child.takeoffT - lesion.t) > half) continue;
        const dir = child.curve.getTangentAt(0).normalize();
        const x = dir.dot(N);
        const y = dir.dot(B);
        const angle = Math.atan2(y, x);
        marks.push({
          id: child.id,
          name: String(child.mesh.userData.vesselName ?? child.id),
          angle,
        });
      }
      return marks;
    },
    lesionFlows() {
      return lesions.map((L) => ({
        vesselId: L.vesselId,
        t0: Math.max(0, L.t - L.lengthT),
        t1: Math.min(1, L.t + L.lengthT),
        residualArea: residualAreaFromProfile(L.profile),
        profile: [...L.profile],
      }));
    },
    toJSON() {
      return {
        version: 2 as const,
        lesions: lesions.map((L) => ({
          ...L,
          profile: [...L.profile],
        })),
      };
    },
    loadJSON(data) {
      if (!data || typeof data !== "object") {
        return { ok: false, error: "Invalid file." };
      }
      const file = data as Partial<LesionFile>;
      if ((file.version !== 1 && file.version !== 2) || !Array.isArray(file.lesions)) {
        return { ok: false, error: "Unsupported lesion file version." };
      }
      const next: LesionRecord[] = [];
      for (const raw of file.lesions) {
        if (!raw || typeof raw !== "object") continue;
        const parsed = parseLesion(raw as unknown as Record<string, unknown>);
        if (parsed) next.push(parsed);
      }
      for (const id of [...meshById.keys()]) {
        const mesh = meshById.get(id)!;
        group.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        meshById.delete(id);
      }
      lesions.length = 0;
      lesions.push(...next);
      selectedId = null;
      placing = false;
      rebuildAll();
      notify();
      return { ok: true };
    },
    download() {
      const blob = new Blob([JSON.stringify(api.toJSON(), null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cath-view-lesions.json";
      a.click();
      URL.revokeObjectURL(url);
    },
    dispose() {
      for (const mesh of meshById.values()) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      meshById.clear();
      anatomy.remove(group);
      listeners.clear();
    },
    onChange(cb) {
      listeners.add(cb);
    },
  };

  return api;
}
