import {
  PROFILE_SAMPLES,
  lesionLengthMm,
  residualAreaFromProfile,
  severityFromProfile,
  severityPct,
  uniformProfile,
  type BranchMark,
  type LesionRecord,
} from "./lesions";

export type LesionEditorResult = {
  profile: number[];
  severity: number;
  lengthT: number;
};

export type LesionEditorHandle = {
  open(opts: {
    lesion: LesionRecord;
    vesselName: string;
    vesselLengthMm: number;
    branches: BranchMark[];
    title?: string;
  }): Promise<LesionEditorResult | null>;
  dispose(): void;
};

const LENGTH_MIN = 0.015;
const LENGTH_MAX = 0.14;
/**
 * Gaussian σ in samples for cave-in / bulge.
 * ~¼ of the ring so a drag always moves a wide neighborhood.
 */
const DRAG_SIGMA = PROFILE_SAMPLES * 0.28;
/** Max |r[i-1] - 2r[i] + r[i+1]| — keeps the polar contour C-ish smooth (no cusps). */
const MAX_LAPLACIAN = 0.038;

/**
 * Modal cross-section editor with deformable lumen contour + length.
 * Dragging caves the lumen in as a smooth curve — neighbors always follow.
 */
export function createLesionEditor(host: HTMLElement): LesionEditorHandle {
  const overlay = document.createElement("div");
  overlay.className = "lesion-modal";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="lesion-modal-card" role="dialog" aria-modal="true" aria-labelledby="lesion-modal-title">
      <header class="lesion-modal-head">
        <h2 id="lesion-modal-title">Define lesion</h2>
        <p class="lesion-modal-sub" id="lesion-modal-sub"></p>
      </header>
      <div class="lesion-modal-body">
        <div class="lesion-circle-wrap">
          <canvas id="lesion-canvas" width="300" height="300" aria-label="Lesion cross-section"></canvas>
        </div>
        <div class="lesion-modal-controls">
          <label class="lesion-severity-label">
            Stenosis
            <span id="lesion-pct-readout">50%</span>
          </label>
          <input id="lesion-severity" type="range" min="0" max="100" value="50" step="1" />

          <label class="lesion-severity-label lesion-length-label">
            Length
            <span id="lesion-length-readout">4 mm</span>
          </label>
          <input id="lesion-length" type="range" min="0" max="100" value="20" step="1" />

          <p class="lesion-paint-hint">
            Drag toward the center to cave the lumen in — the outline stays a smooth curve.
          </p>
          <div class="lesion-edit-actions">
            <button type="button" id="lesion-round" class="lesion-btn-soft">Make circular</button>
            <button type="button" id="lesion-occlude" class="lesion-occlude">Fully occlude</button>
          </div>
        </div>
      </div>
      <footer class="lesion-modal-foot">
        <button type="button" id="lesion-cancel" class="lesion-btn-ghost">Cancel</button>
        <button type="button" id="lesion-save" class="lesion-btn-primary">Save lesion</button>
      </footer>
    </div>
  `;
  host.appendChild(overlay);

  const canvas = overlay.querySelector("#lesion-canvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const sub = overlay.querySelector("#lesion-modal-sub") as HTMLElement;
  const titleEl = overlay.querySelector("#lesion-modal-title") as HTMLElement;
  const slider = overlay.querySelector("#lesion-severity") as HTMLInputElement;
  const lengthSlider = overlay.querySelector("#lesion-length") as HTMLInputElement;
  const pctReadout = overlay.querySelector("#lesion-pct-readout") as HTMLElement;
  const lengthReadout = overlay.querySelector("#lesion-length-readout") as HTMLElement;
  const btnOcclude = overlay.querySelector("#lesion-occlude") as HTMLButtonElement;
  const btnRound = overlay.querySelector("#lesion-round") as HTMLButtonElement;
  const btnCancel = overlay.querySelector("#lesion-cancel") as HTMLButtonElement;
  const btnSave = overlay.querySelector("#lesion-save") as HTMLButtonElement;

  let profile = uniformProfile(0.5);
  let lengthT = 0.028;
  let vesselLenMm = 100;
  let branches: BranchMark[] = [];
  let dragIndex: number | null = null;
  let dragStartProfile: number[] | null = null;
  let resolvePromise: ((r: LesionEditorResult | null) => void) | null = null;

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const R = 100;

  function lengthToSlider(lt: number): number {
    return Math.round(
      ((lt - LENGTH_MIN) / (LENGTH_MAX - LENGTH_MIN)) * 100,
    );
  }

  function sliderToLength(v: number): number {
    return LENGTH_MIN + (v / 100) * (LENGTH_MAX - LENGTH_MIN);
  }

  function formatLengthMm(lt: number): string {
    const mm = lesionLengthMm(lt, vesselLenMm);
    const rounded = mm >= 10 ? Math.round(mm) : Math.round(mm * 10) / 10;
    return `${rounded} mm`;
  }

  function syncReadouts() {
    const sev = severityFromProfile(profile);
    const area = residualAreaFromProfile(profile);
    slider.value = String(Math.round(sev * 100));
    pctReadout.textContent =
      area < 0.02 ? "Occluded" : `${severityPct(sev)}%`;
    lengthSlider.value = String(lengthToSlider(lengthT));
    lengthReadout.textContent = formatLengthMm(lengthT);
  }

  function angleOf(i: number): number {
    return (i / PROFILE_SAMPLES) * Math.PI * 2;
  }

  function handlePos(i: number): { x: number; y: number } {
    const a = angleOf(i);
    const r = R * Math.max(0.02, profile[i]);
    return {
      x: cx + Math.cos(a) * r,
      y: cy + Math.sin(a) * r,
    };
  }

  function angularDist(a: number, b: number): number {
    let d = Math.abs(a - b) % PROFILE_SAMPLES;
    if (d > PROFILE_SAMPLES / 2) d = PROFILE_SAMPLES - d;
    return d;
  }

  /**
   * Kill sharp cusps: pull neighbors (and optionally the vertex) so the
   * discrete Laplacian stays bounded. When `pin` is set, that sample is
   * re-applied each pass so the drag target stays put while the ring flexes.
   */
  function enforceSmoothCurve(radii: number[], pin?: { index: number; value: number }) {
    const n = radii.length;
    for (let pass = 0; pass < 24; pass++) {
      if (pin) radii[pin.index] = pin.value;
      let worst = 0;
      for (let i = 0; i < n; i++) {
        const i0 = (i - 1 + n) % n;
        const i1 = (i + 1) % n;
        const lap = radii[i0] - 2 * radii[i] + radii[i1];
        worst = Math.max(worst, Math.abs(lap));
        if (lap > MAX_LAPLACIAN) {
          // Inward cusp: center lower than neighbors — suck neighbors in
          const excess = lap - MAX_LAPLACIAN;
          if (pin && i === pin.index) {
            radii[i0] = Math.max(0, radii[i0] - excess * 0.5);
            radii[i1] = Math.max(0, radii[i1] - excess * 0.5);
          } else {
            radii[i] = Math.min(1, radii[i] + excess * 0.34);
            radii[i0] = Math.max(0, radii[i0] - excess * 0.17);
            radii[i1] = Math.max(0, radii[i1] - excess * 0.17);
          }
        } else if (lap < -MAX_LAPLACIAN) {
          const excess = -MAX_LAPLACIAN - lap;
          if (pin && i === pin.index) {
            radii[i0] = Math.min(1, radii[i0] + excess * 0.5);
            radii[i1] = Math.min(1, radii[i1] + excess * 0.5);
          } else {
            radii[i] = Math.max(0, radii[i] - excess * 0.34);
            radii[i0] = Math.min(1, radii[i0] + excess * 0.17);
            radii[i1] = Math.min(1, radii[i1] + excess * 0.17);
          }
        }
      }
      if (pin) radii[pin.index] = pin.value;
      if (worst <= MAX_LAPLACIAN + 1e-4) break;
    }
    for (let i = 0; i < n; i++) {
      radii[i] = Math.min(1, Math.max(0, radii[i]));
    }
    if (pin) radii[pin.index] = Math.min(1, Math.max(0, pin.value));
  }

  /** Closed Catmull-Rom sample for a silky lumen outline. */
  function smoothLumenPoint(t: number): { x: number; y: number } {
    const n = PROFILE_SAMPLES;
    const x = ((t % n) + n) % n;
    const i1 = Math.floor(x);
    const f = x - i1;
    const i0 = (i1 - 1 + n) % n;
    const i2 = (i1 + 1) % n;
    const i3 = (i1 + 2) % n;
    const p0 = handlePos(i0);
    const p1 = handlePos(i1);
    const p2 = handlePos(i2);
    const p3 = handlePos(i3);
    const f2 = f * f;
    const f3 = f2 * f;
    return {
      x:
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * f +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * f2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * f3),
      y:
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * f +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * f2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * f3),
    };
  }

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = "rgba(8, 16, 22, 0.9)";
    ctx.beginPath();
    ctx.arc(cx, cy, R + 36, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = "#2a3a44";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#5a7a88";
    ctx.stroke();

    const area = residualAreaFromProfile(profile);
    const occluded = area < 0.02;

    ctx.beginPath();
    ctx.arc(cx, cy, R - 1.5, 0, Math.PI * 2);
    ctx.fillStyle = occluded ? "#8a3030" : "#b85a4a";
    ctx.fill();

    if (!occluded) {
      const steps = PROFILE_SAMPLES * 4;
      ctx.beginPath();
      for (let s = 0; s <= steps; s++) {
        const p = smoothLumenPoint((s / steps) * PROFILE_SAMPLES);
        if (s === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(200, 220, 230, 0.38)";
      ctx.fill();
      ctx.strokeStyle = "rgba(180, 210, 220, 0.85)";
      ctx.lineWidth = 2;
      ctx.stroke();

      for (let i = 0; i < PROFILE_SAMPLES; i++) {
        const p = handlePos(i);
        const active = dragIndex === i;
        ctx.beginPath();
        ctx.arc(p.x, p.y, active ? 5.5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = active ? "#e8c040" : "rgba(216, 232, 240, 0.85)";
        ctx.fill();
        ctx.strokeStyle = active ? "#b89020" : "#3a5060";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = "#5a1818";
      ctx.beginPath();
      ctx.arc(cx, cy, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e8c0b0";
      ctx.font = "600 11px Outfit, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("100%", cx, cy);
    }

    for (const b of branches) {
      const lx = cx + Math.cos(b.angle) * (R + 16);
      const ly = cy + Math.sin(b.angle) * (R + 16);
      const tx = cx + Math.cos(b.angle) * (R + 40);
      const ty = cy + Math.sin(b.angle) * (R + 40);

      ctx.strokeStyle = "rgba(61, 184, 200, 0.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(
        cx + Math.cos(b.angle) * (R - 2),
        cy + Math.sin(b.angle) * (R - 2),
      );
      ctx.lineTo(lx, ly);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(lx, ly, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#3db8c8";
      ctx.fill();

      ctx.fillStyle = "#c8dde6";
      ctx.font = "600 11px Outfit, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.name, tx, ty);
    }

    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath();
    ctx.roundRect(cx - 36, cy + R + 10, 72, 22, 6);
    ctx.fill();
    ctx.fillStyle = "#e6eaed";
    ctx.font = "600 12px IBM Plex Mono, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      occluded ? "Occluded" : `${severityPct(severityFromProfile(profile))}%`,
      cx,
      cy + R + 21,
    );
  }

  function canvasPoint(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function nearestHandle(x: number, y: number): number | null {
    let best = -1;
    let bestD = 16 * 16;
    for (let i = 0; i < PROFILE_SAMPLES; i++) {
      const p = handlePos(i);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? best : null;
  }

  function setHandleFromPointer(i: number, clientX: number, clientY: number) {
    const base = dragStartProfile ?? profile;
    const { x, y } = canvasPoint(clientX, clientY);
    const dx = x - cx;
    const dy = y - cy;
    const a = angleOf(i);
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const proj = Math.max(0, dx * ux + dy * uy);
    const targetR = Math.min(1, proj / R);
    const delta = targetR - base[i];
    const twoSig2 = 2 * DRAG_SIGMA * DRAG_SIGMA;

    // Wide Gaussian lobe from the drag-start shape
    const next = base.map((r, j) => {
      const d = angularDist(j, i);
      const w = Math.exp((-d * d) / twoSig2);
      return Math.min(1, Math.max(0, r + delta * w));
    });
    // Flex the whole ring until there are no sharp points, keeping the drag pinned
    enforceSmoothCurve(next, { index: i, value: targetR });
    profile = next;
    syncReadouts();
    draw();
  }

  canvas.addEventListener("pointerdown", (e) => {
    const { x, y } = canvasPoint(e.clientX, e.clientY);
    const hit = nearestHandle(x, y);
    if (hit == null) {
      const ang = Math.atan2(y - cy, x - cx);
      const i =
        Math.round((((ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) /
          ((Math.PI * 2) / PROFILE_SAMPLES)) % PROFILE_SAMPLES;
      dragIndex = i;
    } else {
      dragIndex = hit;
    }
    dragStartProfile = [...profile];
    canvas.setPointerCapture(e.pointerId);
    setHandleFromPointer(dragIndex, e.clientX, e.clientY);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragIndex == null) return;
    setHandleFromPointer(dragIndex, e.clientX, e.clientY);
  });
  const endDrag = () => {
    if (profile.length) enforceSmoothCurve(profile);
    dragIndex = null;
    dragStartProfile = null;
    syncReadouts();
    draw();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  slider.addEventListener("input", () => {
    const targetSev = Number(slider.value) / 100;
    const targetResidual = 1 - targetSev;
    const curMean =
      profile.reduce((a, b) => a + b, 0) / Math.max(1, profile.length);
    if (curMean < 1e-4) {
      profile = uniformProfile(targetResidual);
    } else {
      const scale = targetResidual / curMean;
      profile = profile.map((r) => Math.min(1, Math.max(0, r * scale)));
    }
    enforceSmoothCurve(profile);
    syncReadouts();
    draw();
  });

  lengthSlider.addEventListener("input", () => {
    lengthT = sliderToLength(Number(lengthSlider.value));
    syncReadouts();
  });

  btnOcclude.addEventListener("click", () => {
    profile = uniformProfile(0);
    syncReadouts();
    draw();
  });

  btnRound.addEventListener("click", () => {
    const mean =
      profile.reduce((a, b) => a + b, 0) / Math.max(1, profile.length);
    profile = uniformProfile(mean);
    syncReadouts();
    draw();
  });

  function close(result: LesionEditorResult | null) {
    overlay.hidden = true;
    dragIndex = null;
    dragStartProfile = null;
    const r = resolvePromise;
    resolvePromise = null;
    r?.(result);
  }

  btnCancel.addEventListener("click", () => close(null));
  btnSave.addEventListener("click", () =>
    close({
      profile: [...profile],
      severity: severityFromProfile(profile),
      lengthT,
    }),
  );
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close(null);
  });

  const onKey = (e: KeyboardEvent) => {
    if (overlay.hidden) return;
    if (e.key === "Escape") close(null);
    if (e.key === "Enter") {
      close({
        profile: [...profile],
        severity: severityFromProfile(profile),
        lengthT,
      });
    }
  };
  window.addEventListener("keydown", onKey);

  return {
    open({ lesion, vesselName, vesselLengthMm, branches: marks, title }) {
      return new Promise((resolve) => {
        resolvePromise = resolve;
        branches = marks;
        vesselLenMm = vesselLengthMm;
        titleEl.textContent = title ?? "Define lesion";
        sub.textContent = `${vesselName} · deform lumen · set length`;
        profile = [
          ...(lesion.profile?.length
            ? lesion.profile
            : uniformProfile(1 - lesion.severity)),
        ];
        if (profile.length !== PROFILE_SAMPLES) {
          profile = uniformProfile(1 - lesion.severity);
        }
        enforceSmoothCurve(profile);
        lengthT = lesion.lengthT;
        syncReadouts();
        draw();
        overlay.hidden = false;
      });
    },
    dispose() {
      window.removeEventListener("keydown", onKey);
      overlay.remove();
    },
  };
}
