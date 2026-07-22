import * as THREE from "three";

/** Patient frame: +X = left, +Y = superior, +Z = anterior */
export type CathAngles = {
  /** Positive = LAO, negative = RAO (degrees) */
  primary: number;
  /** Positive = cranial, negative = caudal (degrees) */
  secondary: number;
};

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

export function cathCameraPosition(
  angles: CathAngles,
  distance: number,
): THREE.Vector3 {
  const lao = THREE.MathUtils.degToRad(angles.primary);
  const cran = THREE.MathUtils.degToRad(angles.secondary);
  const cosC = Math.cos(cran);
  return new THREE.Vector3(
    distance * Math.sin(lao) * cosC,
    distance * Math.sin(cran),
    distance * Math.cos(lao) * cosC,
  );
}

export function anglesFromCameraPosition(pos: THREE.Vector3): CathAngles {
  const r = pos.length();
  if (r < 1e-6) return { primary: 0, secondary: 0 };
  const secondary = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(pos.y / r, -1, 1)));
  const cosC = Math.cos(THREE.MathUtils.degToRad(secondary));
  let primary = 0;
  if (Math.abs(cosC) > 1e-4) {
    primary = THREE.MathUtils.radToDeg(Math.atan2(pos.x / cosC, pos.z / cosC));
  }
  return { primary, secondary };
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
