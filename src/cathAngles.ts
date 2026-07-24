import * as THREE from "three";

/** Patient frame: +X = left, +Y = superior, +Z = anterior */
export type CathAngles = {
  /** Positive = LAO, negative = RAO (degrees) */
  primary: number;
  /** Positive = cranial, negative = caudal (degrees) */
  secondary: number;
};

/** C-arm isocenter — camera sphere and look-at share this point */
export const ISOCENTER = new THREE.Vector3(0, -0.15, 0);

export function formatOblique(primary: number): string {
  if (Math.abs(primary) < 0.5) return "AP";
  return primary >= 0 ? `LAO ${Math.round(primary)}°` : `RAO ${Math.round(-primary)}°`;
}

export function formatAngulation(secondary: number): string {
  if (Math.abs(secondary) < 0.5) return "0°";
  return secondary >= 0
    ? `cranial ${Math.round(secondary)}°`
    : `caudal ${Math.round(-secondary)}°`;
}

export function formatViewLabel(angles: CathAngles): string {
  const o = formatOblique(angles.primary);
  const a = formatAngulation(angles.secondary);
  if (o === "AP" && a === "0°") return "AP";
  if (a === "0°") return o;
  if (o === "AP") return a;
  return `${o} / ${a}`;
}

/** Unit camera direction from isocenter for cath angles (detector / viewing side). */
export function cathDirection(angles: CathAngles): THREE.Vector3 {
  const lao = THREE.MathUtils.degToRad(angles.primary);
  const cran = THREE.MathUtils.degToRad(angles.secondary);
  const cosC = Math.cos(cran);
  return new THREE.Vector3(
    Math.sin(lao) * cosC,
    Math.sin(cran),
    Math.cos(lao) * cosC,
  ).normalize();
}

/** Camera world position for cath angles (detector / viewing side). */
export function cathCameraPosition(
  angles: CathAngles,
  distance: number,
  isocenter: THREE.Vector3 = ISOCENTER,
): THREE.Vector3 {
  return cathDirection(angles).multiplyScalar(distance).add(isocenter);
}

/** Infer cath angles from camera position relative to isocenter. */
export function anglesFromCameraPosition(
  pos: THREE.Vector3,
  isocenter: THREE.Vector3 = ISOCENTER,
): CathAngles {
  const offset = pos.clone().sub(isocenter);
  const r = offset.length();
  if (r < 1e-6) return { primary: 0, secondary: 0 };
  const secondary = THREE.MathUtils.radToDeg(
    Math.asin(THREE.MathUtils.clamp(offset.y / r, -1, 1)),
  );
  const cosC = Math.cos(THREE.MathUtils.degToRad(secondary));
  let primary = 0;
  if (Math.abs(cosC) > 1e-4) {
    primary = THREE.MathUtils.radToDeg(Math.atan2(offset.x / cosC, offset.z / cosC));
  }
  return { primary, secondary };
}

type OrientationLandmark = {
  appGeo: CathAngles;
  real: CathAngles;
  weight: number;
  note: string;
};

/**
 * Prior two-landmark orientation that was live when the RAO 6/CRA 10 point
 * was measured — used only to map that reading back to unrotated camera space.
 */
const PRIOR_ORIENTATION_LANDMARKS: { appGeo: CathAngles; real: CathAngles }[] = [
  { appGeo: { primary: -5, secondary: -29 }, real: { primary: 5, secondary: -27 } },
  { appGeo: { primary: -15, secondary: 3 }, real: { primary: -17, secondary: 30 } },
];

function priorOrientationQuaternion(): THREE.Quaternion {
  const primary = PRIOR_ORIENTATION_LANDMARKS[1]!;
  const q1 = new THREE.Quaternion().setFromUnitVectors(
    cathDirection(primary.appGeo),
    cathDirection(primary.real),
  );
  const secondary = PRIOR_ORIENTATION_LANDMARKS[0]!;
  const from2 = cathDirection(secondary.appGeo).applyQuaternion(q1);
  const to2 = cathDirection(secondary.real);
  const axis = cathDirection(primary.real);
  const fromFlat = from2.sub(axis.clone().multiplyScalar(from2.dot(axis)));
  const toFlat = to2.sub(axis.clone().multiplyScalar(to2.dot(axis)));
  if (fromFlat.lengthSq() < 1e-8 || toFlat.lengthSq() < 1e-8) return q1;
  return new THREE.Quaternion()
    .setFromUnitVectors(fromFlat.normalize(), toFlat.normalize())
    .multiply(q1);
}

function unrotateMeasuredApp(appOnRotated: CathAngles): CathAngles {
  const dir = cathDirection(appOnRotated).applyQuaternion(
    priorOrientationQuaternion().clone().invert(),
  );
  return anglesFromCameraPosition(dir.add(ISOCENTER));
}

/**
 * Landmarks in unrotated geometric camera space.
 * The heart sits obliquely in the chest — fitting may apply large pitch/yaw/roll.
 */
const ORIENTATION_LANDMARKS: OrientationLandmark[] = [
  {
    appGeo: { primary: -10, secondary: -20 },
    real: { primary: 5, secondary: -25 },
    weight: 1,
    note: "app RAO 10/CAU 20 ↔ real LAO 5/CAU 25",
  },
  {
    appGeo: { primary: -5, secondary: -29 },
    real: { primary: 5, secondary: -27 },
    weight: 2,
    note: "app RAO 5/CAU 29 ↔ real LAO 5/CAU 27",
  },
  {
    appGeo: { primary: -15, secondary: 3 },
    real: { primary: -17, secondary: 30 },
    weight: 0.35,
    note: "app RAO 5/CRA 5 (geo RAO 15/CRA 3 under temp UI offset) ↔ real RAO 17/CRA 30",
  },
  {
    appGeo: unrotateMeasuredApp({ primary: -6, secondary: 10 }),
    real: { primary: 6, secondary: -20 },
    weight: 3,
    note: "app RAO 6/CRA 10 ↔ real LAO 6/CAU 20 (converted from prior orientation)",
  },
];

type OrientationFit = {
  quaternion: THREE.Quaternion;
  /** Sagittal reflection (LAO ↔ RAO) before the rotation */
  mirrorX: boolean;
  error: number;
};

function appDir(appGeo: CathAngles, mirrorX: boolean): THREE.Vector3 {
  return cathDirection(
    mirrorX ? { primary: -appGeo.primary, secondary: appGeo.secondary } : appGeo,
  );
}

function orientationError(
  q: THREE.Quaternion,
  mirrorX: boolean,
  landmarks: OrientationLandmark[],
): number {
  let sum = 0;
  const predicted = new THREE.Vector3();
  for (const lm of landmarks) {
    predicted.copy(appDir(lm.appGeo, mirrorX)).applyQuaternion(q);
    const ang = anglesFromCameraPosition(predicted.clone().add(ISOCENTER));
    const e = Math.hypot(ang.primary - lm.real.primary, ang.secondary - lm.real.secondary);
    sum += lm.weight * e * e;
  }
  return sum;
}

/** Wahba / Kabsch: best R with R * appDir ≈ realDir (optionally after mirror). */
function kabschOrientation(
  landmarks: OrientationLandmark[],
  mirrorX: boolean,
): OrientationFit {
  // H = Σ w a bᵀ
  const H = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const lm of landmarks) {
    const a = appDir(lm.appGeo, mirrorX);
    const b = cathDirection(lm.real);
    const w = lm.weight;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        H[i]![j]! += w * a.getComponent(i) * b.getComponent(j);
      }
    }
  }

  const { U, V, det } = svd3(H);
  // R = V Uᵀ ; if reflection, flip last column of V
  if (det < 0) {
    for (let i = 0; i < 3; i++) V[i]![2]! *= -1;
  }

  // R_ij = Σ_k V_ik U_jk  (V Uᵀ)
  const R = [
    [
      V[0]![0]! * U[0]![0]! + V[0]![1]! * U[0]![1]! + V[0]![2]! * U[0]![2]!,
      V[0]![0]! * U[1]![0]! + V[0]![1]! * U[1]![1]! + V[0]![2]! * U[1]![2]!,
      V[0]![0]! * U[2]![0]! + V[0]![1]! * U[2]![1]! + V[0]![2]! * U[2]![2]!,
    ],
    [
      V[1]![0]! * U[0]![0]! + V[1]![1]! * U[0]![1]! + V[1]![2]! * U[0]![2]!,
      V[1]![0]! * U[1]![0]! + V[1]![1]! * U[1]![1]! + V[1]![2]! * U[1]![2]!,
      V[1]![0]! * U[2]![0]! + V[1]![1]! * U[2]![1]! + V[1]![2]! * U[2]![2]!,
    ],
    [
      V[2]![0]! * U[0]![0]! + V[2]![1]! * U[0]![1]! + V[2]![2]! * U[0]![2]!,
      V[2]![0]! * U[1]![0]! + V[2]![1]! * U[1]![1]! + V[2]![2]! * U[1]![2]!,
      V[2]![0]! * U[2]![0]! + V[2]![1]! * U[2]![1]! + V[2]![2]! * U[2]![2]!,
    ],
  ];

  const mat = new THREE.Matrix4().set(
    R[0]![0]!,
    R[0]![1]!,
    R[0]![2]!,
    0,
    R[1]![0]!,
    R[1]![1]!,
    R[1]![2]!,
    0,
    R[2]![0]!,
    R[2]![1]!,
    R[2]![2]!,
    0,
    0,
    0,
    0,
    1,
  );
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(mat);
  return {
    quaternion,
    mirrorX,
    error: orientationError(quaternion, mirrorX, landmarks),
  };
}

/** Compact 3×3 SVD via Jacobi eigen-decomposition of HᵀH / HHᵀ. */
function svd3(H: number[][]): { U: number[][]; V: number[][]; det: number } {
  const HtH = matMul(transpose(H), H);
  const HHt = matMul(H, transpose(H));
  const { vectors: V, values } = jacobiEigen(HtH);
  const U = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  // U = H V S⁺ ; for rotation Kabsch we mainly need U,V as orthogonal
  const { vectors: Uraw } = jacobiEigen(HHt);
  // Align U columns so H v_i ≈ σ u_i (same orientation)
  for (let i = 0; i < 3; i++) {
    const v = [V[0]![i]!, V[1]![i]!, V[2]![i]!];
    const Hv = [
      H[0]![0]! * v[0]! + H[0]![1]! * v[1]! + H[0]![2]! * v[2]!,
      H[1]![0]! * v[0]! + H[1]![1]! * v[1]! + H[1]![2]! * v[2]!,
      H[2]![0]! * v[0]! + H[2]![1]! * v[1]! + H[2]![2]! * v[2]!,
    ];
    let best = 0;
    let bestDot = -Infinity;
    for (let j = 0; j < 3; j++) {
      const u = [Uraw[0]![j]!, Uraw[1]![j]!, Uraw[2]![j]!];
      const dot = Hv[0]! * u[0]! + Hv[1]! * u[1]! + Hv[2]! * u[2]!;
      if (Math.abs(dot) > Math.abs(bestDot)) {
        bestDot = dot;
        best = j;
      }
    }
    const sign = bestDot < 0 ? -1 : 1;
    U[0]![i] = sign * Uraw[0]![best]!;
    U[1]![i] = sign * Uraw[1]![best]!;
    U[2]![i] = sign * Uraw[2]![best]!;
  }
  void values;
  return { U, V, det: det3(matMul(V, transpose(U))) };
}

function transpose(A: number[][]): number[][] {
  return [
    [A[0]![0]!, A[1]![0]!, A[2]![0]!],
    [A[0]![1]!, A[1]![1]!, A[2]![1]!],
    [A[0]![2]!, A[1]![2]!, A[2]![2]!],
  ];
}

function matMul(A: number[][], B: number[][]): number[][] {
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      C[i]![j] = A[i]![0]! * B[0]![j]! + A[i]![1]! * B[1]![j]! + A[i]![2]! * B[2]![j]!;
    }
  }
  return C;
}

function det3(A: number[][]): number {
  return (
    A[0]![0]! * (A[1]![1]! * A[2]![2]! - A[1]![2]! * A[2]![1]!) -
    A[0]![1]! * (A[1]![0]! * A[2]![2]! - A[1]![2]! * A[2]![0]!) +
    A[0]![2]! * (A[1]![0]! * A[2]![1]! - A[1]![1]! * A[2]![0]!)
  );
}

function jacobiEigen(Ain: number[][]): { values: number[]; vectors: number[][] } {
  const A = Ain.map((row) => row.slice());
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 32; iter++) {
    let p = 0;
    let q = 1;
    let max = Math.abs(A[0]![1]!);
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const v = Math.abs(A[i]![j]!);
        if (v > max) {
          max = v;
          p = i;
          q = j;
        }
      }
    }
    if (max < 1e-12) break;
    const app = A[p]![p]!;
    const aqq = A[q]![q]!;
    const apq = A[p]![q]!;
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let k = 0; k < 3; k++) {
      const aik = A[k]![p]!;
      const aiq = A[k]![q]!;
      A[k]![p] = c * aik - s * aiq;
      A[k]![q] = s * aik + c * aiq;
    }
    for (let k = 0; k < 3; k++) {
      const aki = A[p]![k]!;
      const akq = A[q]![k]!;
      A[p]![k] = c * aki - s * akq;
      A[q]![k] = s * aki + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const vip = V[k]![p]!;
      const viq = V[k]![q]!;
      V[k]![p] = c * vip - s * viq;
      V[k]![q] = s * vip + c * viq;
    }
  }
  return { values: [A[0]![0]!, A[1]![1]!, A[2]![2]!], vectors: V };
}

/**
 * Coarse-to-fine Euler search over the full sphere so large in-chest
 * pitch / yaw / roll (non-upright heart) can be found.
 */
function eulerOrientationSearch(landmarks: OrientationLandmark[]): OrientationFit {
  let best: OrientationFit = {
    quaternion: new THREE.Quaternion(),
    mirrorX: false,
    error: Infinity,
  };
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const q = new THREE.Quaternion();

  const run = (mirrorX: boolean, yawStep: number, pitchStep: number, rollStep: number, center?: THREE.Euler) => {
    const y0 = center ? THREE.MathUtils.radToDeg(center.y) : 0;
    const x0 = center ? THREE.MathUtils.radToDeg(center.x) : 0;
    const z0 = center ? THREE.MathUtils.radToDeg(center.z) : 0;
    const ySpan = center ? yawStep * 3 : 180;
    const xSpan = center ? pitchStep * 3 : 90;
    const zSpan = center ? rollStep * 3 : 180;

    for (let yaw = y0 - ySpan; yaw <= y0 + ySpan + 1e-6; yaw += yawStep) {
      for (let pitch = x0 - xSpan; pitch <= x0 + xSpan + 1e-6; pitch += pitchStep) {
        for (let roll = z0 - zSpan; roll <= z0 + zSpan + 1e-6; roll += rollStep) {
          euler.set(
            THREE.MathUtils.degToRad(pitch),
            THREE.MathUtils.degToRad(yaw),
            THREE.MathUtils.degToRad(roll),
            "YXZ",
          );
          q.setFromEuler(euler);
          const error = orientationError(q, mirrorX, landmarks);
          if (error < best.error) {
            best = { quaternion: q.clone(), mirrorX, error };
          }
        }
      }
    }
  };

  for (const mirrorX of [false, true]) {
    run(mirrorX, 20, 15, 20);
  }
  // Refine around best
  const fine = new THREE.Euler().setFromQuaternion(best.quaternion, "YXZ");
  run(best.mirrorX, 5, 5, 5, fine);
  const finer = new THREE.Euler().setFromQuaternion(best.quaternion, "YXZ");
  run(best.mirrorX, 1, 1, 1, finer);

  return best;
}

function fitOrientation(landmarks: OrientationLandmark[]): OrientationFit {
  const candidates: OrientationFit[] = [
    eulerOrientationSearch(landmarks),
    kabschOrientation(landmarks, false),
    kabschOrientation(landmarks, true),
  ];
  let best = candidates[0]!;
  for (const c of candidates) {
    if (c.error < best.error) best = c;
  }
  return best;
}

let cachedFit: OrientationFit | null = null;

function orientationFit(): OrientationFit {
  if (!cachedFit) cachedFit = fitOrientation(ORIENTATION_LANDMARKS);
  return cachedFit;
}

export function modelOrientationQuaternion(): THREE.Quaternion {
  return orientationFit().quaternion.clone();
}

/**
 * Rotate the entire coronary model about the isocenter into the clinical frame.
 * May include large pitch/yaw/roll (heart is not upright in the chest) and an
 * optional sagittal mirror when landmarks imply RAO↔LAO reflection.
 */
export function applyModelOrientation(anatomy: THREE.Object3D): void {
  const fit = orientationFit();
  anatomy.scale.set(fit.mirrorX ? -1 : 1, 1, 1);
  anatomy.quaternion.copy(fit.quaternion);
  // world = R * M * (p - c) + c
  const Mc = ISOCENTER.clone();
  if (fit.mirrorX) Mc.x *= -1;
  anatomy.position.copy(ISOCENTER).sub(Mc.applyQuaternion(fit.quaternion));
}

export const VIEW_PRESETS: { name: string; primary: number; secondary: number }[] = [
  { name: "AP", primary: 0, secondary: 0 },
  { name: "RAO caudal", primary: -30, secondary: -30 },
  { name: "RAO cranial", primary: -30, secondary: 30 },
  { name: "LAO caudal", primary: 40, secondary: -30 },
  { name: "LAO cranial", primary: 40, secondary: 30 },
  { name: "Lateral", primary: 90, secondary: 0 },
  { name: "Spider", primary: 50, secondary: -30 },
  { name: "LAO cranial (LAD)", primary: 30, secondary: 25 },
];
