import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  anglesFromCameraPosition,
  applyModelOrientation,
  cathCameraPosition,
  formatAngulation,
  formatOblique,
  formatViewLabel,
  ISOCENTER,
  VIEW_PRESETS,
  type CathAngles,
} from "./cathAngles";
import {
  createCoronaryAnatomy,
  setVesselGroupVisibility,
  VESSEL_CATEGORIES,
  VESSEL_GROUPS,
  type VesselGroup,
} from "./coronaryAnatomy";
import { createContrastSim, type InjectionSide } from "./contrastSim";
import { createLesionEditor } from "./lesionEditor";
import {
  createLesionManager,
  lesionLengthMm,
  segmentLabel,
  severityPct,
} from "./lesions";

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
  const vesselToggles = VESSEL_CATEGORIES.map((cat) => {
    const showChildren = cat.groups.length > 1;
    const items = showChildren
      ? cat.groups
          .map((id) => {
            const g = VESSEL_GROUPS.find((x) => x.id === id)!;
            return `
      <label class="vessel-toggle">
        <input type="checkbox" data-vessel="${g.id}" ${g.defaultOn ? "checked" : ""} />
        <span class="swatch" style="background:${g.color}"></span>
        <span>${g.label}</span>
      </label>`;
          })
          .join("")
      : `
      <input type="checkbox" data-vessel="${cat.groups[0]}" ${
          VESSEL_GROUPS.find((x) => x.id === cat.groups[0])?.defaultOn ? "checked" : ""
        } hidden aria-hidden="true" />`;
    return `
      <div class="vessel-category" data-category="${cat.id}">
        <label class="vessel-category-toggle">
          <input type="checkbox" data-category="${cat.id}" checked />
          <span class="swatch" style="background:${cat.color}"></span>
          <span>${cat.label}</span>
        </label>
        ${
          showChildren
            ? `<div class="vessel-category-items">${items}</div>`
            : items
        }
      </div>`;
  }).join("");

  root.innerHTML = `
    <div id="viewport"></div>
    <div class="hud">
      <header class="brand">
        <h1>Cath<span>View</span></h1>
      </header>

      <div class="panel-shell" id="panel-shell">
        <aside class="panel" id="panel" aria-label="Controls">
          <div class="panel-top">
            <h2>View</h2>
            <button type="button" class="panel-collapse" id="btn-collapse" title="Hide panel" aria-label="Hide panel">
              <svg class="collapse-chevron" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.2 4.2 L6 8 L9.8 4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
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
            <button type="button" id="btn-heart">Heart</button>
          </div>

          <div class="sim-panel">
            <h3>Contrast</h3>
            <button type="button" id="btn-simulate" class="btn-simulate">Simulate</button>
            <p class="sim-panel-hint" id="sim-panel-hint">
              Press Simulate, then click LAD, LCx, LM, or RCA on the model.
            </p>
            <h3 class="lesion-heading">Lesions</h3>
            <div class="lesion-actions">
              <button type="button" id="btn-lesion-create" class="btn-lesion">Create lesion</button>
              <button type="button" id="btn-lesion-show" class="btn-lesion-secondary" title="Dim model, keep lesions visible">Show lesions</button>
              <button type="button" id="btn-lesion-download" class="btn-lesion-secondary" title="Download lesions JSON">Download</button>
              <button type="button" id="btn-lesion-load" class="btn-lesion-secondary" title="Load lesions JSON">Load</button>
              <input type="file" id="lesion-file-input" accept="application/json,.json" hidden />
            </div>
            <p class="sim-panel-hint" id="lesion-panel-hint">
              Create a lesion, then click a vessel on the model.
            </p>
            <ul class="lesion-list" id="lesion-list"></ul>
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
        <div class="angle-mini" id="angle-mini" aria-live="polite">
          <div class="angle-mini-row">
            <span class="angle-mini-label">Oblique</span>
            <span class="angle-mini-value" id="oblique-mini">AP</span>
          </div>
          <div class="angle-mini-row">
            <span class="angle-mini-label">Angulation</span>
            <span class="angle-mini-value" id="angulation-mini">0°</span>
          </div>
        </div>
      </div>

      <div class="sim-bar" id="sim-bar" hidden>
        <div class="sim-bar-label">
          <span id="sim-target-label">Click a vessel to inject</span>
          <span id="sim-status">Waiting</span>
        </div>
        <div class="sim-transport-row">
          <button
            type="button"
            id="sim-bar-play"
            class="sim-bar-play"
            aria-label="Pause"
            title="Pause"
          >
            <svg class="icon-pause" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="2" y="1.5" width="2.8" height="9" rx="0.6" fill="currentColor" />
              <rect x="7.2" y="1.5" width="2.8" height="9" rx="0.6" fill="currentColor" />
            </svg>
            <svg class="icon-play" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3.2 1.4 L10.2 6 L3.2 10.6 Z" fill="currentColor" />
            </svg>
          </button>
          <input
            id="sim-seek"
            type="range"
            min="0"
            max="1000"
            value="0"
            step="1"
            aria-label="Seek simulation"
            disabled
          />
        </div>
        <div class="sim-speed-block">
          <div class="sim-speed-caption">
            <span>Speed</span>
            <span id="sim-speed-readout">100%</span>
          </div>
          <input
            id="sim-speed"
            type="range"
            min="0"
            max="200"
            value="100"
            step="1"
            aria-label="Contrast simulation speed"
          />
          <div class="sim-bar-meta">
            <span>Slow</span>
            <span>Fast</span>
          </div>
        </div>
        <div class="sim-bar-actions">
          <button type="button" id="sim-bar-invert" class="sim-bar-invert" aria-pressed="false">Invert</button>
          <button type="button" id="sim-bar-change">Change vessel</button>
          <button type="button" id="sim-bar-stop">Stop</button>
        </div>
      </div>

      <p class="hint">
        Drag to rotate · Scroll to zoom · Arrows adjust angles
        <kbd>R</kbd> reset AP · <kbd>P</kbd> panel · <kbd>S</kbd> simulate
      </p>

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
    "btn-heart",
    "btn-simulate",
    "sim-panel-hint",
    "btn-lesion-create",
    "btn-lesion-show",
    "btn-lesion-download",
    "btn-lesion-load",
    "lesion-file-input",
    "lesion-panel-hint",
    "lesion-list",
    "sim-bar",
    "sim-seek",
    "sim-speed",
    "sim-speed-readout",
    "sim-status",
    "sim-target-label",
    "sim-bar-play",
    "sim-bar-invert",
    "sim-bar-change",
    "sim-bar-stop",
    "btn-vessels-all",
    "btn-vessels-none",
    "vessel-toggles",
    "panel-shell",
    "btn-collapse",
    "btn-expand",
    "oblique-mini",
    "angulation-mini",
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
  controls.target.copy(ISOCENTER);

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
  applyModelOrientation(anatomy);
  scene.add(anatomy);
  const heartShell = anatomy.getObjectByName("heartShell")!;
  const vessels = anatomy.getObjectByName("vessels");
  const contrastSim = createContrastSim(anatomy, [ground, ring]);
  const lesionMgr = createLesionManager(anatomy);
  const lesionEditor = createLesionEditor(app as HTMLElement);
  const viewportEl = document.getElementById("viewport") as HTMLElement;

  function syncLesionFlows() {
    contrastSim.setLesionFlows(lesionMgr.lesionFlows());
  }
  syncLesionFlows();

  function applyVesselVisibility() {
    for (const g of VESSEL_GROUPS) {
      setVesselGroupVisibility(anatomy, g.id, vesselVisibility[g.id]);
    }
  }
  applyVesselVisibility();

  const lookGoal = ISOCENTER.clone();
  const camGoal = cathCameraPosition(state, CAMERA_DISTANCE);
  /** 1 = snap, lower = smoother follow while dragging sliders / holding keys */
  let camLerp = 1;

  function applyCathCamera(animate = false) {
    camGoal.copy(cathCameraPosition(state, CAMERA_DISTANCE));
    lookGoal.copy(ISOCENTER);
    camLerp = animate ? 0.12 : 0.28;
    if (!animate && camera.position.distanceTo(camGoal) > 2.5) {
      camLerp = 1;
    }
  }

  function settleCathCamera(dt: number) {
    const k = 1 - Math.pow(1 - camLerp, Math.max(1, dt * 60));
    camera.position.lerp(camGoal, k);
    controls.target.lerp(lookGoal, k);
    camera.lookAt(controls.target);
    if (camera.position.distanceTo(camGoal) < 1e-3) {
      camera.position.copy(camGoal);
      controls.target.copy(lookGoal);
      camLerp = 1;
    }
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
    els["oblique-mini"].textContent = formatOblique(state.primary);
    els["angulation-mini"].textContent = formatAngulation(state.secondary);

    els["btn-lao"].classList.toggle("active", isLao);
    els["btn-rao"].classList.toggle("active", !isLao);
    els["btn-cranial"].classList.toggle("active", isCranial);
    els["btn-caudal"].classList.toggle("active", !isCranial);
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
    if (mode === "cath") applyCathCamera(true);
  }

  applyCathCamera(false);
  camera.position.copy(camGoal);
  controls.target.copy(lookGoal);
  camera.lookAt(controls.target);
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

  let heartVisible = true;
  els["btn-heart"].addEventListener("click", () => {
    heartVisible = !heartVisible;
    heartShell.visible = heartVisible;
  });

  const simBar = els["sim-bar"];
  const simSeek = els["sim-seek"] as HTMLInputElement;
  const simSpeed = els["sim-speed"] as HTMLInputElement;
  const simReadout = els["sim-speed-readout"];
  const simStatus = els["sim-status"];
  const simTargetLabel = els["sim-target-label"];
  const simPanelHint = els["sim-panel-hint"];
  const btnSimulate = els["btn-simulate"];
  const btnBarPlay = els["sim-bar-play"] as HTMLButtonElement;
  const btnBarInvert = els["sim-bar-invert"] as HTMLButtonElement;
  const btnBarChange = els["sim-bar-change"] as HTMLButtonElement;
  const btnBarStop = els["sim-bar-stop"] as HTMLButtonElement;
  /** Speed to restore when unpausing (slider stays at this while paused). */
  let speedBeforePause = 1;
  let simPaused = false;
  let seekDragging = false;
  let speedDragging = false;
  const btnLesionCreate = els["btn-lesion-create"] as HTMLButtonElement;
  const btnLesionShow = els["btn-lesion-show"] as HTMLButtonElement;
  const btnLesionDownload = els["btn-lesion-download"] as HTMLButtonElement;
  const btnLesionLoad = els["btn-lesion-load"] as HTMLButtonElement;
  const lesionFileInput = els["lesion-file-input"] as HTMLInputElement;
  const lesionPanelHint = els["lesion-panel-hint"];
  const lesionListEl = els["lesion-list"];
  let hoverEmissive = 0.08;
  let fluoroInvert = false;
  let lesionFocus = false;
  type FocusBackup = {
    opacity: number;
    transparent: boolean;
    depthWrite: boolean;
    emissiveIntensity?: number;
  };
  const lesionFocusBackups = new Map<object, FocusBackup>();
  /** Newly placed lesion awaiting editor save; cancel removes it. */
  let pendingNewLesionId: string | null = null;

  function setFluoroInvert(on: boolean) {
    fluoroInvert = on;
    viewportEl.classList.toggle("fluoro-invert", on);
    btnBarInvert.classList.toggle("active", on);
    btnBarInvert.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function applyLesionFocus(on: boolean) {
    // Restore any previous focus pass before applying / clearing
    if (lesionFocusBackups.size) {
      for (const [obj, b] of lesionFocusBackups) {
        if (!(obj instanceof THREE.Material)) continue;
        const mat = obj as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
        if (!("opacity" in mat)) continue;
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
      lesionFocusBackups.clear();
    }

    lesionFocus = on;
    btnLesionShow.classList.toggle("active", on);
    btnLesionShow.setAttribute("aria-pressed", on ? "true" : "false");
    btnLesionShow.textContent = on ? "Showing…" : "Show lesions";
    if (!on) return;

    const dimTargets = [anatomy, ground, ring];
    for (const root of dimTargets) {
      root.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        if (obj.userData.isLesionMesh) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            if (!(m instanceof THREE.MeshStandardMaterial)) continue;
            if (!lesionFocusBackups.has(m)) {
              lesionFocusBackups.set(m, {
                opacity: m.opacity,
                transparent: m.transparent,
                depthWrite: m.depthWrite,
                emissiveIntensity: m.emissiveIntensity,
              });
            }
            m.transparent = true;
            m.opacity = 1;
            m.emissiveIntensity = Math.max(m.emissiveIntensity, 0.55);
            m.depthWrite = true;
            m.needsUpdate = true;
          }
          return;
        }
        if (obj.userData.isDyeOverlay) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (!("opacity" in m)) continue;
          const mat = m as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
          if (!lesionFocusBackups.has(mat)) {
            lesionFocusBackups.set(mat, {
              opacity: mat.opacity,
              transparent: mat.transparent,
              depthWrite: mat.depthWrite,
              emissiveIntensity:
                mat instanceof THREE.MeshStandardMaterial
                  ? mat.emissiveIntensity
                  : undefined,
            });
          }
          mat.transparent = true;
          mat.opacity = 0.06;
          mat.depthWrite = false;
          if (mat instanceof THREE.MeshStandardMaterial) {
            mat.emissiveIntensity = 0.02;
          }
          mat.needsUpdate = true;
        }
      });
    }
  }

  function sideLabel(side: InjectionSide | null): string {
    if (side === "left") return "Left coronary (LM)";
    if (side === "lad") return "LAD";
    if (side === "lcx") return "LCx";
    if (side === "right") return "Right coronary";
    if (side === "both") return "Both coronaries";
    return "Click a vessel on the model";
  }

  function syncLesionList() {
    lesionListEl.innerHTML = "";
    btnLesionCreate.classList.toggle("active", lesionMgr.placing);
    btnLesionCreate.textContent = lesionMgr.placing ? "Click vessel…" : "Create lesion";
    viewportEl.classList.toggle("placing-lesion", lesionMgr.placing);
    lesionPanelHint.textContent = lesionMgr.placing
      ? "Click a vessel on the model to place the lesion."
      : lesionMgr.lesions.length
        ? `${lesionMgr.lesions.length} lesion${lesionMgr.lesions.length === 1 ? "" : "s"} defined.`
        : "Create a lesion, then click a vessel on the model.";

    for (const L of lesionMgr.lesions) {
      const li = document.createElement("li");
      li.className = "lesion-list-item";
      if (L.id === lesionMgr.selectedId) li.classList.add("selected");
      const name = lesionMgr.vesselName(L.vesselId);
      const pct = severityPct(L.severity);
      const seg = segmentLabel(L.t);
      const mm = Math.round(
        lesionLengthMm(L.lengthT, lesionMgr.vesselLengthMm(L.vesselId)),
      );
      li.innerHTML = `
        <button type="button" class="lesion-list-main" data-id="${L.id}">
          <span class="lesion-list-name">${name}</span>
          <span class="lesion-list-meta">${seg} · ${mm} mm · ${pct}%${pct >= 99 ? " · CTO" : ""}</span>
        </button>
        <button type="button" class="lesion-list-edit" data-edit="${L.id}" title="Edit">Edit</button>
        <button type="button" class="lesion-list-del" data-del="${L.id}" title="Delete">×</button>
      `;
      lesionListEl.appendChild(li);
    }
  }

  async function openLesionEditor(id: string, isNew: boolean) {
    const L = lesionMgr.get(id);
    if (!L) return;
    lesionMgr.select(id);
    const result = await lesionEditor.open({
      lesion: L,
      vesselName: lesionMgr.vesselName(L.vesselId),
      vesselLengthMm: lesionMgr.vesselLengthMm(L.vesselId),
      branches: lesionMgr.branchMarks(L),
      title: isNew ? "Define lesion" : "Edit lesion",
    });
    if (!result) {
      if (isNew && pendingNewLesionId === id) {
        lesionMgr.remove(id);
        pendingNewLesionId = null;
      }
      return;
    }
    lesionMgr.update(id, {
      profile: result.profile,
      severity: result.severity,
      lengthT: result.lengthT,
    });
    pendingNewLesionId = null;
    syncLesionFlows();
  }

  function syncSeekUI() {
    const running = contrastSim.active && !!contrastSim.side;
    simSeek.disabled = !running;
    if (!seekDragging) {
      simSeek.value = String(Math.round(contrastSim.progress * 1000));
    }
  }

  function syncSimUI() {
    const pct = Math.round(contrastSim.speed * 100);
    const armed = contrastSim.active && !contrastSim.side;
    const running = contrastSim.active && !!contrastSim.side;
    const paused = simPaused || (running && contrastSim.speed === 0);

    // Never rewrite the speed thumb while the user is dragging it — that was
    // snapping the slider back (especially near 0 / pause).
    if (!speedDragging) {
      if (simPaused) {
        simSpeed.value = String(Math.round(speedBeforePause * 100));
      } else {
        simSpeed.value = String(pct);
      }
    }
    if (paused && !speedDragging) {
      simReadout.textContent = "Paused";
    } else {
      const shown = speedDragging
        ? Math.round(Number(simSpeed.value))
        : simPaused
          ? Math.round(speedBeforePause * 100)
          : pct;
      simReadout.textContent = `${shown}%`;
    }
    simTargetLabel.textContent = sideLabel(contrastSim.side);
    syncSeekUI();

    if (paused) {
      btnBarPlay.classList.add("is-paused");
      btnBarPlay.setAttribute("aria-label", "Play");
      btnBarPlay.title = "Play";
    } else {
      btnBarPlay.classList.remove("is-paused");
      btnBarPlay.setAttribute("aria-label", "Pause");
      btnBarPlay.title = "Pause";
    }
    btnBarPlay.disabled = !running;
    btnBarPlay.hidden = !contrastSim.active;

    if (!contrastSim.active) {
      simStatus.textContent = "Off";
      simPanelHint.textContent =
        "Press Simulate, then click LAD, LCx, LM, or RCA on the model.";
      btnSimulate.textContent = "Simulate";
      btnSimulate.classList.remove("active");
      if (fluoroInvert) setFluoroInvert(false);
      simPaused = false;
    } else if (armed) {
      simStatus.textContent = "Waiting";
      simPanelHint.textContent =
        "Click LAD, LCx, LM, or RCA to inject. Click between the ostia for both.";
      btnSimulate.textContent = "Waiting…";
      btnSimulate.classList.add("active");
    } else if (paused) {
      simStatus.textContent = "Paused";
      simPanelHint.textContent = "Paused. Press play or scrub the timeline.";
      btnSimulate.textContent = "Running";
      btnSimulate.classList.add("active");
    } else {
      simStatus.textContent = "Running";
      simPanelHint.textContent = "Use Change vessel or Stop on the screen bar.";
      btnSimulate.textContent = "Running";
      btnSimulate.classList.add("active");
    }

    btnBarChange.hidden = false;
    btnBarChange.disabled = !running;
    btnBarChange.textContent = "Change vessel";
    btnBarStop.hidden = false;
    btnBarInvert.hidden = false;
    simBar.hidden = !contrastSim.active;
    hoverEmissive = running && !paused ? 0.05 : 0.08;
  }

  function setSimPaused(paused: boolean) {
    if (!contrastSim.active || !contrastSim.side) return;
    if (paused) {
      if (contrastSim.speed > 0) speedBeforePause = contrastSim.speed;
      else if (Number(simSpeed.value) > 0) {
        speedBeforePause = Number(simSpeed.value) / 100;
      }
      simPaused = true;
      contrastSim.setSpeed(0);
    } else {
      simPaused = false;
      let resume = Number(simSpeed.value) / 100;
      if (resume <= 0) resume = speedBeforePause > 0 ? speedBeforePause : 1;
      speedBeforePause = resume;
      simSpeed.value = String(Math.round(resume * 100));
      contrastSim.setSpeed(resume);
    }
    syncSimUI();
  }

  function stopSim() {
    contrastSim.setActive(false);
    simPaused = false;
    syncSimUI();
    if (lesionFocus) applyLesionFocus(true);
  }

  function changeVessel() {
    contrastSim.clearSelection();
    syncSimUI();
    if (lesionFocus) applyLesionFocus(true);
  }

  btnSimulate.addEventListener("click", () => {
    if (contrastSim.active) return;
    lesionMgr.setPlacing(false);
    contrastSim.setActive(true);
    syncSimUI();
  });
  btnBarChange.addEventListener("click", changeVessel);
  btnBarStop.addEventListener("click", stopSim);
  btnBarPlay.addEventListener("click", () => {
    setSimPaused(!(simPaused || contrastSim.speed === 0));
  });
  btnBarInvert.addEventListener("click", () => {
    setFluoroInvert(!fluoroInvert);
  });

  btnLesionCreate.addEventListener("click", () => {
    if (lesionMgr.placing) {
      lesionMgr.setPlacing(false);
      return;
    }
    if (contrastSim.active && contrastSim.side) {
      contrastSim.clearSelection();
      syncSimUI();
    }
    lesionMgr.setPlacing(true);
  });
  btnLesionShow.addEventListener("click", () => {
    applyLesionFocus(!lesionFocus);
  });
  btnLesionDownload.addEventListener("click", () => lesionMgr.download());
  btnLesionLoad.addEventListener("click", () => lesionFileInput.click());
  lesionFileInput.addEventListener("change", async () => {
    const file = lesionFileInput.files?.[0];
    lesionFileInput.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as unknown;
      const result = lesionMgr.loadJSON(data);
      if (!result.ok) {
        window.alert(result.error);
        return;
      }
      syncLesionFlows();
    } catch {
      window.alert("Could not read lesion file.");
    }
  });

  lesionListEl.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const del = t.closest<HTMLElement>("[data-del]");
    if (del?.dataset.del) {
      lesionMgr.remove(del.dataset.del);
      syncLesionFlows();
      return;
    }
    const edit = t.closest<HTMLElement>("[data-edit]");
    if (edit?.dataset.edit) {
      void openLesionEditor(edit.dataset.edit, false);
      return;
    }
    const main = t.closest<HTMLElement>("[data-id]");
    if (main?.dataset.id) {
      lesionMgr.select(main.dataset.id);
    }
  });

  lesionMgr.onChange(() => {
    syncLesionList();
    syncLesionFlows();
    if (lesionFocus) applyLesionFocus(true);
  });
  syncLesionList();

  simSpeed.addEventListener("pointerdown", () => {
    speedDragging = true;
  });
  const endSpeedDrag = () => {
    if (!speedDragging) return;
    speedDragging = false;
    syncSimUI();
  };
  window.addEventListener("pointerup", endSpeedDrag);
  window.addEventListener("pointercancel", endSpeedDrag);
  simSpeed.addEventListener("change", endSpeedDrag);
  simSpeed.addEventListener("input", () => {
    const v = Number(simSpeed.value) / 100;
    // Slider is live speed — including 0. Don't snap back to the pre-pause value.
    if (v > 0) {
      speedBeforePause = v;
      simPaused = false;
    }
    contrastSim.setSpeed(v);
    simReadout.textContent = `${Math.round(v * 100)}%`;
    const running = contrastSim.active && !!contrastSim.side;
    const paused = simPaused || (running && v === 0);
    if (paused) {
      btnBarPlay.classList.add("is-paused");
      btnBarPlay.setAttribute("aria-label", "Play");
      btnBarPlay.title = "Play";
      simStatus.textContent = "Paused";
    } else if (running) {
      btnBarPlay.classList.remove("is-paused");
      btnBarPlay.setAttribute("aria-label", "Pause");
      btnBarPlay.title = "Pause";
      simStatus.textContent = "Running";
    }
  });

  const endSeekDrag = () => {
    seekDragging = false;
  };
  simSeek.addEventListener("pointerdown", () => {
    seekDragging = true;
  });
  window.addEventListener("pointerup", endSeekDrag);
  window.addEventListener("pointercancel", endSeekDrag);
  simSeek.addEventListener("change", endSeekDrag);
  simSeek.addEventListener("input", () => {
    if (!contrastSim.active || !contrastSim.side) return;
    contrastSim.setProgress(Number(simSeek.value) / 1000);
  });

  syncSimUI();

  const hintEl = document.querySelector(".hint") as HTMLElement | null;
  window.setTimeout(() => {
    hintEl?.classList.add("is-hidden");
  }, 10000);

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
    syncCategoryCheckboxes();
  }

  function syncCategoryCheckboxes() {
    for (const cat of VESSEL_CATEGORIES) {
      const input = els["vessel-toggles"].querySelector<HTMLInputElement>(
        `input[data-category="${cat.id}"]`,
      );
      if (!input) continue;
      const states = cat.groups.map((id) => vesselVisibility[id]);
      const allOn = states.every(Boolean);
      const allOff = states.every((s) => !s);
      input.checked = allOn;
      input.indeterminate = !allOn && !allOff;
    }
  }

  function setCategoryVisibility(categoryId: string, on: boolean) {
    const cat = VESSEL_CATEGORIES.find((c) => c.id === categoryId);
    if (!cat) return;
    for (const id of cat.groups) {
      vesselVisibility[id] = on;
      setVesselGroupVisibility(anatomy, id, on);
    }
    syncVesselCheckboxes();
  }

  els["vessel-toggles"].addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.dataset.category) {
      setCategoryVisibility(input.dataset.category, input.checked);
      return;
    }
    if (!input.dataset.vessel) return;
    const id = input.dataset.vessel as VesselGroup;
    vesselVisibility[id] = input.checked;
    setVesselGroupVisibility(anatomy, id, input.checked);
    syncCategoryCheckboxes();
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
  function setPanelCollapsed(collapsed: boolean) {
    panelShell.classList.toggle("collapsed", collapsed);
  }
  els["btn-collapse"].addEventListener("click", () => setPanelCollapsed(true));
  els["btn-expand"].addEventListener("click", () => setPanelCollapsed(false));

  const tooltip = els["vessel-tooltip"];
  const tipName = tooltip.querySelector(".vessel-tooltip-name") as HTMLElement;
  const tipDetail = tooltip.querySelector(".vessel-tooltip-detail") as HTMLElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hoverMesh: THREE.Mesh | null = null;
  let hoverTimer: number | null = null;
  let pointerClient = { x: 0, y: 0 };
  let isDragging = false;
  let pointerDownPos = { x: 0, y: 0 };
  let pointerGestureMoved = false;

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

  function collectVesselTargets(): THREE.Object3D[] {
    const targets: THREE.Object3D[] = [];
    vessels?.traverse((obj) => {
      if (
        obj instanceof THREE.Mesh &&
        obj.visible &&
        obj.userData.isVessel &&
        !obj.userData.isDyeOverlay &&
        !obj.userData.isLesionMesh
      ) {
        targets.push(obj);
      }
    });
    return targets;
  }

  function setRayFromClient(clientX: number, clientY: number) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
  }

  function pickVessel(clientX: number, clientY: number): THREE.Mesh | null {
    setRayFromClient(clientX, clientY);
    const hits = raycaster.intersectObjects(collectVesselTargets(), false);
    return hits.length ? (hits[0].object as THREE.Mesh) : null;
  }

  function pickVesselHit(
    clientX: number,
    clientY: number,
  ): { mesh: THREE.Mesh | null; point: THREE.Vector3 | null } {
    setRayFromClient(clientX, clientY);
    const hits = raycaster.intersectObjects(collectVesselTargets(), false);
    if (!hits.length) return { mesh: null, point: null };
    return { mesh: hits[0].object as THREE.Mesh, point: hits[0].point.clone() };
  }

  function tryPlaceLesionFromClick(clientX: number, clientY: number) {
    if (!lesionMgr.placing) return false;
    const { mesh, point } = pickVesselHit(clientX, clientY);
    const lesion = lesionMgr.tryPlaceFromClick(mesh, point);
    if (!lesion) return false;
    pendingNewLesionId = lesion.id;
    clearHover();
    void openLesionEditor(lesion.id, true);
    return true;
  }

  function tryEngageFromClick(clientX: number, clientY: number) {
    if (lesionMgr.placing) return false;
    if (!contrastSim.active) return false;
    const { mesh, point } = pickVesselHit(clientX, clientY);
    const side = contrastSim.pickSide(raycaster.ray, mesh, point);
    if (!side) return false;
    contrastSim.engage(side);
    syncSimUI();
    clearHover();
    return true;
  }

  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pointerDownPos = { x: e.clientX, y: e.clientY };
    pointerGestureMoved = false;
  });

  renderer.domElement.addEventListener("pointermove", (e) => {
    pointerClient = { x: e.clientX, y: e.clientY };
    if (e.buttons & 1) {
      const dx = e.clientX - pointerDownPos.x;
      const dy = e.clientY - pointerDownPos.y;
      if (dx * dx + dy * dy > 25) pointerGestureMoved = true;
    }

    if (isDragging || pointerGestureMoved) {
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
    }, 250);
  });

  function isTapGesture(clientX: number, clientY: number): boolean {
    if (pointerGestureMoved) return false;
    const dx = clientX - pointerDownPos.x;
    const dy = clientY - pointerDownPos.y;
    return dx * dx + dy * dy <= 36;
  }

  // pointerup — do not gate on OrbitControls isDragging (it flips true on every press)
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (e.button !== 0) return;
    if (!isTapGesture(e.clientX, e.clientY)) return;
    if (tryPlaceLesionFromClick(e.clientX, e.clientY)) return;
    tryEngageFromClick(e.clientX, e.clientY);
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
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    if (e.key === "r" || e.key === "R") {
      setMode("cath");
      setAngles(0, 0, true);
      return;
    }

    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      setPanelCollapsed(!panelShell.classList.contains("collapsed"));
      return;
    }

    if (e.key === "Escape" && lesionMgr.placing) {
      lesionMgr.setPlacing(false);
      return;
    }

    if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      if (contrastSim.active) stopSim();
      else {
        lesionMgr.setPlacing(false);
        contrastSim.setActive(true);
        syncSimUI();
      }
      return;
    }

    const step = e.shiftKey ? 5 : 2;
    let primary = state.primary;
    let secondary = state.secondary;
    switch (e.key) {
      case "ArrowLeft":
        primary -= step;
        break;
      case "ArrowRight":
        primary += step;
        break;
      case "ArrowUp":
        secondary += step;
        break;
      case "ArrowDown":
        secondary -= step;
        break;
      default:
        return;
    }
    e.preventDefault();
    setMode("cath");
    setAngles(primary, secondary, false);
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let lastFrame = performance.now();
  function animate(now = performance.now()) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    contrastSim.update(dt);
    if (contrastSim.active) syncSeekUI();

    if (state.mode === "cath") {
      settleCathCamera(dt);
    } else {
      controls.update();
    }
    renderer.render(scene, camera);
  }
  animate();
}

main();
