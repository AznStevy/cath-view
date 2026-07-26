import * as THREE from "three";
import {
  createDyeUniforms,
  type ContrastVessel,
} from "./contrastSim";

/** Toggle groups in the vessel panel */
export type VesselGroup =
  | "lm"
  | "lad"
  | "septal"
  | "diag"
  | "lcx"
  | "om"
  | "lpl"
  | "rca"
  | "sn"
  | "conus"
  | "rv"
  | "am"
  | "pda"
  | "rpl";

export const VESSEL_GROUPS: {
  id: VesselGroup;
  label: string;
  color: string;
  defaultOn: boolean;
}[] = [
  { id: "lm", label: "Left main", color: "#d4c05a", defaultOn: true },
  { id: "lad", label: "LAD", color: "#4ec8a0", defaultOn: true },
  { id: "septal", label: "Septals", color: "#2d9a78", defaultOn: true },
  { id: "diag", label: "Diagonals", color: "#3aaa88", defaultOn: true },
  { id: "lcx", label: "LCx", color: "#6a9fe8", defaultOn: true },
  { id: "om", label: "Obtuse marginals", color: "#5088d0", defaultOn: true },
  { id: "lpl", label: "LCx PL", color: "#7ab0f0", defaultOn: true },
  { id: "rca", label: "RCA", color: "#e07050", defaultOn: true },
  { id: "sn", label: "SN branch", color: "#e08860", defaultOn: true },
  { id: "conus", label: "Conus", color: "#c85840", defaultOn: true },
  { id: "rv", label: "RV branch", color: "#d07048", defaultOn: true },
  { id: "am", label: "Acute marginals", color: "#d06848", defaultOn: true },
  { id: "pda", label: "PDA", color: "#c86040", defaultOn: true },
  { id: "rpl", label: "RCA PL", color: "#d87858", defaultOn: true },
];

/** Territory categories for bulk show/hide in the vessel panel */
export const VESSEL_CATEGORIES: {
  id: string;
  label: string;
  color: string;
  groups: VesselGroup[];
}[] = [
  { id: "cat-lm", label: "Left main", color: "#d4c05a", groups: ["lm"] },
  {
    id: "cat-lad",
    label: "LAD system",
    color: "#4ec8a0",
    groups: ["lad", "septal", "diag"],
  },
  {
    id: "cat-lcx",
    label: "LCx system",
    color: "#6a9fe8",
    groups: ["lcx", "om", "lpl"],
  },
  {
    id: "cat-rca",
    label: "RCA system",
    color: "#e07050",
    groups: ["rca", "sn", "conus", "rv", "am", "pda", "rpl"],
  },
];

const GROUP_COLORS: Record<VesselGroup, number> = {
  lm: 0xd4c05a,
  lad: 0x4ec8a0,
  septal: 0x2d9a78,
  diag: 0x3aaa88,
  lcx: 0x6a9fe8,
  om: 0x5088d0,
  lpl: 0x7ab0f0,
  rca: 0xe07050,
  sn: 0xe08860,
  conus: 0xc85840,
  rv: 0xd07048,
  am: 0xd06848,
  pda: 0xc86040,
  rpl: 0xd87858,
};

type Pt = [number, number, number];

type PathSpec = {
  /** Unique id for contrast-flow tree timing */
  id: string;
  /** Parent vessel id; omit for ostial roots (LM / RCA) */
  parentId?: string;
  group: VesselGroup;
  name: string;
  detail: string;
  points: Pt[];
  radiusStart: number;
  radiusEnd: number;
  tubularSegments?: number;
  /** Hold proximal caliber until this t∈[0,1], then taper to tip. */
  taperHold?: number;
  /** Taper curve exponent (<1 = gentler / more gradual). Default smoothstep. */
  taperPower?: number;
  /** Project distal control points onto the heart shell (epicardial course). */
  hugEpicardium?: boolean;
};

/**
 * Heart-shell ellipsoid (must match createHeartShell). Used to keep free-wall
 * branches (diagonals, OMs) on the epicardium instead of diving in / poking out.
 */
const HEART_OVOID = {
  center: new THREE.Vector3(0.1, -0.26, 0.06),
  radii: new THREE.Vector3(1.05, 1.22, 1.0),
  quat: new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(28),
      THREE.MathUtils.degToRad(12),
      THREE.MathUtils.degToRad(40),
      "ZYX",
    ),
  ),
};

const _ovoidInvQ = HEART_OVOID.quat.clone().invert();
const _ovoidTmp = new THREE.Vector3();

/** Ray-scale a world point onto the epicardial surface (scale≈0.96–1.0 hugs shell). */
function projectToEpicardium(pt: Pt, scale = 0.98): Pt {
  const { center, radii, quat } = HEART_OVOID;
  _ovoidTmp.set(pt[0], pt[1], pt[2]).sub(center).applyQuaternion(_ovoidInvQ);
  const nx = _ovoidTmp.x / radii.x;
  const ny = _ovoidTmp.y / radii.y;
  const nz = _ovoidTmp.z / radii.z;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-8) return pt;
  const s = scale / len;
  _ovoidTmp.set(nx * radii.x * s, ny * radii.y * s, nz * radii.z * s);
  _ovoidTmp.applyQuaternion(quat).add(center);
  return [_ovoidTmp.x, _ovoidTmp.y, _ovoidTmp.z];
}

function radialFactor(pt: Pt): number {
  const { center, radii } = HEART_OVOID;
  _ovoidTmp.set(pt[0], pt[1], pt[2]).sub(center).applyQuaternion(_ovoidInvQ);
  return Math.hypot(
    _ovoidTmp.x / radii.x,
    _ovoidTmp.y / radii.y,
    _ovoidTmp.z / radii.z,
  );
}

/**
 * Keep takeoff anchor; pin the rest to the shell.
 * Radial depth eases from the parent takeoff out to `scale` so origins stay flush.
 */
function epicardialPath(points: Pt[], scale = 0.98): Pt[] {
  if (points.length < 2) return points;
  const startRf = radialFactor(points[0]);
  return points.map((p, i) => {
    if (i === 0) return p;
    const t = i / (points.length - 1);
    const ease = t * t * (3 - 2 * t);
    const s = startRf + (scale - startRf) * ease;
    return projectToEpicardium(p, s);
  });
}

type JunctionSpec = {
  position: Pt;
  /** Keep ≈ meeting tube caliber so beads sit flush (not bulging balls). */
  radius: number;
  wedges: VesselGroup[];
  name: string;
  detail: string;
};

function ptsEqual(a: Pt, b: Pt): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Outbound direction of a vessel group from a shared anchor (for wedge facing). */
function branchDirectionFrom(anchor: Pt, group: VesselGroup): THREE.Vector3 {
  const dir = new THREE.Vector3();
  for (const path of PATHS) {
    if (path.group !== group) continue;
    const idx = path.points.findIndex((p) => ptsEqual(p, anchor));
    if (idx < 0) continue;
    if (idx + 1 < path.points.length) {
      const n = path.points[idx + 1];
      dir.set(n[0] - anchor[0], n[1] - anchor[1], n[2] - anchor[2]);
      if (dir.lengthSq() > 1e-8) return dir.normalize();
    }
    if (idx > 0) {
      const p = path.points[idx - 1];
      // Path ends here — face back toward the vessel body
      dir.set(p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]);
      if (dir.lengthSq() > 1e-8) return dir.normalize();
    }
  }
  return dir.set(0, 1, 0);
}

/**
 * Shared branch anchors — child tubes must start on these exact points so
 * junctions meet cleanly (same pattern as ekg-view conduction pathways).
 * Patient frame: +X left, +Y head, +Z anterior. Right-dominant tree.
 */
const LEFT_OST: Pt = [0.1, 0.62, 0.12];
const RIGHT_OST: Pt = [-0.08, 0.58, 0.1];
const LM_BIFUR: Pt = [0.58, 0.4, 0.4];

const LAD_S1: Pt = [0.52, 0.22, 0.6];
const LAD_D1: Pt = [0.5, 0.16, 0.66];
const LAD_S2: Pt = [0.42, -0.02, 0.8];
const LAD_D2: Pt = [0.36, -0.14, 0.88];
const LAD_S3: Pt = [0.28, -0.3, 0.94];
const LAD_D3: Pt = [0.22, -0.4, 0.96];
const LAD_S4: Pt = [0.14, -0.55, 0.97];

const LCX_OM1: Pt = projectToEpicardium([0.8, 0.32, 0.26], 0.98);
const LCX_OM2: Pt = projectToEpicardium([1.05, 0.06, -0.22], 0.98);
const LCX_OM3: Pt = projectToEpicardium([1.02, -0.04, -0.52], 0.98);
/** Terminal LCx / PL — on epicardium; LCx ends here (no medial stump). */
const LCX_PL1: Pt = projectToEpicardium([0.9, -0.18, -0.8], 0.98);

/** Proximal RCA: SN (superior) then conus; mid RCA: RV then two acute margins. */
const RCA_SN: Pt = [-0.14, 0.6, 0.12];
const RCA_CONUS: Pt = [-0.22, 0.52, 0.24];
const RCA_RV: Pt = [-0.52, 0.32, 0.32];
const RCA_AM1: Pt = [-0.65, 0.24, 0.3];
const RCA_AM2: Pt = [-0.92, -0.1, -0.28];
/** Crux: PDA down IV groove; single PLV continues AV groove left-inferior. */
const CRUX: Pt = [0.06, -0.32, -0.98];

const PATHS: PathSpec[] = [
  {
    id: "lm",
    group: "lm",
    name: "Left main (LM)",
    detail: "Left coronary ostium → bifurcation",
    radiusStart: 0.095,
    radiusEnd: 0.082,
    points: [LEFT_OST, [0.28, 0.55, 0.26], [0.48, 0.46, 0.36], LM_BIFUR],
  },
  {
    id: "lad",
    parentId: "lm",
    group: "lad",
    name: "LAD",
    detail: "Left anterior descending · AIV groove → apex",
    radiusStart: 0.078,
    radiusEnd: 0.018,
    tubularSegments: 96,
    points: [
      LM_BIFUR,
      [0.55, 0.3, 0.52],
      LAD_S1,
      LAD_D1,
      LAD_S2,
      LAD_D2,
      LAD_S3,
      LAD_D3,
      LAD_S4,
      [0.06, -0.78, 0.92],
      [0.0, -1.02, 0.7],
      [-0.02, -1.18, 0.38],
      [0.0, -1.26, 0.05],
      [0.04, -1.2, -0.18],
    ],
  },
  {
    id: "s1",
    parentId: "lad",
    group: "septal",
    name: "Septal S1",
    detail: "First septal perforator",
    radiusStart: 0.032,
    radiusEnd: 0.012,
    points: [LAD_S1, [0.34, 0.1, 0.42], [0.2, -0.02, 0.2], [0.12, -0.14, 0.04]],
  },
  {
    id: "s2",
    parentId: "lad",
    group: "septal",
    name: "Septal S2",
    detail: "Second septal perforator",
    radiusStart: 0.028,
    radiusEnd: 0.01,
    points: [LAD_S2, [0.28, -0.16, 0.55], [0.16, -0.3, 0.28], [0.08, -0.4, 0.08]],
  },
  {
    id: "s3",
    parentId: "lad",
    group: "septal",
    name: "Septal S3",
    detail: "Third septal perforator",
    radiusStart: 0.024,
    radiusEnd: 0.008,
    points: [LAD_S3, [0.16, -0.42, 0.65], [0.08, -0.55, 0.35], [0.02, -0.62, 0.12]],
  },
  {
    id: "s4",
    parentId: "lad",
    group: "septal",
    name: "Septal S4",
    detail: "Distal septal perforator",
    radiusStart: 0.02,
    radiusEnd: 0.007,
    points: [LAD_S4, [0.08, -0.7, 0.62], [0.02, -0.82, 0.28]],
  },
  {
    id: "d1",
    parentId: "lad",
    group: "diag",
    name: "Diagonal D1",
    detail: "First diagonal · anterolateral LV free wall",
    radiusStart: 0.048,
    radiusEnd: 0.014,
    tubularSegments: 48,
    hugEpicardium: true,
    points: epicardialPath([
      LAD_D1,
      [0.72, 0.08, 0.72],
      [0.88, -0.08, 0.68],
      [0.98, -0.28, 0.55],
      [1.02, -0.5, 0.4],
      [0.98, -0.72, 0.28],
    ]),
  },
  {
    id: "d2",
    parentId: "lad",
    group: "diag",
    name: "Diagonal D2",
    detail: "Second diagonal · mid anterolateral wall",
    radiusStart: 0.042,
    radiusEnd: 0.012,
    tubularSegments: 48,
    hugEpicardium: true,
    points: epicardialPath([
      LAD_D2,
      [0.58, -0.22, 0.88],
      [0.72, -0.42, 0.72],
      [0.78, -0.62, 0.48],
      [0.72, -0.82, 0.28],
    ]),
  },
  {
    id: "d3",
    parentId: "lad",
    group: "diag",
    name: "Diagonal D3",
    detail: "Third diagonal · distal anterolateral wall",
    radiusStart: 0.032,
    radiusEnd: 0.01,
    hugEpicardium: true,
    points: epicardialPath([
      LAD_D3,
      [0.42, -0.48, 0.92],
      [0.52, -0.68, 0.7],
      [0.5, -0.88, 0.42],
    ]),
  },
  {
    id: "lcx",
    parentId: "lm",
    group: "lcx",
    name: "LCx",
    detail: "Left circumflex · wraps left AV groove on epicardium → terminal PL",
    radiusStart: 0.072,
    radiusEnd: 0.03,
    tubularSegments: 96,
    taperHold: 0,
    taperPower: 0.9,
    points: [
      LM_BIFUR,
      // Extra samples so Catmull-Rom follows the ovoid AV wrap (not a chord)
      projectToEpicardium([0.68, 0.38, 0.36], 0.96),
      LCX_OM1,
      projectToEpicardium([0.92, 0.22, 0.06], 0.98),
      LCX_OM2,
      projectToEpicardium([1.08, 0.04, -0.36], 0.98),
      LCX_OM3,
      projectToEpicardium([0.97, -0.1, -0.66], 0.98),
      LCX_PL1,
    ],
  },
  {
    id: "om1",
    parentId: "lcx",
    group: "om",
    name: "OM1",
    detail: "First obtuse marginal · high lateral free wall",
    radiusStart: 0.048,
    radiusEnd: 0.014,
    tubularSegments: 48,
    hugEpicardium: true,
    points: epicardialPath([
      LCX_OM1,
      // Simple lateral arc — avoid out-and-back X/Z that makes Catmull-Rom squiggle
      [0.98, 0.18, 0.32],
      [1.1, -0.02, 0.38],
      [1.14, -0.25, 0.34],
      [1.1, -0.45, 0.28],
    ]),
  },
  {
    id: "om2",
    parentId: "lcx",
    group: "om",
    name: "OM2",
    detail: "Second obtuse marginal · mid-lateral free wall",
    radiusStart: 0.042,
    radiusEnd: 0.012,
    tubularSegments: 48,
    hugEpicardium: true,
    points: epicardialPath([
      LCX_OM2,
      [1.12, -0.02, -0.05],
      [1.15, -0.22, 0.12],
      [1.1, -0.42, 0.2],
      [1.0, -0.58, 0.18],
      [0.92, -0.7, 0.14],
    ]),
  },
  {
    id: "om3",
    parentId: "lcx",
    group: "om",
    name: "OM3",
    detail: "Third obtuse marginal · low lateral free wall",
    radiusStart: 0.034,
    radiusEnd: 0.01,
    hugEpicardium: true,
    points: epicardialPath([
      LCX_OM3,
      [1.12, -0.15, -0.35],
      [1.15, -0.38, -0.12],
      [1.05, -0.62, -0.02],
      [0.95, -0.88, -0.05],
    ]),
  },
  {
    id: "lpl",
    parentId: "lcx",
    group: "lpl",
    name: "LCx PL",
    detail: "Terminal posterolateral continuation of distal LCx",
    radiusStart: 0.028,
    radiusEnd: 0.01,
    hugEpicardium: true,
    points: epicardialPath([
      LCX_PL1,
      [0.88, -0.35, -0.7],
      [0.82, -0.55, -0.48],
      [0.78, -0.75, -0.22],
    ]),
  },
  {
    id: "rca",
    group: "rca",
    name: "RCA",
    detail: "Right coronary artery · right AV groove → crux",
    radiusStart: 0.082,
    radiusEnd: 0.048,
    tubularSegments: 96,
    points: [
      RIGHT_OST,
      RCA_SN,
      RCA_CONUS,
      RCA_RV,
      [-0.58, 0.3, 0.3],
      RCA_AM1,
      [-0.8, 0.08, 0.12],
      RCA_AM2,
      [-0.7, -0.22, -0.55],
      CRUX,
    ],
  },
  {
    id: "sn",
    parentId: "rca",
    group: "sn",
    name: "SN branch",
    detail: "Sinoatrial node artery · proximal RCA → SVC–RA (on epicardium)",
    radiusStart: 0.028,
    radiusEnd: 0.01,
    hugEpicardium: true,
    points: epicardialPath([
      RCA_SN,
      [-0.2, 0.68, 0.05],
      [-0.1, 0.78, -0.08],
      [0.02, 0.82, -0.18],
      [0.1, 0.78, -0.25],
    ]),
  },
  {
    id: "conus",
    parentId: "rca",
    group: "conus",
    name: "Conus",
    detail: "Conus branch · RVOT",
    radiusStart: 0.03,
    radiusEnd: 0.01,
    points: [RCA_CONUS, [-0.3, 0.55, 0.45], [-0.22, 0.48, 0.65], [-0.08, 0.38, 0.72]],
  },
  {
    id: "rv",
    parentId: "rca",
    group: "rv",
    name: "RV branch",
    detail: "Right ventricular branch · mid RCA → RV free wall",
    radiusStart: 0.032,
    radiusEnd: 0.01,
    tubularSegments: 40,
    hugEpicardium: true,
    points: epicardialPath([
      RCA_RV,
      [-0.62, 0.18, 0.52],
      [-0.68, -0.05, 0.68],
      [-0.58, -0.28, 0.72],
      [-0.42, -0.48, 0.65],
    ]),
  },
  {
    id: "am1",
    parentId: "rca",
    group: "am",
    name: "AM1",
    detail: "First acute marginal · proximal acute margin",
    radiusStart: 0.038,
    radiusEnd: 0.012,
    tubularSegments: 40,
    hugEpicardium: true,
    points: epicardialPath([
      RCA_AM1,
      [-0.82, 0.05, 0.42],
      [-0.88, -0.2, 0.5],
      [-0.78, -0.45, 0.48],
      [-0.6, -0.65, 0.35],
    ]),
  },
  {
    id: "am2",
    parentId: "rca",
    group: "am",
    name: "AM2",
    detail: "Second acute marginal · distal acute margin",
    radiusStart: 0.032,
    radiusEnd: 0.01,
    hugEpicardium: true,
    points: epicardialPath([
      RCA_AM2,
      [-1.02, -0.25, -0.05],
      [-0.98, -0.5, 0.08],
      [-0.85, -0.75, 0.12],
      [-0.68, -0.92, 0.08],
    ]),
  },
  {
    id: "pda",
    parentId: "rca",
    group: "pda",
    name: "PDA",
    detail: "Posterior descending · down the PIV groove (LAO: straight inferior)",
    radiusStart: 0.048,
    radiusEnd: 0.014,
    tubularSegments: 64,
    hugEpicardium: true,
    points: epicardialPath([
      CRUX,
      [0.02, -0.52, -1.02],
      [0.0, -0.75, -0.88],
      [-0.01, -0.98, -0.55],
      [0.0, -1.18, -0.2],
    ]),
  },
  {
    id: "rpl",
    parentId: "rca",
    group: "rpl",
    name: "PLV / RPL",
    detail: "Posterolateral continuation of RCA past crux · AV groove → inferior LV",
    radiusStart: 0.042,
    radiusEnd: 0.012,
    tubularSegments: 64,
    hugEpicardium: true,
    points: epicardialPath([
      CRUX,
      // Smooth AV continuation through former RPL2/RPL3 territory
      [0.18, -0.36, -0.95],
      [0.32, -0.42, -0.9],
      [0.42, -0.55, -0.75],
      [0.5, -0.72, -0.48],
      [0.5, -0.9, -0.22],
    ]),
  },
];

/**
 * Junction beads — sized flush with meeting caliber (side takeoffs ≈ child
 * radius; true bifurcations ≈ max meeting radius). Wedges face their branches.
 */
const JUNCTIONS: JunctionSpec[] = [
  {
    position: LM_BIFUR,
    radius: 0.084,
    wedges: ["lm", "lad", "lcx"],
    name: "LM bifurcation",
    detail: "Left main → LAD / LCx",
  },
  {
    position: LAD_S1,
    radius: 0.034,
    wedges: ["lad", "septal"],
    name: "S1 origin",
    detail: "LAD → first septal",
  },
  {
    position: LAD_D1,
    radius: 0.05,
    wedges: ["lad", "diag"],
    name: "D1 origin",
    detail: "LAD → first diagonal",
  },
  {
    position: LAD_S2,
    radius: 0.03,
    wedges: ["lad", "septal"],
    name: "S2 origin",
    detail: "LAD → second septal",
  },
  {
    position: LAD_D2,
    radius: 0.044,
    wedges: ["lad", "diag"],
    name: "D2 origin",
    detail: "LAD → second diagonal",
  },
  {
    position: LAD_S3,
    radius: 0.026,
    wedges: ["lad", "septal"],
    name: "S3 origin",
    detail: "LAD → third septal",
  },
  {
    position: LAD_D3,
    radius: 0.034,
    wedges: ["lad", "diag"],
    name: "D3 origin",
    detail: "LAD → third diagonal",
  },
  {
    position: LAD_S4,
    radius: 0.022,
    wedges: ["lad", "septal"],
    name: "S4 origin",
    detail: "LAD → distal septal",
  },
  {
    position: LCX_OM1,
    radius: 0.05,
    wedges: ["lcx", "om"],
    name: "OM1 origin",
    detail: "LCx → first obtuse marginal",
  },
  {
    position: LCX_OM2,
    radius: 0.044,
    wedges: ["lcx", "om"],
    name: "OM2 origin",
    detail: "LCx → second obtuse marginal",
  },
  {
    position: LCX_OM3,
    radius: 0.036,
    wedges: ["lcx", "om"],
    name: "OM3 origin",
    detail: "LCx → third obtuse marginal",
  },
  {
    position: LCX_PL1,
    radius: 0.032,
    wedges: ["lcx", "lpl"],
    name: "LCx PL origin",
    detail: "Distal LCx → terminal posterolateral",
  },
  {
    position: RCA_SN,
    radius: 0.03,
    wedges: ["rca", "sn"],
    name: "SN origin",
    detail: "RCA → sinoatrial node artery",
  },
  {
    position: RCA_CONUS,
    radius: 0.032,
    wedges: ["rca", "conus"],
    name: "Conus origin",
    detail: "RCA → conus",
  },
  {
    position: RCA_RV,
    radius: 0.034,
    wedges: ["rca", "rv"],
    name: "RV origin",
    detail: "RCA → right ventricular branch",
  },
  {
    position: RCA_AM1,
    radius: 0.04,
    wedges: ["rca", "am"],
    name: "AM1 origin",
    detail: "RCA → first acute marginal",
  },
  {
    position: RCA_AM2,
    radius: 0.034,
    wedges: ["rca", "am"],
    name: "AM2 origin",
    detail: "RCA → second acute marginal",
  },
  {
    position: CRUX,
    radius: 0.05,
    wedges: ["rca", "pda", "rpl"],
    name: "Crux",
    detail: "RCA → PDA / PLV continuation",
  },
];

function makeCurve(points: Pt[]): THREE.CatmullRomCurve3 {
  const vecs = points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  // Centripetal avoids end overshoot that opens gaps at shared anchors
  return new THREE.CatmullRomCurve3(vecs, false, "centripetal", 0.5);
}

/** Tube with radius taper along the path */
function createTaperedTubeGeometry(
  curve: THREE.Curve<THREE.Vector3>,
  tubularSegments: number,
  radiusStart: number,
  radiusEnd: number,
  radialSegments: number,
  taperHold = 0,
  taperPower?: number,
): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(tubularSegments, false);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const normal = new THREE.Vector3();
  const vertex = new THREE.Vector3();
  const hold = THREE.MathUtils.clamp(taperHold, 0, 0.9);

  for (let i = 0; i <= tubularSegments; i++) {
    const t = i / tubularSegments;
    const p = curve.getPointAt(t);
    const N = frames.normals[i];
    const B = frames.binormals[i];
    const u = t <= hold ? 0 : (t - hold) / (1 - hold);
    // Default: smoothstep. Power < 1 eases in slower = less abrupt tip.
    const smooth =
      taperPower != null
        ? Math.pow(u, taperPower)
        : u * u * (3 - 2 * u);
    const radius = THREE.MathUtils.lerp(radiusStart, radiusEnd, smooth);

    for (let j = 0; j <= radialSegments; j++) {
      const v = j / radialSegments;
      const angle = v * Math.PI * 2;
      const sin = Math.sin(angle);
      const cos = -Math.cos(angle);

      normal.x = cos * N.x + sin * B.x;
      normal.y = cos * N.y + sin * B.y;
      normal.z = cos * N.z + sin * B.z;
      normal.normalize();

      vertex.x = p.x + radius * normal.x;
      vertex.y = p.y + radius * normal.y;
      vertex.z = p.z + radius * normal.z;

      positions.push(vertex.x, vertex.y, vertex.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(t, v);
    }
  }

  for (let i = 0; i < tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * (radialSegments + 1) + j;
      const b = (i + 1) * (radialSegments + 1) + j;
      const c = (i + 1) * (radialSegments + 1) + j + 1;
      const d = i * (radialSegments + 1) + j + 1;
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

function createVesselMesh(spec: PathSpec): THREE.Mesh {
  const curve = makeCurve(spec.points);
  const tubularSegments = spec.tubularSegments ?? 48;
  const radialSegments = 10;
  const geo = createTaperedTubeGeometry(
    curve,
    tubularSegments,
    spec.radiusStart,
    spec.radiusEnd,
    radialSegments,
    spec.taperHold ?? 0,
    spec.taperPower,
  );
  const mat = new THREE.MeshStandardMaterial({
    color: GROUP_COLORS[spec.group],
    roughness: 0.4,
    metalness: 0.05,
    emissive: GROUP_COLORS[spec.group],
    emissiveIntensity: 0.08,
  });
  const dye = createDyeUniforms(0);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.vesselGroup = spec.group;
  mesh.userData.vesselName = spec.name;
  mesh.userData.vesselDetail = spec.detail;
  mesh.userData.isVessel = true;
  mesh.name = `vessel-${spec.id}`;

  // Disk caps close hollow tube ends (junction beads cover the rest)
  const start = curve.getPointAt(0);
  const end = curve.getPointAt(1);
  const tStart = curve.getTangentAt(0).normalize();
  const tEnd = curve.getTangentAt(1).normalize();

  const startCapMat = mat.clone();
  const startCap = new THREE.Mesh(
    new THREE.CircleGeometry(spec.radiusStart * 1.02, 12),
    startCapMat,
  );
  startCap.position.copy(start);
  startCap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tStart.clone().negate());
  startCap.userData.vesselGroup = spec.group;
  startCap.userData.isVessel = true;
  mesh.add(startCap);

  const endCapMat = mat.clone();
  const endCap = new THREE.Mesh(
    new THREE.CircleGeometry(spec.radiusEnd * 1.02, 12),
    endCapMat,
  );
  endCap.position.copy(end);
  endCap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tEnd);
  endCap.userData.vesselGroup = spec.group;
  endCap.userData.isVessel = true;
  mesh.add(endCap);

  const indexCount = geo.index?.count ?? 0;
  const contrast: ContrastVessel = {
    id: spec.id,
    parentId: spec.parentId ?? null,
    length: curve.getLength(),
    curve,
    takeoffT: 0,
    startDelay: 0,
    dye,
    mesh,
    materials: [mat, startCapMat, endCapMat],
    indexCount,
    tubularSegments,
    radialSegments,
  };
  mesh.userData.contrast = contrast;

  return mesh;
}

/** Pie-slice junction — each wedge faces the branch of its color. */
function createMultiColorJunction(spec: JunctionSpec): THREE.Group {
  const group = new THREE.Group();
  group.position.set(...spec.position);
  group.name = spec.name;
  group.userData.isJunction = true;
  group.userData.vesselGroups = spec.wedges;
  group.userData.vesselName = spec.name;
  group.userData.vesselDetail = spec.detail;
  group.renderOrder = 2;

  const n = Math.max(1, spec.wedges.length);
  const dirs = spec.wedges.map((g) => branchDirectionFrom(spec.position, g));

  // Plane normal from branch directions; sphere φ axis aligns with this
  const normal = new THREE.Vector3();
  if (n >= 2) {
    normal.crossVectors(dirs[0], dirs[1]);
    if (normal.lengthSq() < 1e-8 && n >= 3) {
      normal.crossVectors(dirs[0], dirs[2]);
    }
  }
  if (normal.lengthSq() < 1e-8) normal.set(0, 1, 0);
  else normal.normalize();

  const yAxis = normal;
  const xAxis = new THREE.Vector3();
  // Prefer projecting first branch dir into the plane as +X
  xAxis.copy(dirs[0]).addScaledVector(yAxis, -dirs[0].dot(yAxis));
  if (xAxis.lengthSq() < 1e-8) {
    xAxis.set(1, 0, 0).addScaledVector(yAxis, -yAxis.x);
    if (xAxis.lengthSq() < 1e-8) xAxis.set(0, 0, 1);
  }
  xAxis.normalize();
  const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();

  // Orient group so local +Y = plane normal (SphereGeometry φ revolves around Y)
  const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  group.quaternion.setFromRotationMatrix(basis);

  const half = Math.PI / n;
  spec.wedges.forEach((g, i) => {
    const d = dirs[i];
    const px = d.dot(xAxis);
    const pz = d.dot(zAxis);
    const mid = Math.atan2(pz, px);
    const phi0 = mid - half;
    const color = GROUP_COLORS[g];
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.35,
      metalness: 0.08,
      emissive: color,
      emissiveIntensity: 0.12,
      depthWrite: true,
    });
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(spec.radius, 16, 14, phi0, half * 2),
      mat,
    );
    mesh.renderOrder = 2;
    mesh.userData.vesselGroup = g;
    mesh.userData.vesselGroups = spec.wedges;
    mesh.userData.vesselName = spec.name;
    mesh.userData.vesselDetail = spec.detail;
    mesh.userData.isVessel = true;
    mesh.userData.isJunctionWedge = true;
    group.add(mesh);
  });
  return group;
}

function createOvoidGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, 48, 36);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const { radii } = HEART_OVOID;

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.x *= radii.x;
    v.y *= radii.y;
    v.z *= radii.z;
    pos.setXYZ(i, v.x, v.y, v.z);
  }

  geo.computeVertexNormals();
  return geo;
}

function createHeartShell(): THREE.Group {
  const group = new THREE.Group();
  group.name = "heartShell";

  const ovoid = new THREE.Mesh(
    createOvoidGeometry(),
    new THREE.MeshStandardMaterial({
      color: 0x5a3038,
      roughness: 0.65,
      metalness: 0.0,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    }),
  );
  // In-chest pose: long axis oblique — apex toward patient's left (+X),
  // inferior (−Y), and slightly anterior (+Z). Keep in sync with HEART_OVOID.
  ovoid.position.copy(HEART_OVOID.center);
  ovoid.rotation.order = "ZYX";
  ovoid.rotation.z = THREE.MathUtils.degToRad(40);
  ovoid.rotation.x = THREE.MathUtils.degToRad(28);
  ovoid.rotation.y = THREE.MathUtils.degToRad(12);
  group.add(ovoid);

  return group;
}

export function createCoronaryAnatomy(): THREE.Group {
  const root = new THREE.Group();
  root.name = "coronaryAnatomy";

  root.add(createHeartShell());

  const vessels = new THREE.Group();
  vessels.name = "vessels";
  for (const path of PATHS) {
    vessels.add(createVesselMesh(path));
  }
  for (const j of JUNCTIONS) {
    vessels.add(createMultiColorJunction(j));
  }

  const ostiumMat = new THREE.MeshStandardMaterial({
    color: 0xd8dde2,
    roughness: 0.4,
  });
  const leftOstium = new THREE.Mesh(new THREE.SphereGeometry(0.052, 14, 12), ostiumMat);
  leftOstium.position.set(...LEFT_OST);
  leftOstium.userData.vesselGroup = "lm";
  leftOstium.userData.vesselName = "Left coronary ostium";
  leftOstium.userData.vesselDetail = "Origin of left coronary artery";
  leftOstium.userData.isVessel = true;
  const rightOstium = new THREE.Mesh(
    new THREE.SphereGeometry(0.052, 14, 12),
    ostiumMat.clone(),
  );
  rightOstium.position.set(...RIGHT_OST);
  rightOstium.userData.vesselGroup = "rca";
  rightOstium.userData.vesselName = "Right coronary ostium";
  rightOstium.userData.vesselDetail = "Origin of right coronary artery";
  rightOstium.userData.isVessel = true;
  vessels.add(leftOstium, rightOstium);

  root.add(vessels);
  return root;
}

export function setVesselGroupVisibility(
  root: THREE.Object3D,
  group: VesselGroup,
  visible: boolean,
): void {
  root.traverse((obj) => {
    if (obj.userData.vesselGroup === group) {
      obj.visible = visible;
    }
  });
  // Hide junction beads when every meeting branch is off
  root.traverse((obj) => {
    if (obj.userData.isJunction) {
      obj.visible = obj.children.some((c) => c.visible);
    }
  });
}

export { GROUP_COLORS };
