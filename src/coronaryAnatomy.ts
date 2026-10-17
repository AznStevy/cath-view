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

export type GraftId = "lima" | "svg-om" | "svg-pda";

export const GRAFTS: {
  id: GraftId;
  label: string;
  color: string;
  detail: string;
}[] = [
  {
    id: "lima",
    label: "LIMA to LAD",
    color: "#d07060",
    detail: "Internal mammary from the left subclavian → mid LAD",
  },
  {
    id: "svg-om",
    label: "SVG to OM",
    color: "#d4c48a",
    detail: "Ascending aorta, left and high → obtuse marginal",
  },
  {
    id: "svg-pda",
    label: "SVG to PDA",
    color: "#cbb892",
    detail: "Ascending aorta, right-anterior → PDA",
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

/** Control points are already seated on the chamber surface. */
function epicardialPath(points: Pt[]): Pt[] {
  return points;
}

function ptsEqual(a: Pt, b: Pt): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Shared branch anchors — child tubes must start on these exact points so
 * junctions meet cleanly (same pattern as ekg-view conduction pathways).
 * Patient frame: +X left, +Y head, +Z anterior. Right-dominant tree.
 */
/** On the aortic wall. Seated onto the sinus at runtime. */
const LEFT_OST: Pt = [0.238, 0.12, -0.04];
const RIGHT_OST: Pt = [-0.137, 0.143, 0.262];
/** Short straight takeoff so the vessel leaves the sinus before it turns. */
const LM_TAKEOFF: Pt = [0.42, 0.08, 0.02];
const RCA_TAKEOFF: Pt = [-0.08, 0.08, 0.28];
const LM_BIFUR: Pt = [0.56, 0.11, 0.2];

/** Anterior interventricular groove, seated just outside the LV–RV seam. */
const LAD_S1: Pt = [0.69, 0.01, 0.475];
const LAD_D1: Pt = [0.726, -0.13, 0.651];
const LAD_S2: Pt = [0.738, -0.27, 0.771];
/** Mid LAD, where the internal mammary lands. */
const LAD_MID: Pt = [0.738, -0.34, 0.812];
const LAD_D2: Pt = [0.726, -0.41, 0.839];
const LAD_S3: Pt = [0.75, -0.55, 0.89];
const LAD_D3: Pt = [0.762, -0.69, 0.912];
const LAD_S4: Pt = [0.786, -0.97, 0.835];

/** Left AV groove, from the lateral wall around to the posterior sulcus. */
const LCX_OM1: Pt = [0.78, 0.06, -0.02];
const LCX_OM2: Pt = [0.753, 0.04, -0.227];
const LCX_OM3: Pt = [0.547, -0.08, -0.48];
const LCX_PL1: Pt = [0.541, -0.36, -0.662];

/** Right AV groove: a single curve from the ostium around the acute margin to the crux. */
const RCA_CONUS: Pt = [-0.34, 0.04, 0.4];
const RCA_SN: Pt = [-0.46, -0.02, 0.38];
const RCA_RV: Pt = [-0.58, -0.18, 0.32];
const RCA_AM1: Pt = [-0.68, -0.36, 0.24];
const RCA_AM2: Pt = [-0.7, -0.54, 0.14];
/** Crux on the diaphragmatic surface, where the right AV groove meets the posterior interventricular groove. */
const CRUX: Pt = [-0.02, -0.86, 0];
/** Posterior descending stays in the inferior RV–LV sulcus through the apex. */
const PDA_A: Pt = [0.07, -0.91, 0.04];
const PDA_B: Pt = [0.14, -0.98, 0.09];
const PDA_MID: Pt = [0.32, -1.0, 0.2];
const PDA_C: Pt = [0.45, -1.05, 0.3];
const PDA_D: Pt = [0.58, -1.1, 0.4];
const PDA_TIP: Pt = [0.68, -1.13, 0.49];
/** Body of OM1, where an aortocoronary graft lands. */
const OM1_MID: Pt = [0.966, -0.06, 0.1];

const PATHS: PathSpec[] = [
  {
    id: "lm",
    group: "lm",
    name: "Left main (LM)",
    detail: "Left coronary ostium → bifurcation",
    radiusStart: 0.027,
    radiusEnd: 0.023,
    points: [LEFT_OST, LM_TAKEOFF, LM_BIFUR],
  },
  {
    id: "lad",
    parentId: "lm",
    group: "lad",
    name: "LAD",
    detail: "Left anterior descending · AIV groove → apex",
    radiusStart: 0.0215,
    radiusEnd: 0.009,
    tubularSegments: 96,
    points: [
      LM_BIFUR,
      [0.61, 0.105, 0.25],
      [0.65, 0.07, 0.34],
      LAD_S1,
      [0.714, -0.06, 0.571],
      LAD_D1,
      [0.738, -0.2, 0.707],
      LAD_S2,
      LAD_MID,
      LAD_D2,
      [0.738, -0.48, 0.867],
      LAD_S3,
      [0.75, -0.62, 0.903],
      LAD_D3,
      [0.75, -0.76, 0.902],
      [0.762, -0.83, 0.898],
      [0.774, -0.9, 0.876],
      LAD_S4,
      [0.792, -1.0, 0.8],
      [0.786, -1.05, 0.74],
    ],
  },
  {
    id: "s1",
    parentId: "lad",
    group: "septal",
    name: "Septal S1",
    detail: "First septal perforator",
    radiusStart: 0.011,
    radiusEnd: 0.006,
    points: [LAD_S1, [0.5, -0.02, 0.32], [0.34, -0.08, 0.16]],
  },
  {
    id: "s2",
    parentId: "lad",
    group: "septal",
    name: "Septal S2",
    detail: "Second septal perforator",
    radiusStart: 0.01,
    radiusEnd: 0.005,
    points: [LAD_S2, [0.54, -0.32, 0.52], [0.36, -0.4, 0.26]],
  },
  {
    id: "s3",
    parentId: "lad",
    group: "septal",
    name: "Septal S3",
    detail: "Third septal perforator",
    radiusStart: 0.009,
    radiusEnd: 0.005,
    points: [LAD_S3, [0.54, -0.62, 0.58], [0.36, -0.72, 0.3]],
  },
  {
    id: "s4",
    parentId: "lad",
    group: "septal",
    name: "Septal S4",
    detail: "Distal septal perforator",
    radiusStart: 0.008,
    radiusEnd: 0.004,
    points: [LAD_S4, [0.64, -1.0, 0.62], [0.55, -1.03, 0.5]],
  },
  {
    id: "d1",
    parentId: "lad",
    group: "diag",
    name: "Diagonal D1",
    detail: "First diagonal · anterolateral LV free wall",
    radiusStart: 0.014,
    radiusEnd: 0.007,
    tubularSegments: 48,
    hugEpicardium: true,
    points: epicardialPath([
      LAD_D1,
      [0.931, -0.18, 0.58],
      [1.099, -0.34, 0.402],
      [1.157, -0.5, 0.182],
    ]),
  },
  {
    id: "d2",
    parentId: "lad",
    group: "diag",
    name: "Diagonal D2",
    detail: "Second diagonal · mid anterolateral wall",
    radiusStart: 0.012,
    radiusEnd: 0.006,
    tubularSegments: 48,
    hugEpicardium: true,
    points: epicardialPath([
      LAD_D2,
      [1.067, -0.5, 0.716],
      [1.17, -0.68, 0.416],
      [1.132, -0.84, 0.161],
    ]),
  },
  {
    id: "d3",
    parentId: "lad",
    group: "diag",
    name: "Diagonal D3",
    detail: "Third diagonal · distal anterolateral wall",
    radiusStart: 0.01,
    radiusEnd: 0.005,
    hugEpicardium: true,
    points: epicardialPath([
      LAD_D3,
      [1.092, -0.82, 0.717],
      [1.058, -1.02, 0.324],
    ]),
  },
  {
    id: "lcx",
    parentId: "lm",
    group: "lcx",
    name: "LCx",
    detail: "Left circumflex · wraps left AV groove on epicardium → terminal PL",
    radiusStart: 0.02,
    radiusEnd: 0.01,
    tubularSegments: 96,
    taperHold: 0,
    taperPower: 0.9,
    points: [
      LM_BIFUR,
      [0.66, 0.09, 0.12],
      [0.74, 0.07, 0.02],
      LCX_OM1,
      [0.807, 0.05, -0.122],
      LCX_OM2,
      [0.655, 0.02, -0.333],
      LCX_OM3,
      [0.547, -0.12, -0.53],
      [0.557, -0.24, -0.629],
      LCX_PL1,
    ],
  },
  {
    id: "om1",
    parentId: "lcx",
    group: "om",
    name: "OM1",
    detail: "First obtuse marginal · high lateral free wall",
    radiusStart: 0.014,
    radiusEnd: 0.007,
    tubularSegments: 48,
    hugEpicardium: true,
    points: epicardialPath([
      LCX_OM1,
      OM1_MID,
      [1.07, -0.26, 0.019],
      [1.111, -0.48, -0.022],
    ]),
  },
  {
    id: "om2",
    parentId: "lcx",
    group: "om",
    name: "OM2",
    detail: "Second obtuse marginal · mid-lateral free wall",
    radiusStart: 0.012,
    radiusEnd: 0.006,
    tubularSegments: 48,
    hugEpicardium: true,
    points: epicardialPath([
      LCX_OM2,
      [0.95, -0.08, -0.097],
      [1.069, -0.32, -0.062],
      [1.118, -0.55, -0.007],
    ]),
  },
  {
    id: "om3",
    parentId: "lcx",
    group: "om",
    name: "OM3",
    detail: "Third obtuse marginal · low lateral free wall",
    radiusStart: 0.01,
    radiusEnd: 0.005,
    hugEpicardium: true,
    points: epicardialPath([
      LCX_OM3,
      [0.782, -0.12, -0.357],
      [0.995, -0.38, -0.225],
      [1.092, -0.62, -0.067],
    ]),
  },
  {
    id: "lpl",
    parentId: "lcx",
    group: "lpl",
    name: "LCx PL",
    detail: "Terminal posterolateral continuation of distal LCx",
    radiusStart: 0.009,
    radiusEnd: 0.005,
    hugEpicardium: true,
    points: epicardialPath([
      LCX_PL1,
      [0.509, -0.5, -0.599],
      [0.514, -0.68, -0.6],
    ]),
  },
  {
    id: "rca",
    group: "rca",
    name: "RCA",
    detail: "Right coronary artery · right AV groove → crux",
    radiusStart: 0.023,
    radiusEnd: 0.013,
    tubularSegments: 96,
    points: [
      RIGHT_OST,
      RCA_TAKEOFF,
      RCA_CONUS,
      RCA_SN,
      [-0.52, -0.1, 0.35],
      RCA_RV,
      [-0.64, -0.27, 0.28],
      RCA_AM1,
      [-0.7, -0.45, 0.18],
      RCA_AM2,
      [-0.6, -0.66, 0.05],
      [-0.32, -0.76, 0],
      CRUX,
    ],
  },
  {
    id: "sn",
    parentId: "rca",
    group: "sn",
    name: "SN branch",
    detail: "Sinoatrial node artery · proximal RCA along the right atrium",
    radiusStart: 0.009,
    radiusEnd: 0.005,
    hugEpicardium: true,
    points: epicardialPath([
      RCA_SN,
      [-0.44, 0.12, 0.55],
      [-0.48, 0.2, 0.48],
      [-0.5, 0.28, 0.42],
    ]),
  },
  {
    id: "conus",
    parentId: "rca",
    group: "conus",
    name: "Conus",
    detail: "Conus branch · RVOT",
    radiusStart: 0.01,
    radiusEnd: 0.005,
    points: [RCA_CONUS, [-0.184, 0.22, 0.758], [-0.064, 0.32, 0.816]],
  },
  {
    id: "rv",
    parentId: "rca",
    group: "rv",
    name: "RV branch",
    detail: "Right ventricular branch · mid RCA → RV free wall",
    radiusStart: 0.011,
    radiusEnd: 0.005,
    tubularSegments: 40,
    hugEpicardium: true,
    points: epicardialPath([
      RCA_RV,
      [-0.48, -0.18, 0.7],
      [-0.32, -0.22, 0.95],
      [-0.12, -0.26, 1.06],
      [0.04, -0.3, 1.12],
    ]),
  },
  {
    id: "am1",
    parentId: "rca",
    group: "am",
    name: "AM1",
    detail: "First acute marginal · proximal acute margin",
    radiusStart: 0.012,
    radiusEnd: 0.006,
    tubularSegments: 40,
    hugEpicardium: true,
    points: epicardialPath([
      RCA_AM1,
      [-0.55, -0.38, 0.72],
      [-0.38, -0.42, 0.98],
      [-0.16, -0.48, 1.08],
      [0.02, -0.52, 1.12],
    ]),
  },
  {
    id: "am2",
    parentId: "rca",
    group: "am",
    name: "AM2",
    detail: "Second acute marginal · distal acute margin",
    radiusStart: 0.011,
    radiusEnd: 0.005,
    hugEpicardium: true,
    points: epicardialPath([
      RCA_AM2,
      [-0.58, -0.55, 0.7],
      [-0.4, -0.62, 0.95],
      [-0.16, -0.68, 1.05],
      [0.04, -0.72, 1.1],
    ]),
  },
  {
    id: "pda",
    parentId: "rca",
    group: "pda",
    name: "PDA",
    detail: "Posterior descending · down the PIV groove (LAO: straight inferior)",
    radiusStart: 0.012,
    radiusEnd: 0.006,
    tubularSegments: 64,
    hugEpicardium: true,
    points: epicardialPath([CRUX, PDA_A, PDA_B, PDA_MID, PDA_C, PDA_D, PDA_TIP]),
  },
  {
    id: "rpl",
    parentId: "rca",
    group: "rpl",
    name: "PLV / RPL",
    detail: "Posterolateral continuation of RCA past crux · AV groove → inferior LV",
    radiusStart: 0.013,
    radiusEnd: 0.006,
    tubularSegments: 64,
    hugEpicardium: true,
    points: epicardialPath([
      CRUX,
      [0.02, -0.7, -0.28],
      [0.22, -0.64, -0.52],
      [0.4, -0.58, -0.62],
    ]),
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

function closestT(curve: THREE.Curve<THREE.Vector3>, point: Pt): number {
  const target = new THREE.Vector3(...point);
  const p = new THREE.Vector3();
  let bestT = 0;
  let bestD = Infinity;
  const samples = 48;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    curve.getPointAt(t, p);
    const d = p.distanceToSquared(target);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  return bestT;
}

function radiusOnSpec(spec: PathSpec, t: number): number {
  const hold = spec.taperHold ?? 0;
  const span = 1 - hold;
  const u = span <= 1e-6 || t <= hold ? 0 : (t - hold) / span;
  const smooth = spec.taperPower != null ? Math.pow(u, spec.taperPower) : u * u * (3 - 2 * u);
  return THREE.MathUtils.lerp(spec.radiusStart, spec.radiusEnd, smooth);
}

/** Largest child that begins where the parent ends. That one continues the parent. */
function isContinuation(spec: PathSpec): boolean {
  if (!spec.parentId) return false;
  const parent = PATHS.find((p) => p.id === spec.parentId);
  if (!parent) return false;
  const end = parent.points[parent.points.length - 1];
  if (!ptsEqual(spec.points[0], end)) return false;
  let best = spec;
  for (const other of PATHS) {
    if (other.parentId !== spec.parentId || !ptsEqual(other.points[0], end)) continue;
    if (other.radiusStart > best.radiusStart) best = other;
  }
  return best.id === spec.id;
}

/**
 * Overlap the continuation back along the parent so the column doesn't gap.
 * The child keeps its own caliber; the LAD is narrower than the left main.
 */
function sleeveContinuation(spec: PathSpec): { points: Pt[]; radiusStart: number } {
  const parent = PATHS.find((p) => p.id === spec.parentId);
  if (!parent) return { points: spec.points, radiusStart: spec.radiusStart };
  const curve = makeCurve(parent.points);
  const t = closestT(curve, spec.points[0]);
  const parentR = radiusOnSpec(parent, t);
  const length = Math.max(curve.getLength(), 1e-4);
  const backT = Math.max(0, (t * length - parentR * 0.85) / length);
  const back = curve.getPointAt(backT);
  return {
    points: [[back.x, back.y, back.z], ...spec.points],
    radiusStart: spec.radiusStart,
  };
}

/** Pull an ostium into the aortic lumen so the tube overlaps the wall. */
function buryTowardAorta(point: Pt, radius: number): Pt {
  const curve = aortaCurve();
  const t = closestT(curve, point);
  const center = curve.getPointAt(t);
  const away = new THREE.Vector3(point[0] - center.x, point[1] - center.y, point[2] - center.z);
  const dist = away.length();
  if (dist < 1e-5) return point;
  away.multiplyScalar(1 / dist);
  const aorticR = aortaRadiusAt(t);
  const seated = Math.min(dist, Math.max(0, aorticR - radius * 0.15));
  const p = center.clone().addScaledVector(away, seated);
  return [p.x, p.y, p.z];
}

/**
 * Keep a short overlap into the parent so the column doesn't break,
 * without repainting the whole parent lumen.
 */
function contrastWindow(
  spec: PathSpec,
  curve: THREE.CatmullRomCurve3,
  anchor: Pt,
): { dyeSkipT: number; dyeEndT: number } {
  if (!spec.parentId) return { dyeSkipT: 0, dyeEndT: 1 };
  const parent = PATHS.find((p) => p.id === spec.parentId);
  if (!parent) return { dyeSkipT: 0, dyeEndT: 1 };
  const parentCurve = makeCurve(parent.points);
  const parentR = radiusOnSpec(parent, closestT(parentCurve, anchor));
  const len = Math.max(curve.getLength(), 1e-4);
  if (isContinuation(spec)) {
    const t = closestT(curve, anchor);
    return { dyeSkipT: Math.max(0, t - (parentR * 0.55) / len), dyeEndT: 1 };
  }
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const search = Math.min(0.55, (parentR * 3) / len);
  let tHit = search;
  const steps = 28;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * search;
    curve.getPointAt(t, p);
    parentCurve.getPointAt(closestT(parentCurve, [p.x, p.y, p.z]), q);
    if (p.distanceTo(q) >= parentR * 0.8) {
      tHit = t;
      break;
    }
  }
  const overlap = Math.min(tHit * 0.5, (parentR * 0.4) / len);
  return { dyeSkipT: Math.max(0, tHit - overlap), dyeEndT: 1 };
}

function childLeavesTip(spec: PathSpec): boolean {
  const tip = spec.points[spec.points.length - 1];
  return PATHS.some((p) => p.parentId === spec.id && ptsEqual(p.points[0], tip));
}

function createVesselMesh(spec: PathSpec): THREE.Mesh {
  const anchor = spec.points[0];
  let points = spec.points;
  let radiusStart = spec.radiusStart;
  if (!spec.parentId) {
    points = [buryTowardAorta(anchor, radiusStart), ...spec.points.slice(1)];
  } else if (isContinuation(spec)) {
    const sleeved = sleeveContinuation(spec);
    points = sleeved.points;
    radiusStart = sleeved.radiusStart;
  }
  const curve = makeCurve(points);
  const tubularSegments = spec.tubularSegments ?? 48;
  const radialSegments = 10;
  const geo = createTaperedTubeGeometry(
    curve,
    tubularSegments,
    radiusStart,
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
  mesh.userData.takeoffPoint = new THREE.Vector3(...anchor);
  mesh.name = `vessel-${spec.id}`;

  const materials: THREE.MeshStandardMaterial[] = [mat];
  // Origins sit inside the parent. Cap only a free tip, where nothing continues.
  if (!childLeavesTip(spec)) {
    const endCapMat = mat.clone();
    const endCap = new THREE.Mesh(new THREE.CircleGeometry(spec.radiusEnd * 1.02, 12), endCapMat);
    endCap.position.copy(curve.getPointAt(1));
    endCap.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      curve.getTangentAt(1).normalize(),
    );
    endCap.userData.vesselGroup = spec.group;
    endCap.userData.isVessel = true;
    mesh.add(endCap);
    materials.push(endCapMat);
  }

  const indexCount = geo.index?.count ?? 0;
  const window = contrastWindow(spec, curve, anchor);
  const contrast: ContrastVessel = {
    id: spec.id,
    parentId: spec.parentId ?? null,
    length: curve.getLength(),
    curve,
    takeoffT: 0,
    startDelay: 0,
    dye,
    mesh,
    materials,
    indexCount,
    tubularSegments,
    radialSegments,
    dyeSkipT: window.dyeSkipT,
    dyeEndT: window.dyeEndT,
    radiusStart: spec.radiusStart,
    radiusEnd: spec.radiusEnd,
    taperHold: spec.taperHold ?? 0,
    taperPower: spec.taperPower ?? null,
  };
  mesh.userData.contrast = contrast;

  return mesh;
}

type HeartPartJson = {
  id: string;
  positions: number[];
  indices: number[];
};

const HEART_PART_COLOR: Record<string, number> = {
  lv: 0xb14a40,
  rv: 0x94404a,
  la: 0x86424c,
  ra: 0x7a3e4a,
  aorta: 0xc15a50,
  arch: 0xc15a50,
  pa: 0x6e4c58,
};

let heartOpacity = 0.1;

function applyHeartOpacity(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
      mat.opacity = heartOpacity;
      mat.transparent = heartOpacity < 0.995;
      mat.depthWrite = heartOpacity > 0.55;
      mat.needsUpdate = true;
    }
  });
}

/** 0 hides the heart, 1 is solid. Chambers and great vessels share one opacity. */
export function setHeartOpacity(root: THREE.Object3D, opacity: number): void {
  heartOpacity = THREE.MathUtils.clamp(opacity, 0, 1);
  const shell = root.getObjectByName("heartShell") ?? root;
  applyHeartOpacity(shell);
}

let vesselOpacity = 1;

function applyVesselOpacity(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.userData.isVessel) return;
    if (obj.userData.isDyeOverlay || obj.userData.isLesionMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
      mat.opacity = vesselOpacity;
      mat.transparent = vesselOpacity < 0.995;
      mat.depthWrite = vesselOpacity > 0.55;
      mat.needsUpdate = true;
    }
  });
}

/** 0 hides the coronaries and grafts, 1 is solid. */
export function setVesselOpacity(root: THREE.Object3D, opacity: number): void {
  vesselOpacity = THREE.MathUtils.clamp(opacity, 0, 1);
  applyVesselOpacity(root);
}

function heartMaterial(color: number, opacity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.62,
    metalness: 0.02,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: true,
  });
}

let heartJson: Promise<HeartPartJson[]> | null = null;

function loadHeartParts(): Promise<HeartPartJson[]> {
  if (!heartJson) {
    heartJson = fetch(`${import.meta.env.BASE_URL}heart/heart.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`Heart geometry failed to load (${res.status})`);
        return res.json() as Promise<{ parts: HeartPartJson[] }>;
      })
      .then((data) => data.parts);
  }
  return heartJson;
}

function addHeartParts(group: THREE.Group, parts: HeartPartJson[]): void {
  for (const part of parts) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(part.positions, 3));
    geo.setIndex(part.indices);
    if (part.id === "lv") openLvOutflow(geo);
    geo.computeVertexNormals();
    const greatVessel = part.id === "aorta" || part.id === "arch" || part.id === "pa";
    const mesh = new THREE.Mesh(
      geo,
      heartMaterial(HEART_PART_COLOR[part.id] ?? 0x8d403c, heartOpacity),
    );
    mesh.name = greatVessel ? part.id : "myocardium";
    mesh.raycast = () => {};
    group.add(mesh);
  }
  addAortaBridge(group);
  addPulmonaryArteries(group);
  applyHeartOpacity(group);
}

/**
 * The source pulmonary artery is already one trunk and two branches.
 * Vertices that enter the aorta are eased out behind it so the vessel stays whole.
 */
function clearPulmonaryArtery(mesh: THREE.Mesh): void {
  const geo = mesh.geometry;
  const pos = geo.getAttribute("position");
  if (!(pos instanceof THREE.BufferAttribute)) return;
  const curve = aortaCurve();
  const samples: { p: THREE.Vector3; r: number }[] = [];
  for (let i = 0; i <= 80; i++) {
    const t = i / 80;
    const p = curve.getPointAt(t);
    if (p.y < 0.15) continue;
    if (p.y > 1.15) break;
    samples.push({ p, r: aortaRadiusAt(t) });
  }
  const v = new THREE.Vector3();
  const away = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    let best = Infinity;
    let center = samples[0]?.p;
    let radius = 0.19;
    for (const s of samples) {
      const d = v.distanceTo(s.p);
      if (d < best) {
        best = d;
        center = s.p;
        radius = s.r;
      }
    }
    if (!center) continue;
    const limit = radius + 0.045;
    if (best >= limit) continue;
    away.set(v.x - center.x + 0.08, v.y - center.y, v.z - center.z - 0.14);
    if (away.lengthSq() < 1e-6) away.set(0.25, 0, -0.2);
    away.normalize();
    v.copy(center).addScaledVector(away, limit);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

function addPulmonaryArteries(group: THREE.Group): void {
  const source = group.getObjectByName("pa");
  if (source instanceof THREE.Mesh) clearPulmonaryArtery(source);
}

/**
 * The valve sits at the base of the left ventricle. A short outflow mouth
 * meets the cavity there; the tube does not run down into the chamber.
 * Then a straight ascending aorta and a semicircular arch. Ostia sit on the sinus.
 */
const AORTA_SINUS_INDEX = 2;
const AORTA_CENTERLINE: Pt[] = [
  [0.1, -0.02, 0.042],
  [0.055, 0.08, 0.048],
  [0.028, 0.16, 0.056],
  [0.005, 0.22, 0.065],
  [-0.016, 0.28, 0.075],
  [-0.035, 0.44, 0.094],
  [-0.054, 0.6, 0.112],
  [-0.072, 0.76, 0.131],
  [-0.041, 1.014, 0.077],
  [-0.013, 1.196, -0.044],
  [0.016, 1.317, -0.226],
  [0.045, 1.36, -0.44],
  [0.074, 1.317, -0.654],
  [0.103, 1.196, -0.836],
  [0.131, 1.014, -0.957],
  [0.16, 0.8, -1.0],
];

/** Radius at each centerline control. Annulus, mild sinus, then the ascending tube. */
const AORTA_RADII = [
  0.15, 0.145, 0.17, 0.18, 0.19, 0.19, 0.19, 0.19, 0.19, 0.188, 0.186, 0.184, 0.182, 0.18, 0.178,
  0.176,
];

function aortaCurve(): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(
    AORTA_CENTERLINE.map((p) => new THREE.Vector3(...p)),
    false,
    "catmullrom",
    0.5,
  );
}

let aortaRadiusLookup: ((t: number) => number) | null = null;

/** Arc-length fraction of control point i. getPointAt uses this, not the raw curve parameter. */
function controlArcFraction(curve: THREE.CatmullRomCurve3, index: number, count: number): number {
  if (index <= 0) return 0;
  if (index >= count - 1) return 1;
  const samples = 80;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  curve.getPoint(0, a);
  const cum = [0];
  for (let s = 1; s <= samples; s++) {
    curve.getPoint(s / samples, b);
    cum.push(cum[s - 1] + a.distanceTo(b));
    a.copy(b);
  }
  const target = (index / (count - 1)) * samples;
  const i0 = Math.floor(target);
  const f = target - i0;
  const dist = cum[i0] * (1 - f) + cum[Math.min(samples, i0 + 1)] * f;
  return dist / cum[samples];
}

function aortaRadiusAt(t: number): number {
  if (!aortaRadiusLookup) {
    const curve = aortaCurve();
    const n = AORTA_RADII.length;
    const tAt = AORTA_RADII.map((_, i) => controlArcFraction(curve, i, n));
    aortaRadiusLookup = (u: number) => {
      const x = THREE.MathUtils.clamp(u, 0, 1);
      let i = 0;
      while (i < n - 2 && tAt[i + 1] < x) i++;
      const span = Math.max(1e-4, tAt[i + 1] - tAt[i]);
      const f = THREE.MathUtils.clamp((x - tAt[i]) / span, 0, 1);
      const s = f * f * (3 - 2 * f);
      return THREE.MathUtils.lerp(AORTA_RADII[i], AORTA_RADII[i + 1], s);
    };
  }
  return aortaRadiusLookup(t);
}

function createProfileTube(
  curve: THREE.CatmullRomCurve3,
  tubularSegments: number,
  radialSegments: number,
): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(tubularSegments, false);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const normal = new THREE.Vector3();
  const vertex = new THREE.Vector3();

  for (let i = 0; i <= tubularSegments; i++) {
    const t = i / tubularSegments;
    const p = curve.getPointAt(t);
    const N = frames.normals[i];
    const B = frames.binormals[i];
    const radius = aortaRadiusAt(t);
    for (let j = 0; j <= radialSegments; j++) {
      const v = j / radialSegments;
      const angle = v * Math.PI * 2;
      const sin = Math.sin(angle);
      const cos = -Math.cos(angle);
      normal.set(cos * N.x + sin * B.x, cos * N.y + sin * B.y, cos * N.z + sin * B.z).normalize();
      vertex.copy(p).addScaledVector(normal, radius);
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

/**
 * The source aorta and arch are coarse shells. One profiled tube is the vessel.
 */
function addAortaBridge(group: THREE.Group): void {
  const aorta = group.getObjectByName("aorta");
  const arch = group.getObjectByName("arch");
  if (aorta) aorta.visible = false;
  if (arch) arch.visible = false;

  const curve = aortaCurve();
  const mat = heartMaterial(HEART_PART_COLOR.aorta, heartOpacity);
  const mesh = new THREE.Mesh(createProfileTube(curve, 96, 28), mat);
  mesh.name = "aorta";
  mesh.raycast = () => {};
  const end = curve.getPointAt(1);
  const cap = new THREE.Mesh(new THREE.CircleGeometry(aortaRadiusAt(1), 20), mat);
  cap.name = "aorta";
  cap.position.copy(end);
  cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), curve.getTangentAt(1).normalize());
  cap.raycast = () => {};
  group.add(mesh, cap);
}

/** Put the coronary ostia on the sinus wall, with a short straight takeoff. */
/** Drop LV faces that wall off the outflow so the aorta continues the lumen. */
function openLvOutflow(geo: THREE.BufferGeometry): void {
  const index = geo.getIndex();
  const pos = geo.getAttribute("position");
  if (!index || !(pos instanceof THREE.BufferAttribute)) return;
  const curve = aortaCurve();
  const samples: THREE.Vector3[] = [];
  const sampleR: number[] = [];
  for (let i = 0; i <= 90; i++) {
    const t = i / 90;
    const p = curve.getPointAt(t);
    if (p.y > 0.36) break;
    samples.push(p);
    sampleR.push(aortaRadiusAt(t));
  }
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cent = new THREE.Vector3();
  const keep: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i);
    const ib = index.getX(i + 1);
    const ic = index.getX(i + 2);
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    cent.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    let blocked = false;
    if (cent.y < 0.28 && cent.y > -0.16) {
      for (let s = 0; s < samples.length; s++) {
        if (cent.distanceTo(samples[s]) < sampleR[s] * 0.75) {
          blocked = true;
          break;
        }
      }
    }
    if (!blocked) keep.push(ia, ib, ic);
  }
  geo.setIndex(keep);
}

/** Put the coronary ostia on the sinus wall, with a short straight takeoff. */
function seatAorticOstia(): void {
  const curve = aortaCurve();
  const sinusIndex = AORTA_SINUS_INDEX;
  const t = controlArcFraction(curve, sinusIndex, AORTA_CENTERLINE.length);
  const center = curve.getPointAt(t);
  const tangent = curve.getTangentAt(t).normalize();
  const radius = aortaRadiusAt(t);
  const place = (dir: THREE.Vector3, next: Pt, ost: Pt, stub: Pt) => {
    const toward = new THREE.Vector3(
      next[0] - center.x,
      next[1] - center.y,
      next[2] - center.z,
    );
    const aim = dir.clone();
    if (toward.lengthSq() > 1e-6) aim.lerp(toward.normalize(), 0.88);
    const outward = aim.addScaledVector(tangent, -aim.dot(tangent)).normalize();
    const wall = center.clone().addScaledVector(outward, radius);
    const tip = center.clone().addScaledVector(outward, radius + 0.05);
    ost[0] = wall.x;
    ost[1] = wall.y;
    ost[2] = wall.z;
    stub[0] = tip.x;
    stub[1] = tip.y;
    stub[2] = tip.z;
  };
  place(new THREE.Vector3(1, 0.06, -0.2), LM_BIFUR, LEFT_OST, LM_TAKEOFF);
  place(new THREE.Vector3(-0.45, 0.04, 1), RCA_CONUS, RIGHT_OST, RCA_TAKEOFF);
}

function createHeartShell(): THREE.Group {
  const group = new THREE.Group();
  group.name = "heartShell";
  void loadHeartParts()
    .then((parts) => addHeartParts(group, parts))
    .catch((err: unknown) => {
      console.error(err);
    });
  return group;
}

/** Left subclavian off the superior arch; the internal mammary leaves its underside. */
function subclavianCourse(): Pt[] {
  const curve = aortaCurve();
  const t = closestT(curve, [0.07, 1.32, -0.55]);
  const center = curve.getPointAt(t);
  const tangent = curve.getTangentAt(t).normalize();
  const out = new THREE.Vector3(1, 0.35, -0.15);
  out.addScaledVector(tangent, -out.dot(tangent)).normalize();
  const localRadius = aortaRadiusAt(t);
  const origin = center.clone().addScaledVector(out, localRadius * 0.9);
  const mid = origin.clone().addScaledVector(out, 0.2);
  const end = origin.clone().addScaledVector(out, 0.38);
  const pt = (v: THREE.Vector3): Pt => [v.x, v.y, v.z];
  return [pt(origin), pt(mid), pt(end)];
}

const [SUBCLAV_OST, SUBCLAV_IMA, SUBCLAV_END] = subclavianCourse();

function createSubclavianMesh(): THREE.Group {
  const points: Pt[] = [SUBCLAV_OST, SUBCLAV_IMA, SUBCLAV_END];
  const curve = makeCurve(points);
  const radius = 0.05;
  const color = 0xc15a50;
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.45,
    metalness: 0.05,
    emissive: color,
    emissiveIntensity: 0.05,
  });
  const geo = createTaperedTubeGeometry(curve, 24, radius, radius * 0.86, 10);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "vessel-subclavian";
  const tag = (obj: THREE.Object3D) => {
    obj.userData.isVessel = true;
    obj.userData.isGraft = true;
    obj.userData.graftId = "lima";
    obj.userData.vesselName = "Left subclavian";
    obj.userData.vesselDetail = "Arch branch; the internal mammary leaves its underside";
  };
  tag(mesh);
  mesh.userData.pickCurve = curve;
  const end = curve.getPointAt(1);
  const cap = (at: THREE.Vector3, tangent: THREE.Vector3, capRadius: number) => {
    const disk = new THREE.Mesh(new THREE.CircleGeometry(capRadius, 12), mat);
    disk.position.copy(at);
    disk.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
    tag(disk);
    return disk;
  };
  const group = new THREE.Group();
  group.name = "subclavian";
  group.add(mesh, cap(end, curve.getTangentAt(1).normalize(), radius * 0.86));
  return group;
}

function createGraftMesh(
  id: GraftId,
  name: string,
  detail: string,
  color: number,
  points: Pt[],
  radius: number,
  radiusEnd = radius * 0.72,
): THREE.Group {
  const group = new THREE.Group();
  group.name = id;
  const curve = makeCurve(points);
  const tubularSegments = 48;
  const radialSegments = 8;
  const geo = createTaperedTubeGeometry(curve, tubularSegments, radius, radiusEnd, radialSegments);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.4,
    metalness: 0.06,
    emissive: color,
    emissiveIntensity: 0.08,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `vessel-${id}`;
  const tag = (obj: THREE.Object3D) => {
    obj.userData.isVessel = true;
    obj.userData.isGraft = true;
    obj.userData.graftId = id;
    obj.userData.vesselName = name;
    obj.userData.vesselDetail = detail;
  };
  tag(mesh);
  mesh.userData.anastomosisPoint = new THREE.Vector3(...points[points.length - 1]);
  mesh.userData.takeoffPoint = new THREE.Vector3(...points[0]);
  const dye = createDyeUniforms(0);
  const contrast: ContrastVessel = {
    id,
    parentId: null,
    length: curve.getLength(),
    curve,
    takeoffT: 0,
    startDelay: 0,
    dye,
    mesh,
    materials: [mat],
    indexCount: geo.index?.count ?? 0,
    tubularSegments,
    radialSegments,
    dyeSkipT: 0,
    dyeEndT: 1,
    radiusStart: radius,
    radiusEnd,
    taperHold: 0,
    taperPower: null,
  };
  mesh.userData.contrast = contrast;

  group.add(mesh);
  group.visible = false;
  return group;
}

function createGrafts(): THREE.Group {
  const group = new THREE.Group();
  group.name = "grafts";
  const byId = Object.fromEntries(GRAFTS.map((g) => [g.id, g])) as Record<
    GraftId,
    (typeof GRAFTS)[number]
  >;
  const limaTakeoff: Pt = [
    SUBCLAV_OST[0] + (SUBCLAV_END[0] - SUBCLAV_OST[0]) * 0.42,
    SUBCLAV_OST[1] + (SUBCLAV_END[1] - SUBCLAV_OST[1]) * 0.42,
    SUBCLAV_OST[2] + (SUBCLAV_END[2] - SUBCLAV_OST[2]) * 0.42,
  ];
  const lima = createGraftMesh(
    "lima",
    byId.lima.label,
    byId.lima.detail,
    0xd07060,
    [
      limaTakeoff,
      [limaTakeoff[0] + 0.02, limaTakeoff[1] - 0.1, limaTakeoff[2] + 0.16],
      [0.55, 0.95, 1.22],
      [0.7, 0.45, 1.24],
      [0.76, 0.05, 1.2],
      [0.76, -0.15, 1.05],
      LAD_MID,
    ],
    0.015,
    0.011,
  );
  lima.add(createSubclavianMesh());
  // Courses sit outside the chambers and the pulmonary artery, and meet the target vessel at the end.
  group.add(
    lima,
    createGraftMesh(
      "svg-om",
      byId["svg-om"].label,
      byId["svg-om"].detail,
      0xd4c48a,
      [
        [0.05, 1.071, 0.219],
        [0.075, 1.092, 0.262],
        [0.132, 1.071, 0.346],
        [0.185, 1.011, 0.417],
        [0.237, 0.948, 0.487],
        [0.288, 0.892, 0.563],
        [0.337, 0.849, 0.648],
        [0.384, 0.81, 0.737],
        [0.434, 0.766, 0.821],
        [0.491, 0.708, 0.891],
        [0.549, 0.638, 0.947],
        [0.609, 0.561, 0.992],
        [0.672, 0.479, 1.019],
        [0.74, 0.396, 1.014],
        [0.803, 0.322, 0.97],
        [0.86, 0.257, 0.906],
        [0.913, 0.198, 0.834],
        [0.966, 0.145, 0.757],
        [1.02, 0.1, 0.676],
        [1.072, 0.062, 0.59],
        [1.116, 0.028, 0.498],
        [1.14, -0.001, 0.398],
        [1.125, -0.012, 0.293],
        [1.083, -0.015, 0.194],
        [1.011, -0.041, 0.123],
        OM1_MID,
      ],
      0.018,
      0.012,
    ),
    createGraftMesh(
      "svg-pda",
      byId["svg-pda"].label,
      byId["svg-pda"].detail,
      0xcbb892,
      [
        [-0.181, 0.547, 0.223],
        [-0.241, 0.537, 0.272],
        [-0.331, 0.498, 0.393],
        [-0.404, 0.479, 0.529],
        [-0.479, 0.38, 0.62],
        [-0.609, 0.297, 0.609],
        [-0.73, 0.218, 0.551],
        [-0.841, 0.129, 0.485],
        [-0.938, 0.024, 0.425],
        [-1.021, -0.09, 0.358],
        [-1.078, -0.214, 0.283],
        [-1.096, -0.344, 0.199],
        [-1.082, -0.475, 0.114],
        [-1.039, -0.609, 0.048],
        [-0.97, -0.744, 0.01],
        [-0.897, -0.88, -0.008],
        [-0.868, -1.032, 0.007],
        [-0.739, -1.111, -0.014],
        [-0.583, -1.117, -0.008],
        [-0.44, -1.176, 0.01],
        [-0.293, -1.218, 0.037],
        [-0.142, -1.222, 0.076],
        [0.005, -1.197, 0.122],
        [0.145, -1.149, 0.169],
        [0.266, -1.056, 0.202],
        PDA_MID,
      ],
      0.018,
      0.012,
    ),
  );
  return group;
}

export function setGraftVisibility(
  root: THREE.Object3D,
  id: GraftId,
  visible: boolean,
): void {
  const grafts = root.getObjectByName("grafts");
  const graft = grafts?.getObjectByName(id);
  if (graft) graft.visible = visible;
}

export function createCoronaryAnatomy(): THREE.Group {
  const root = new THREE.Group();
  root.name = "coronaryAnatomy";
  seatAorticOstia();

  root.add(createHeartShell());

  const vessels = new THREE.Group();
  vessels.name = "vessels";
  for (const path of PATHS) {
    vessels.add(createVesselMesh(path));
  }

  root.add(vessels);
  root.add(createGrafts());
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
}

export { GROUP_COLORS };
