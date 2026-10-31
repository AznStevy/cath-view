import * as THREE from "three";
import { ISOCENTER, type CathAngles } from "./cathAngles";

const _dir = new THREE.Vector3();

function faceTexture(letter: string, accent = false): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#101a22";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = accent ? "#3db8c8" : "rgba(94, 160, 180, 0.85)";
  g.lineWidth = 8;
  g.strokeRect(6, 6, 116, 116);
  g.fillStyle = accent ? "#3db8c8" : "#e6eaed";
  g.font = "700 64px Outfit, Segoe UI, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(letter, 64, 70);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Patient-axis cube. +X left, +Y head, +Z anterior. */
export function createOrientationBox(canvas: HTMLCanvasElement): {
  resize: () => void;
  render: (mainCamera: THREE.Camera) => void;
} {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const viewSize = 1.15;
  const camera = new THREE.OrthographicCamera(-viewSize, viewSize, viewSize, -viewSize, 0.1, 20);
  const materials = [
    faceTexture("L"),
    faceTexture("R"),
    faceTexture("H"),
    faceTexture("F"),
    faceTexture("A", true),
    faceTexture("P"),
  ].map(
    (map) =>
      new THREE.MeshBasicMaterial({
        map,
        transparent: true,
      }),
  );
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materials);
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.14, 0.32, 12),
    new THREE.MeshBasicMaterial({ color: 0x3db8c8 }),
  );
  arrow.position.y = 0.74;
  cube.add(arrow);
  scene.add(cube);

  return {
    resize() {
      const w = canvas.clientWidth || 96;
      const h = canvas.clientHeight || 96;
      renderer.setSize(w, h, false);
      const aspect = w / Math.max(1, h);
      camera.left = -viewSize * aspect;
      camera.right = viewSize * aspect;
      camera.top = viewSize;
      camera.bottom = -viewSize;
      camera.updateProjectionMatrix();
    },
    render(mainCamera) {
      // Clinical axes, not the mesh-fit rotation: AP looks straight at A.
      cube.quaternion.identity();
      cube.scale.set(1, 1, 1);
      _dir.copy(mainCamera.position).sub(ISOCENTER);
      if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
      _dir.normalize().multiplyScalar(4);
      camera.position.copy(_dir);
      camera.up.copy(mainCamera.up);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    },
  };
}

const _inv = new THREE.Matrix4();
const _endA = new THREE.Vector3();
const _endB = new THREE.Vector3();
const _probe = new THREE.Vector3();

/** Rectangular cross-section swept along the sagittal semicircle. */
function carmBandGeometry(radius: number, radial: number, width: number, segments: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const hw = width / 2;
  const hr = radial / 2;
  const rings: { y: number; z: number; sy: number; sz: number }[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / segments;
    const sy = Math.sin(a);
    const sz = Math.cos(a);
    rings.push({ y: sy * radius, z: sz * radius, sy, sz });
  }

  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
  };
  const side = (
    corner: (ring: (typeof rings)[0], end: number) => [number, number, number],
    normal: (ring: (typeof rings)[0]) => [number, number, number],
  ) => {
    const base = positions.length / 3;
    for (const ring of rings) {
      const n = normal(ring);
      for (let end = 0; end < 2; end++) {
        const p = corner(ring, end);
        push(p[0], p[1], p[2], n[0], n[1], n[2]);
      }
    }
    for (let i = 0; i < segments; i++) {
      const k = base + i * 2;
      indices.push(k, k + 1, k + 3, k, k + 3, k + 2);
    }
  };

  // Outer face. Across +X, then along the arc, faces outward.
  side(
    (ring, end) => [end === 0 ? -hw : hw, ring.y + ring.sy * hr, ring.z + ring.sz * hr],
    (ring) => [0, ring.sy, ring.sz],
  );
  side(
    (ring, end) => [end === 0 ? hw : -hw, ring.y - ring.sy * hr, ring.z - ring.sz * hr],
    (ring) => [0, -ring.sy, -ring.sz],
  );
  side(
    (ring, end) => [hw, ring.y + (end === 0 ? ring.sy * hr : -ring.sy * hr), ring.z + (end === 0 ? ring.sz * hr : -ring.sz * hr)],
    () => [1, 0, 0],
  );
  side(
    (ring, end) => [-hw, ring.y + (end === 0 ? -ring.sy * hr : ring.sy * hr), ring.z + (end === 0 ? -ring.sz * hr : ring.sz * hr)],
    () => [-1, 0, 0],
  );

  const cap = (ring: (typeof rings)[0], ny: number, nz: number, flip: boolean) => {
    const base = positions.length / 3;
    const corners: [number, number][] = [
      [-hw, -hr],
      [hw, -hr],
      [hw, hr],
      [-hw, hr],
    ];
    if (flip) corners.reverse();
    for (const [x, rad] of corners) {
      push(x, ring.y + ring.sy * rad, ring.z + ring.sz * rad, 0, ny, nz);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  cap(rings[0], 0, -1, false);
  cap(rings[rings.length - 1], 0, -1, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

function pointHitsBox(point: THREE.Vector3, half: THREE.Vector3, radius: number): boolean {
  const cx = THREE.MathUtils.clamp(point.x, -half.x, half.x);
  const cy = THREE.MathUtils.clamp(point.y, -half.y, half.y);
  const cz = THREE.MathUtils.clamp(point.z, -half.z, half.z);
  const dx = point.x - cx;
  const dy = point.y - cy;
  const dz = point.z - cz;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

/** Distance from an oriented box to a capsule, with the segment already in box space. */
function segmentHitsBox(a: THREE.Vector3, b: THREE.Vector3, half: THREE.Vector3, radius: number): boolean {
  let lo = 0;
  let hi = 1;
  const distSq = (t: number) => {
    _probe.lerpVectors(a, b, t);
    const cx = THREE.MathUtils.clamp(_probe.x, -half.x, half.x);
    const cy = THREE.MathUtils.clamp(_probe.y, -half.y, half.y);
    const cz = THREE.MathUtils.clamp(_probe.z, -half.z, half.z);
    const dx = _probe.x - cx;
    const dy = _probe.y - cy;
    const dz = _probe.z - cz;
    return dx * dx + dy * dy + dz * dz;
  };
  for (let i = 0; i < 18; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const d1 = distSq(m1);
    const d2 = distSq(m2);
    if (d1 < d2) hi = m2;
    else lo = m1;
  }
  return distSq((lo + hi) * 0.5) <= radius * radius;
}

/** Small schematic of the table, patient, and C-arm. */
export function createCarmWindow(canvas: HTMLCanvasElement): {
  resize: () => void;
  step: (angles: CathAngles, dt: number, animate: boolean) => void;
  render: () => boolean;
  orbit: (dx: number, dy: number) => void;
} {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c161e);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
  // Upper chest, toward the head. The torso midpoint reads as the abdomen.
  const heart = new THREE.Vector3(0, 0.34, 0.42);
  const look = heart.clone();
  // Side view: head to the left, so LAO/RAO and cranial/caudal swing the C.
  let yaw = Math.PI / 2;
  let pitch = 0.22;
  const orbitRadius = 4.1;
  const placeCamera = () => {
    const cp = Math.cos(pitch);
    camera.position.set(
      look.x + orbitRadius * Math.sin(yaw) * cp,
      look.y + orbitRadius * Math.sin(pitch),
      look.z + orbitRadius * Math.cos(yaw) * cp,
    );
    camera.lookAt(look);
  };
  placeCamera();

  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const key = new THREE.DirectionalLight(0xfff4ea, 1.15);
  key.position.set(2.4, 4.2, 2.2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc5d4de, 0.45);
  fill.position.set(-3.2, 1.6, -2);
  scene.add(fill);

  const floor = new THREE.GridHelper(7, 14, 0x314552, 0x1b2a34);
  floor.position.y = -0.82;
  scene.add(floor);

  const tableMat = new THREE.MeshStandardMaterial({ color: 0x314854, roughness: 0.42, metalness: 0.18 });
  const table = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.038, 2.18), tableMat);
  table.position.set(0, 0.059, -0.31);
  const pedestalMat = new THREE.MeshStandardMaterial({ color: 0x1a2830, roughness: 0.55, metalness: 0.28 });
  const column = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.86, 0.26), pedestalMat);
  column.position.set(0, -0.39, -1.02);
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.05, 0.46), pedestalMat);
  base.position.set(0, -0.795, -1.02);
  scene.add(table, column, base);

  const skin = new THREE.MeshStandardMaterial({ color: 0xd2b4a2, roughness: 0.72 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.7, 4, 12), skin);
  torso.rotation.x = Math.PI / 2;
  torso.position.set(0, 0.36, 0.02);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), skin);
  head.scale.set(1, 1.05, 1.12);
  head.position.set(0, 0.4, 0.86);
  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.72, 4, 8), skin);
  legs.rotation.x = Math.PI / 2;
  legs.position.set(0, 0.24, -0.98);
  scene.add(torso, head, legs);

  const spin = new THREE.Group();
  const tilt = new THREE.Group();
  spin.add(tilt);
  // One isocenter. LAO/RAO and cranial/caudal are both rotations about axes
  // through this point, and the C, detector, and tube are one rigid circle around it.
  spin.position.copy(heart);
  scene.add(spin);

  // One circular C. The flat panel hangs inside the upper end and the tube
  // hangs inside the lower end, both aimed through the same isocenter.
  const armRadius = 0.92;
  const armRadial = 0.14;
  const armWidth = 0.15;
  const armMat = new THREE.MeshStandardMaterial({
    color: 0xe4ebef,
    roughness: 0.42,
    metalness: 0.18,
  });
  const arc = new THREE.Mesh(carmBandGeometry(armRadius, armRadial, armWidth, 40), armMat);
  const liner = new THREE.Mesh(
    carmBandGeometry(armRadius - armRadial / 2 - 0.016, 0.018, 0.08, 40),
    new THREE.MeshStandardMaterial({ color: 0x1b252c, roughness: 0.62, metalness: 0.15 }),
  );

  const detW = 0.46;
  const detT = 0.085;
  const detD = 0.36;
  const detFace = 0.5;
  const detMat = new THREE.MeshStandardMaterial({
    color: 0xc5ced4,
    roughness: 0.34,
    metalness: 0.42,
    emissive: 0x000000,
  });
  const faceMat = new THREE.MeshStandardMaterial({
    color: 0x10161b,
    roughness: 0.55,
    metalness: 0.08,
    emissive: 0x000000,
  });
  const detector = new THREE.Group();
  detector.position.set(0, detFace + detT / 2, 0);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(detW, detT, detD), detMat);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(detW * 0.82, detD * 0.78), faceMat);
  face.rotation.x = Math.PI / 2;
  face.position.y = -detT / 2 - 0.001;
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 0.16), armMat);
  plate.position.y = detT / 2 + 0.02;
  detector.add(housing, face, plate);
  const detHalf = new THREE.Vector3(detW / 2, detT / 2, detD / 2);

  const neckBottom = detFace + detT + 0.04;
  const neckTop = armRadius - armRadial / 2 + 0.02;
  const neck = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, neckTop - neckBottom, 0.12),
    armMat,
  );
  neck.position.set(0, (neckBottom + neckTop) / 2, 0);

  const tubeMat = new THREE.MeshStandardMaterial({ color: 0xb7c3ca, roughness: 0.4, metalness: 0.28 });
  const tube = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.2, 0.24), tubeMat);
  tube.position.set(0, -(armRadius - armRadial / 2) + 0.08, 0);
  const collimator = new THREE.Mesh(
    new THREE.CylinderGeometry(0.065, 0.09, 0.14, 16),
    new THREE.MeshStandardMaterial({ color: 0x3c4a52, roughness: 0.48, metalness: 0.35 }),
  );
  collimator.position.set(0, tube.position.y + 0.16, 0);
  const port = new THREE.Mesh(
    new THREE.CircleGeometry(0.032, 20),
    new THREE.MeshBasicMaterial({ color: 0x9fd4dc }),
  );
  port.rotation.x = -Math.PI / 2;
  port.position.set(0, collimator.position.y + 0.071, 0);

  const beamNear = collimator.position.y + 0.06;
  const beamFar = detFace;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.03, beamFar - beamNear, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x9ec9d2,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  beam.position.set(0, (beamNear + beamFar) / 2, 0);
  beam.name = "carmBeam";
  tilt.add(arc, liner, neck, detector, tube, collimator, port, beam);

  // Body colliders match the capsule and head meshes above, in world space.
  const torsoA = new THREE.Vector3(0, 0.36, 0.02 - 0.35);
  const torsoB = new THREE.Vector3(0, 0.36, 0.02 + 0.35);
  const headCenter = new THREE.Vector3(0, 0.4, 0.86);
  const legA = new THREE.Vector3(0, 0.24, -0.98 - 0.36);
  const legB = new THREE.Vector3(0, 0.24, -0.98 + 0.36);
  const detectorContactsPatient = () => {
    _inv.copy(detector.matrixWorld).invert();
    _endA.copy(headCenter).applyMatrix4(_inv);
    if (pointHitsBox(_endA, detHalf, 0.19)) return true;
    _endA.copy(torsoA).applyMatrix4(_inv);
    _endB.copy(torsoB).applyMatrix4(_inv);
    if (segmentHitsBox(_endA, _endB, detHalf, 0.26)) return true;
    _endA.copy(legA).applyMatrix4(_inv);
    _endB.copy(legB).applyMatrix4(_inv);
    return segmentHitsBox(_endA, _endB, detHalf, 0.13);
  };

  let posePrimary = 0;
  let poseSecondary = 0;
  let goalPrimary = 0;
  let goalSecondary = 0;
  let easing = false;

  return {
    resize() {
      const w = canvas.clientWidth || 260;
      const h = canvas.clientHeight || 150;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    },
    step(angles, dt, animate) {
      const changed =
        Math.abs(angles.primary - goalPrimary) > 1e-4 || Math.abs(angles.secondary - goalSecondary) > 1e-4;
      if (changed) {
        goalPrimary = angles.primary;
        goalSecondary = angles.secondary;
        easing = animate;
        if (!easing) {
          posePrimary = goalPrimary;
          poseSecondary = goalSecondary;
        }
      }
      if (!easing) return;
      const k = 1 - Math.pow(1 - 0.12, Math.max(1, dt * 60));
      posePrimary += (goalPrimary - posePrimary) * k;
      poseSecondary += (goalSecondary - poseSecondary) * k;
      if (Math.abs(goalPrimary - posePrimary) < 0.08 && Math.abs(goalSecondary - poseSecondary) < 0.08) {
        posePrimary = goalPrimary;
        poseSecondary = goalSecondary;
        easing = false;
      }
    },
    render() {
      spin.rotation.z = THREE.MathUtils.degToRad(-posePrimary);
      tilt.rotation.x = THREE.MathUtils.degToRad(poseSecondary);
      spin.updateMatrixWorld(true);
      const contacting = detectorContactsPatient();
      const glow = contacting ? 0.55 : 0;
      detMat.emissive.setHex(contacting ? 0x9a4034 : 0x000000);
      detMat.emissiveIntensity = glow;
      faceMat.emissive.setHex(contacting ? 0xffc2b8 : 0x000000);
      faceMat.emissiveIntensity = contacting ? 0.35 : 0;
      renderer.render(scene, camera);
      return contacting;
    },
    orbit(dx: number, dy: number) {
      yaw -= dx * 0.01;
      pitch = Math.min(1.15, Math.max(-0.35, pitch - dy * 0.008));
      placeCamera();
    },
  };
}
