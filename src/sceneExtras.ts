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

/** Small schematic of the table, patient, and C-arm. */
export function createCarmWindow(canvas: HTMLCanvasElement): {
  resize: () => void;
  render: (angles: CathAngles) => void;
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

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const key = new THREE.DirectionalLight(0xfff4ea, 1.1);
  key.position.set(2, 4, 3);
  scene.add(key);

  const floor = new THREE.GridHelper(7, 14, 0x314552, 0x1b2a34);
  floor.position.y = -0.55;
  scene.add(floor);

  const table = new THREE.Mesh(
    new THREE.BoxGeometry(0.78, 0.07, 2.7),
    new THREE.MeshStandardMaterial({ color: 0x24343e, roughness: 0.65 }),
  );
  table.position.y = 0.04;
  scene.add(table);

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
  spin.position.copy(heart);
  scene.add(spin);

  // Sagittal C: detector above the chest, tube under the table, arc toward
  // the head so the opening faces the feet. LAO spins around the long axis;
  // cranial tilts the detector toward the head.
  const armRadius = 0.95;
  const arcCurve = new THREE.EllipseCurve(0, 0, 1.2, armRadius, -Math.PI / 2, Math.PI / 2, false, 0);
  const arcPts = arcCurve.getPoints(40).map((p) => new THREE.Vector3(0, p.y, p.x));
  const armMat = new THREE.MeshStandardMaterial({
    color: 0x8e9aa4,
    roughness: 0.38,
    metalness: 0.42,
  });
  const arc = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arcPts), 32, 0.055, 8, false),
    armMat,
  );
  const detector = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.045, 0.3),
    new THREE.MeshStandardMaterial({
      color: 0x73828c,
      roughness: 0.42,
      metalness: 0.28,
    }),
  );
  detector.position.set(0, armRadius, 0);
  const source = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.13, 0.26, 12),
    new THREE.MeshStandardMaterial({ color: 0x5e6c76, metalness: 0.45, roughness: 0.42 }),
  );
  source.position.set(0, -armRadius + 0.02, 0);
  const beamSpan = armRadius * 2 - 0.28;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.045, beamSpan, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x9ec9d2,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  beam.position.y = 0;
  beam.name = "carmBeam";
  tilt.add(arc, detector, source, beam);

  return {
    resize() {
      const w = canvas.clientWidth || 260;
      const h = canvas.clientHeight || 150;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    },
    render(angles) {
      spin.rotation.z = THREE.MathUtils.degToRad(-angles.primary);
      tilt.rotation.x = THREE.MathUtils.degToRad(angles.secondary);
      renderer.render(scene, camera);
    },
    orbit(dx: number, dy: number) {
      yaw -= dx * 0.01;
      pitch = Math.min(1.15, Math.max(-0.35, pitch - dy * 0.008));
      placeCamera();
    },
  };
}
