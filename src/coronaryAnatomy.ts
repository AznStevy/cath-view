import * as THREE from "three";

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
  | "conus"
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
  { id: "conus", label: "Conus", color: "#c85840", defaultOn: true },
  { id: "am", label: "Acute marginals", color: "#d06848", defaultOn: true },
  { id: "pda", label: "PDA", color: "#c86040", defaultOn: true },
  { id: "rpl", label: "RCA PL", color: "#d87858", defaultOn: true },
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
  conus: 0xc85840,
  am: 0xd06848,
  pda: 0xc86040,
  rpl: 0xd87858,
};

type PathSpec = {
  group: VesselGroup;
  name: string;
  detail: string;
  points: [number, number, number][];
  radiusStart: number;
  radiusEnd: number;
  tubularSegments?: number;
};

/**
 * Right-dominant tree. Patient frame: +X left, +Y head, +Z anterior.
 */
const PATHS: PathSpec[] = [
  {
    group: "lm",
    name: "Left main (LM)",
    detail: "Left coronary ostium → bifurcation",
    radiusStart: 0.095,
    radiusEnd: 0.082,
    points: [
      [0.1, 0.62, 0.12],
      [0.28, 0.55, 0.26],
      [0.48, 0.46, 0.36],
      [0.58, 0.4, 0.4],
    ],
  },
  {
    group: "lad",
    name: "LAD",
    detail: "Left anterior descending · AIV groove → apex",
    radiusStart: 0.078,
    radiusEnd: 0.018,
    tubularSegments: 96,
    points: [
      [0.58, 0.4, 0.4],
      [0.55, 0.28, 0.55],
      [0.48, 0.12, 0.72],
      [0.38, -0.08, 0.88],
      [0.26, -0.32, 0.98],
      [0.14, -0.58, 1.0],
      [0.04, -0.85, 0.88],
      [-0.02, -1.08, 0.62],
      [-0.04, -1.22, 0.32],
      [-0.02, -1.28, 0.02],
      [0.02, -1.22, -0.22],
    ],
  },
  {
    group: "septal",
    name: "Septal S1",
    detail: "First septal perforator",
    radiusStart: 0.032,
    radiusEnd: 0.012,
    points: [
      [0.5, 0.22, 0.58],
      [0.32, 0.08, 0.42],
      [0.18, -0.05, 0.22],
      [0.1, -0.18, 0.05],
    ],
  },
  {
    group: "septal",
    name: "Septal S2",
    detail: "Second septal perforator",
    radiusStart: 0.028,
    radiusEnd: 0.01,
    points: [
      [0.42, -0.02, 0.78],
      [0.26, -0.18, 0.55],
      [0.14, -0.32, 0.28],
      [0.06, -0.42, 0.08],
    ],
  },
  {
    group: "septal",
    name: "Septal S3",
    detail: "Third septal perforator",
    radiusStart: 0.024,
    radiusEnd: 0.008,
    points: [
      [0.3, -0.28, 0.92],
      [0.18, -0.42, 0.65],
      [0.08, -0.55, 0.35],
      [0.02, -0.62, 0.12],
    ],
  },
  {
    group: "septal",
    name: "Septal S4",
    detail: "Distal septal perforator",
    radiusStart: 0.02,
    radiusEnd: 0.007,
    points: [
      [0.16, -0.55, 0.95],
      [0.08, -0.7, 0.62],
      [0.02, -0.82, 0.28],
    ],
  },
  {
    group: "diag",
    name: "Diagonal D1",
    detail: "First diagonal · anterolateral LV",
    radiusStart: 0.048,
    radiusEnd: 0.014,
    tubularSegments: 48,
    points: [
      [0.52, 0.18, 0.62],
      [0.72, 0.05, 0.58],
      [0.92, -0.15, 0.42],
      [1.02, -0.4, 0.22],
      [0.98, -0.65, 0.05],
      [0.85, -0.85, -0.05],
    ],
  },
  {
    group: "diag",
    name: "Diagonal D2",
    detail: "Second diagonal",
    radiusStart: 0.042,
    radiusEnd: 0.012,
    tubularSegments: 48,
    points: [
      [0.4, -0.12, 0.85],
      [0.6, -0.28, 0.75],
      [0.78, -0.5, 0.52],
      [0.85, -0.72, 0.28],
      [0.78, -0.92, 0.08],
    ],
  },
  {
    group: "diag",
    name: "Diagonal D3",
    detail: "Third diagonal",
    radiusStart: 0.032,
    radiusEnd: 0.01,
    points: [
      [0.24, -0.42, 0.96],
      [0.42, -0.58, 0.78],
      [0.52, -0.78, 0.48],
      [0.48, -0.98, 0.2],
    ],
  },
  {
    group: "lcx",
    name: "LCx",
    detail: "Left circumflex · left AV groove",
    radiusStart: 0.072,
    radiusEnd: 0.028,
    tubularSegments: 80,
    points: [
      [0.58, 0.4, 0.4],
      [0.78, 0.34, 0.22],
      [0.95, 0.22, -0.02],
      [1.05, 0.08, -0.28],
      [1.02, -0.05, -0.55],
      [0.88, -0.15, -0.78],
      [0.65, -0.22, -0.95],
      [0.38, -0.28, -1.02],
      [0.12, -0.32, -0.98],
    ],
  },
  {
    group: "om",
    name: "OM1",
    detail: "First obtuse marginal",
    radiusStart: 0.048,
    radiusEnd: 0.014,
    tubularSegments: 48,
    points: [
      [0.88, 0.28, 0.12],
      [1.05, 0.12, 0.18],
      [1.15, -0.12, 0.22],
      [1.12, -0.4, 0.2],
      [0.98, -0.68, 0.12],
      [0.78, -0.92, 0.02],
    ],
  },
  {
    group: "om",
    name: "OM2",
    detail: "Second obtuse marginal",
    radiusStart: 0.042,
    radiusEnd: 0.012,
    tubularSegments: 48,
    points: [
      [1.02, 0.05, -0.35],
      [1.15, -0.15, -0.22],
      [1.12, -0.42, -0.08],
      [0.98, -0.7, 0.02],
      [0.78, -0.95, 0.05],
    ],
  },
  {
    group: "om",
    name: "OM3",
    detail: "Third obtuse marginal",
    radiusStart: 0.034,
    radiusEnd: 0.01,
    points: [
      [0.82, -0.12, -0.72],
      [0.95, -0.32, -0.55],
      [0.92, -0.58, -0.32],
      [0.78, -0.82, -0.12],
    ],
  },
  {
    group: "lpl",
    name: "LCx PL",
    detail: "Left posterolateral branch",
    radiusStart: 0.032,
    radiusEnd: 0.01,
    points: [
      [0.45, -0.26, -0.98],
      [0.55, -0.45, -0.78],
      [0.52, -0.68, -0.48],
      [0.4, -0.88, -0.22],
    ],
  },
  {
    group: "lpl",
    name: "LCx PL2",
    detail: "Second left posterolateral",
    radiusStart: 0.028,
    radiusEnd: 0.009,
    points: [
      [0.22, -0.3, -1.0],
      [0.32, -0.5, -0.82],
      [0.28, -0.75, -0.52],
      [0.18, -0.95, -0.22],
    ],
  },
  {
    group: "rca",
    name: "RCA",
    detail: "Right coronary artery · right AV groove → crux",
    radiusStart: 0.082,
    radiusEnd: 0.045,
    tubularSegments: 96,
    points: [
      [-0.08, 0.58, 0.1],
      [-0.28, 0.5, 0.28],
      [-0.48, 0.38, 0.35],
      [-0.68, 0.22, 0.28],
      [-0.85, 0.05, 0.08],
      [-0.95, -0.08, -0.22],
      [-0.92, -0.18, -0.52],
      [-0.75, -0.25, -0.78],
      [-0.48, -0.3, -0.95],
      [-0.18, -0.32, -1.02],
      [0.08, -0.32, -0.98],
    ],
  },
  {
    group: "conus",
    name: "Conus",
    detail: "Conus branch · RVOT",
    radiusStart: 0.03,
    radiusEnd: 0.01,
    points: [
      [-0.2, 0.52, 0.22],
      [-0.28, 0.55, 0.42],
      [-0.22, 0.48, 0.62],
      [-0.08, 0.38, 0.72],
    ],
  },
  {
    group: "am",
    name: "AM1",
    detail: "First acute marginal",
    radiusStart: 0.038,
    radiusEnd: 0.012,
    tubularSegments: 40,
    points: [
      [-0.72, 0.18, 0.22],
      [-0.88, 0.0, 0.35],
      [-0.95, -0.28, 0.42],
      [-0.88, -0.55, 0.38],
      [-0.7, -0.78, 0.28],
    ],
  },
  {
    group: "am",
    name: "AM2",
    detail: "Second acute marginal",
    radiusStart: 0.032,
    radiusEnd: 0.01,
    points: [
      [-0.9, -0.05, -0.05],
      [-1.02, -0.25, 0.12],
      [-1.0, -0.52, 0.22],
      [-0.85, -0.78, 0.2],
    ],
  },
  {
    group: "am",
    name: "AM3",
    detail: "Third acute marginal",
    radiusStart: 0.028,
    radiusEnd: 0.009,
    points: [
      [-0.88, -0.15, -0.4],
      [-0.98, -0.35, -0.22],
      [-0.92, -0.6, -0.02],
      [-0.75, -0.85, 0.08],
    ],
  },
  {
    group: "pda",
    name: "PDA",
    detail: "Posterior descending · PIV groove",
    radiusStart: 0.048,
    radiusEnd: 0.014,
    tubularSegments: 64,
    points: [
      [0.05, -0.32, -0.98],
      [0.02, -0.52, -0.82],
      [0.0, -0.75, -0.55],
      [-0.01, -0.98, -0.22],
      [-0.02, -1.15, 0.08],
      [-0.01, -1.25, 0.28],
    ],
  },
  {
    group: "rpl",
    name: "PLV / RPL",
    detail: "Posterolateral LV branch (RCA)",
    radiusStart: 0.038,
    radiusEnd: 0.012,
    tubularSegments: 40,
    points: [
      [0.05, -0.32, -0.95],
      [0.22, -0.42, -0.78],
      [0.35, -0.6, -0.48],
      [0.38, -0.82, -0.18],
      [0.3, -1.0, 0.05],
    ],
  },
  {
    group: "rpl",
    name: "RPL2",
    detail: "Second RCA posterolateral",
    radiusStart: 0.032,
    radiusEnd: 0.01,
    points: [
      [-0.05, -0.32, -1.0],
      [0.08, -0.48, -0.85],
      [0.15, -0.7, -0.55],
      [0.12, -0.92, -0.22],
      [0.05, -1.08, 0.02],
    ],
  },
  {
    group: "rpl",
    name: "RPL3",
    detail: "Third RCA posterolateral",
    radiusStart: 0.028,
    radiusEnd: 0.009,
    points: [
      [-0.25, -0.3, -0.98],
      [-0.12, -0.48, -0.88],
      [-0.05, -0.72, -0.58],
      [-0.08, -0.95, -0.25],
    ],
  },
];

function makeCurve(points: [number, number, number][]): THREE.CatmullRomCurve3 {
  const vecs = points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  return new THREE.CatmullRomCurve3(vecs, false, "catmullrom", 0.4);
}

/** Tube with radius taper along the path */
function createTaperedTubeGeometry(
  curve: THREE.Curve<THREE.Vector3>,
  tubularSegments: number,
  radiusStart: number,
  radiusEnd: number,
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
    const radius = THREE.MathUtils.lerp(radiusStart, radiusEnd, t * t * (3 - 2 * t));

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
  const geo = createTaperedTubeGeometry(
    curve,
    spec.tubularSegments ?? 48,
    spec.radiusStart,
    spec.radiusEnd,
    10,
  );
  const mat = new THREE.MeshStandardMaterial({
    color: GROUP_COLORS[spec.group],
    roughness: 0.4,
    metalness: 0.05,
    emissive: GROUP_COLORS[spec.group],
    emissiveIntensity: 0.08,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.vesselGroup = spec.group;
  mesh.userData.vesselName = spec.name;
  mesh.userData.vesselDetail = spec.detail;
  mesh.userData.isVessel = true;
  mesh.name = `vessel-${spec.group}`;
  return mesh;
}

function createOvoidGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, 48, 36);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.x *= 1.05;
    v.y *= 1.22;
    v.z *= 1.0;
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
  ovoid.position.set(0.05, -0.2, 0.02);
  ovoid.rotation.z = THREE.MathUtils.degToRad(-8);
  ovoid.rotation.x = THREE.MathUtils.degToRad(10);
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
  root.add(vessels);

  const ostiumMat = new THREE.MeshStandardMaterial({
    color: 0xd8dde2,
    roughness: 0.4,
  });
  const leftOstium = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), ostiumMat);
  leftOstium.position.set(0.1, 0.62, 0.12);
  leftOstium.userData.vesselGroup = "lm";
  leftOstium.userData.vesselName = "Left coronary ostium";
  leftOstium.userData.vesselDetail = "Origin of left coronary artery";
  leftOstium.userData.isVessel = true;
  const rightOstium = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 12, 10),
    ostiumMat.clone(),
  );
  rightOstium.position.set(-0.08, 0.58, 0.1);
  rightOstium.userData.vesselGroup = "rca";
  rightOstium.userData.vesselName = "Right coronary ostium";
  rightOstium.userData.vesselDetail = "Origin of right coronary artery";
  rightOstium.userData.isVessel = true;
  vessels.add(leftOstium, rightOstium);

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
