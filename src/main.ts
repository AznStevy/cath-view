import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  anglesFromCameraPosition,
  cathCameraPosition,
  formatAngulation,
  formatOblique,
  formatViewLabel,
  VIEW_PRESETS,
  type CathAngles,
} from "./cathAngles";
import {
  createCoronaryAnatomy,
  setVesselGroupVisibility,
  VESSEL_GROUPS,
  type VesselGroup,
} from "./coronaryAnatomy";

type ViewMode = "cath" | "orbit";

const CAMERA_DISTANCE = 4.6;

const state: CathAngles & { mode: ViewMode; syncing: boolean } = {
  primary: 0,
  secondary: 0,
  mode: "cath",
  syncing: false,
};

const vesselVisibility: Record<VesselGroup, boolean> = Object.fromEntries(
  VESSEL_GROUPS.map((g) => [g.id, g.defaultOn]),
) as Record<VesselGroup, boolean>;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function buildUI(root: HTMLElement): {
  canvasHost: HTMLElement;
  els: Record<string, HTMLElement>;
} {
  const vesselToggles = VESSEL_GROUPS.map(
    (g) => `
      <label class="vessel-toggle">
        <input type="checkbox" data-vessel="${g.id}" ${g.defaultOn ? "checked" : ""} />
        <span class="swatch" style="background:${g.color}"></span>
        <span>${g.label}</span>
      </label>`,
  ).join("");

  root.innerHTML = `
    <div id="viewport"></div>
    <div class="hud">
      <header class="brand">
        <h1>Cath View</h1>
      </header>

      <div class="panel-shell" id="panel-shell">
        <aside class="panel" id="panel" aria-label="Controls">
          <div class="panel-top">
            <h2>View</h2>
            <button type="button" class="panel-collapse" id="btn-collapse" title="Hide panel" aria-label="Hide panel">›</button>
          </div>

          <div class="angle-readout">
            <div class="readout">
              <div class="label">Oblique</div>
              <div class="value" id="oblique-readout">AP</div>
            </div>
            <div class="readout">
              <div class="label">Angulation</div>
              <div class="value" id="angulation-readout">0°</div>
            </div>
          </div>

          <div class="mode-toggle">
            <button type="button" id="mode-cath" class="active">Angles</button>
            <button type="button" id="mode-orbit">Orbit</button>
          </div>

          <div class="control-group">
            <div class="oblique-toggle">
              <button type="button" id="btn-rao">RAO</button>
              <button type="button" id="btn-lao" class="active">LAO</button>
            </div>
            <div class="slider-row">
              <label for="oblique-slider"><span id="oblique-label">LAO</span></label>
              <input id="oblique-slider" type="range" min="0" max="90" value="0" step="1" />
              <div class="num-wrap">
                <input id="oblique-input" type="number" min="0" max="90" step="1" value="0" aria-label="Oblique degrees" />
                <span class="unit">°</span>
              </div>
            </div>
          </div>

          <div class="control-group">
            <div class="oblique-toggle">
              <button type="button" id="btn-cranial" class="active">Cranial</button>
              <button type="button" id="btn-caudal">Caudal</button>
            </div>
            <div class="slider-row">
              <label for="angulation-slider"><span id="angulation-label">Cranial</span></label>
              <input id="angulation-slider" type="range" min="0" max="45" value="0" step="1" />
              <div class="num-wrap">
                <input id="angulation-input" type="number" min="0" max="45" step="1" value="0" aria-label="Angulation degrees" />
                <span class="unit">°</span>
              </div>
            </div>
          </div>

          <div class="presets">
            <h3>Presets</h3>
            <div class="preset-grid" id="preset-grid"></div>
          </div>

          <div class="action-row">
            <button type="button" id="btn-ap">AP</button>
            <button type="button" id="btn-heart">Heart</button>
          </div>

          <div class="legend">
            <h3>Vessels</h3>
            <div class="vessel-actions">
              <button type="button" id="btn-vessels-all">All</button>
              <button type="button" id="btn-vessels-none">None</button>
            </div>
            <div class="vessel-toggles" id="vessel-toggles">
              ${vesselToggles}
            </div>
          </div>
        </aside>
        <button type="button" class="panel-expand" id="btn-expand" title="Show panel" aria-label="Show panel">Panel</button>
      </div>

      <div id="vessel-tooltip" class="vessel-tooltip" hidden>
        <div class="vessel-tooltip-name"></div>
        <div class="vessel-tooltip-detail"></div>
      </div>
    </div>
  `;

  const canvasHost = root.querySelector("#viewport") as HTMLElement;
  const presetGrid = root.querySelector("#preset-grid") as HTMLElement;
  for (const preset of VIEW_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `${preset.name}<small>${formatViewLabel(preset)}</small>`;
    btn.dataset.primary = String(preset.primary);
    btn.dataset.secondary = String(preset.secondary);
    presetGrid.appendChild(btn);
  }

  const ids = [
    "oblique-readout",
    "angulation-readout",
    "mode-cath",
    "mode-orbit",
    "btn-rao",
    "btn-lao",
    "oblique-label",
    "oblique-slider",
    "oblique-input",
    "btn-cranial",
    "btn-caudal",
    "angulation-label",
    "angulation-slider",
    "angulation-input",
    "preset-grid",
    "btn-ap",
    "btn-heart",
    "btn-vessels-all",
    "btn-vessels-none",
    "vessel-toggles",
    "panel-shell",
    "btn-collapse",
    "btn-expand",
    "vessel-tooltip",
  ] as const;

  const els: Record<string, HTMLElement> = {};
  for (const id of ids) {
    els[id] = root.querySelector(`#${id}`) as HTMLElement;
  }

  return { canvasHost, els };
}

function main() {
  const app = document.querySelector("#app");
  if (!app) throw new Error("#app missing");

  const { canvasHost, els } = buildUI(app as HTMLElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1218);
  scene.fog = new THREE.FogExp2(0x0a1218, 0.04);

  const bgGeo = new THREE.SphereGeometry(40, 32, 16);
  const bgMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      colorCenter: { value: new THREE.Color(0x12202a) },
      colorEdge: { value: new THREE.Color(0x070c10) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 colorCenter;
      uniform vec3 colorEdge;
      varying vec3 vPos;
      void main() {
        vec3 n = normalize(vPos);
        float h = n.y * 0.5 + 0.5;
        float glow = pow(max(0.0, 1.0 - length(n.xz)), 2.2) * 0.2;
        vec3 col = mix(colorEdge, colorCenter, h);
        col += vec3(0.08, 0.18, 0.22) * glow;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  scene.add(new THREE.Mesh(bgGeo, bgMat));

  const camera = new THREE.PerspectiveCamera(
    42,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  );
  camera.up.set(0, 1, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  canvasHost.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2.4;
  controls.maxDistance = 10;
  controls.target.set(0, -0.15, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const key = new THREE.DirectionalLight(0xfff0e8, 1.0);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88c8e0, 0.4);
  fill.position.set(-3, 1, -2);
  scene.add(fill);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2.6, 64),
    new THREE.MeshStandardMaterial({
      color: 0x152028,
      roughness: 0.9,
      metalness: 0.1,
      transparent: true,
      opacity: 0.55,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.55;
  scene.add(ground);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.55, 2.62, 64),
    new THREE.MeshBasicMaterial({
      color: 0x3db8c8,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -1.54;
  scene.add(ring);

  const anatomy = createCoronaryAnatomy();
  scene.add(anatomy);
  const heartShell = anatomy.getObjectByName("heartShell")!;
  const vessels = anatomy.getObjectByName("vessels");

  function applyVesselVisibility() {
    for (const g of VESSEL_GROUPS) {
      setVesselGroupVisibility(anatomy, g.id, vesselVisibility[g.id]);
    }
  }
  applyVesselVisibility();

  function applyCathCamera(animate = false) {
    const target = cathCameraPosition(state, CAMERA_DISTANCE);
    const look = new THREE.Vector3(0, -0.15, 0);
    if (!animate) {
      camera.position.copy(target);
      camera.lookAt(look);
      controls.target.copy(look);
      controls.update();
      return;
    }
    const start = camera.position.clone();
    const startTarget = controls.target.clone();
    let t = 0;
    const duration = 0.4;
    const tick = () => {
      t += 1 / 60;
      const k = Math.min(1, t / duration);
      const e = 1 - Math.pow(1 - k, 3);
      camera.position.lerpVectors(start, target, e);
      controls.target.lerpVectors(startTarget, look, e);
      camera.lookAt(controls.target);
      if (k < 1) requestAnimationFrame(tick);
      else controls.update();
    };
    requestAnimationFrame(tick);
  }

  function syncUIFromState() {
    state.syncing = true;
    const laoMag = Math.abs(state.primary);
    const cranMag = Math.abs(state.secondary);
    const isLao = state.primary >= 0;
    const isCranial = state.secondary >= 0;

    (els["oblique-slider"] as HTMLInputElement).value = String(Math.round(laoMag));
    (els["oblique-input"] as HTMLInputElement).value = String(Math.round(laoMag));
    (els["angulation-slider"] as HTMLInputElement).value = String(Math.round(cranMag));
    (els["angulation-input"] as HTMLInputElement).value = String(Math.round(cranMag));

    els["oblique-label"].textContent = isLao ? "LAO" : "RAO";
    els["angulation-label"].textContent = isCranial ? "Cranial" : "Caudal";
    els["oblique-readout"].textContent = formatOblique(state.primary);
    els["angulation-readout"].textContent = formatAngulation(state.secondary);

    els["btn-lao"].classList.toggle("active", isLao);
    els["btn-rao"].classList.toggle("active", !isLao);
    els["btn-cranial"].classList.toggle("active", isCranial);
    els["btn-caudal"].classList.toggle("active", !isCranial);
    els["mode-cath"].classList.toggle("active", state.mode === "cath");
    els["mode-orbit"].classList.toggle("active", state.mode === "orbit");
    state.syncing = false;
  }

  function setAngles(primary: number, secondary: number, animate = true) {
    state.primary = clamp(primary, -90, 90);
    state.secondary = clamp(secondary, -45, 45);
    syncUIFromState();
    if (state.mode === "cath") applyCathCamera(animate);
  }

  function setMode(mode: ViewMode) {
    state.mode = mode;
    syncUIFromState();
    if (mode === "cath") applyCathCamera(true);
  }

  applyCathCamera(false);
  syncUIFromState();

  els["btn-lao"].addEventListener("click", () => {
    setAngles(Math.abs(state.primary), state.secondary);
  });
  els["btn-rao"].addEventListener("click", () => {
    setAngles(-Math.abs(state.primary) || -1, state.secondary);
  });
  els["btn-cranial"].addEventListener("click", () => {
    setAngles(state.primary, Math.abs(state.secondary));
  });
  els["btn-caudal"].addEventListener("click", () => {
    setAngles(state.primary, -Math.abs(state.secondary) || -1);
  });

  const setObliqueMag = (mag: number) => {
    const sign = state.primary >= 0 ? 1 : -1;
    setMode("cath");
    setAngles(sign * clamp(mag, 0, 90), state.secondary, false);
  };

  const setAngulationMag = (mag: number) => {
    const sign = state.secondary >= 0 ? 1 : -1;
    setMode("cath");
    setAngles(state.primary, sign * clamp(mag, 0, 45), false);
  };

  els["oblique-slider"].addEventListener("input", () => {
    if (state.syncing) return;
    setObliqueMag(Number((els["oblique-slider"] as HTMLInputElement).value));
  });
  els["oblique-input"].addEventListener("input", () => {
    if (state.syncing) return;
    const raw = (els["oblique-input"] as HTMLInputElement).value;
    if (raw === "" || raw === "-") return;
    setObliqueMag(Number(raw));
  });
  els["oblique-input"].addEventListener("change", () => {
    if (state.syncing) return;
    setObliqueMag(Number((els["oblique-input"] as HTMLInputElement).value) || 0);
  });

  els["angulation-slider"].addEventListener("input", () => {
    if (state.syncing) return;
    setAngulationMag(Number((els["angulation-slider"] as HTMLInputElement).value));
  });
  els["angulation-input"].addEventListener("input", () => {
    if (state.syncing) return;
    const raw = (els["angulation-input"] as HTMLInputElement).value;
    if (raw === "" || raw === "-") return;
    setAngulationMag(Number(raw));
  });
  els["angulation-input"].addEventListener("change", () => {
    if (state.syncing) return;
    setAngulationMag(Number((els["angulation-input"] as HTMLInputElement).value) || 0);
  });

  els["mode-cath"].addEventListener("click", () => setMode("cath"));
  els["mode-orbit"].addEventListener("click", () => setMode("orbit"));

  els["btn-ap"].addEventListener("click", () => {
    setMode("cath");
    setAngles(0, 0, true);
  });

  let heartVisible = true;
  els["btn-heart"].addEventListener("click", () => {
    heartVisible = !heartVisible;
    heartShell.visible = heartVisible;
  });

  els["preset-grid"].addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn || !btn.dataset.primary) return;
    setMode("cath");
    setAngles(Number(btn.dataset.primary), Number(btn.dataset.secondary), true);
  });

  function syncVesselCheckboxes() {
    els["vessel-toggles"].querySelectorAll<HTMLInputElement>("input[data-vessel]").forEach((input) => {
      const id = input.dataset.vessel as VesselGroup;
      input.checked = vesselVisibility[id];
    });
  }

  els["vessel-toggles"].addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.vessel) return;
    const id = input.dataset.vessel as VesselGroup;
    vesselVisibility[id] = input.checked;
    setVesselGroupVisibility(anatomy, id, input.checked);
  });

  els["btn-vessels-all"].addEventListener("click", () => {
    for (const g of VESSEL_GROUPS) vesselVisibility[g.id] = true;
    applyVesselVisibility();
    syncVesselCheckboxes();
  });

  els["btn-vessels-none"].addEventListener("click", () => {
    for (const g of VESSEL_GROUPS) vesselVisibility[g.id] = false;
    applyVesselVisibility();
    syncVesselCheckboxes();
  });

  const panelShell = els["panel-shell"];
  els["btn-collapse"].addEventListener("click", () => panelShell.classList.add("collapsed"));
  els["btn-expand"].addEventListener("click", () => panelShell.classList.remove("collapsed"));

  const tooltip = els["vessel-tooltip"];
  const tipName = tooltip.querySelector(".vessel-tooltip-name") as HTMLElement;
  const tipDetail = tooltip.querySelector(".vessel-tooltip-detail") as HTMLElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hoverMesh: THREE.Mesh | null = null;
  let hoverTimer: number | null = null;
  let pointerClient = { x: 0, y: 0 };
  let isDragging = false;
  let hoverEmissive = 0.08;

  function clearHover() {
    if (hoverTimer !== null) {
      window.clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    tooltip.hidden = true;
    if (hoverMesh?.material instanceof THREE.MeshStandardMaterial) {
      hoverMesh.material.emissiveIntensity = hoverEmissive;
    }
    hoverMesh = null;
  }

  function showTooltip(mesh: THREE.Mesh) {
    tipName.textContent = String(mesh.userData.vesselName ?? "Vessel");
    tipDetail.textContent = String(mesh.userData.vesselDetail ?? "");
    tooltip.hidden = false;
    positionTooltip();
  }

  function positionTooltip() {
    const pad = 12;
    const tw = tooltip.offsetWidth || 160;
    const th = tooltip.offsetHeight || 40;
    let x = pointerClient.x + pad;
    let y = pointerClient.y + pad;
    if (x + tw > window.innerWidth - 8) x = pointerClient.x - tw - pad;
    if (y + th > window.innerHeight - 8) y = pointerClient.y - th - pad;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }

  function pickVessel(clientX: number, clientY: number): THREE.Mesh | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const targets: THREE.Object3D[] = [];
    vessels?.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.visible && obj.userData.isVessel) {
        targets.push(obj);
      }
    });
    const hits = raycaster.intersectObjects(targets, false);
    return hits.length ? (hits[0].object as THREE.Mesh) : null;
  }

  renderer.domElement.addEventListener("pointermove", (e) => {
    pointerClient = { x: e.clientX, y: e.clientY };
    if (isDragging) {
      clearHover();
      return;
    }
    if (!tooltip.hidden) positionTooltip();

    const hit = pickVessel(e.clientX, e.clientY);
    if (hit === hoverMesh) return;

    if (hoverTimer !== null) {
      window.clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    tooltip.hidden = true;

    if (hoverMesh?.material instanceof THREE.MeshStandardMaterial) {
      hoverMesh.material.emissiveIntensity = hoverEmissive;
    }
    hoverMesh = hit;

    if (!hit) return;

    if (hit.material instanceof THREE.MeshStandardMaterial) {
      hit.material.emissiveIntensity = 0.35;
    }
    hoverTimer = window.setTimeout(() => {
      if (hoverMesh === hit) showTooltip(hit);
    }, 1000);
  });

  renderer.domElement.addEventListener("pointerleave", () => clearHover());

  controls.addEventListener("start", () => {
    isDragging = true;
    clearHover();
    if (state.mode === "cath") setMode("orbit");
  });
  controls.addEventListener("end", () => {
    isDragging = false;
  });
  controls.addEventListener("change", () => {
    if (state.mode !== "orbit" || state.syncing) return;
    const inferred = anglesFromCameraPosition(camera.position);
    state.primary = inferred.primary;
    state.secondary = clamp(inferred.secondary, -45, 45);
    syncUIFromState();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "r" || e.key === "R") {
      setMode("cath");
      setAngles(0, 0, true);
    }
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}

main();
