import { parseCathReport, type ReportLesion } from "./cathReport";

export type ReportImport = {
  open(): void;
};

export function createReportImport(
  host: HTMLElement,
  onApply: (lesions: ReportLesion[]) => void,
): ReportImport {
  const overlay = document.createElement("div");
  overlay.className = "lesion-modal";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="lesion-modal-card report-modal-card" role="dialog" aria-labelledby="report-modal-title">
      <header class="lesion-modal-head">
        <h2 id="report-modal-title">Cath report</h2>
        <p class="lesion-modal-sub">Paste a free-text angiography report. Any stated percent stenosis is placed on the model.</p>
      </header>
      <div class="report-form">
        <textarea id="report-text" class="report-text" rows="12" placeholder="Paste the coronary angiography report…"></textarea>
        <p class="report-disclaimer">Text parsing is experimental and might not be accurate. Review each lesion after import.</p>
      </div>
      <div class="report-result" id="report-result" hidden></div>
      <footer class="lesion-modal-foot">
        <button type="button" id="report-cancel" class="lesion-btn-ghost">Cancel</button>
        <button type="button" id="report-submit" class="lesion-btn-primary">Submit</button>
      </footer>
    </div>
  `;
  host.appendChild(overlay);

  const text = overlay.querySelector("#report-text") as HTMLTextAreaElement;
  const form = overlay.querySelector(".report-form") as HTMLElement;
  const result = overlay.querySelector("#report-result") as HTMLElement;
  const btnCancel = overlay.querySelector("#report-cancel") as HTMLButtonElement;
  const btnSubmit = overlay.querySelector("#report-submit") as HTMLButtonElement;

  function reset() {
    form.hidden = false;
    result.hidden = true;
    result.innerHTML = "";
    btnSubmit.hidden = false;
    btnCancel.textContent = "Cancel";
    overlay.querySelector(".lesion-modal-foot")?.classList.remove("is-single");
  }

  function close() {
    overlay.hidden = true;
  }

  function showResult(placed: ReportLesion[], skipped: { summary: string; reason: string }[]) {
    form.hidden = true;
    result.hidden = false;
    btnSubmit.hidden = true;
    btnCancel.textContent = "Close";
    overlay.querySelector(".lesion-modal-foot")?.classList.add("is-single");
    const placedHtml = placed.length
      ? `<ul class="report-result-list">${placed
          .map((L) => `<li>${escapeHtml(L.summary)}</li>`)
          .join("")}</ul>`
      : `<p class="report-result-empty">No stenoses were placed.</p>`;
    const skipHtml = skipped.length
      ? `<p class="report-result-label">Not placed</p><ul class="report-result-list report-result-skipped">${skipped
          .map((s) => `<li>${escapeHtml(s.summary)} <span>${escapeHtml(s.reason)}</span></li>`)
          .join("")}</ul>`
      : "";
    result.innerHTML = `
      <p class="report-result-label">${placed.length} lesion${placed.length === 1 ? "" : "s"} added</p>
      ${placedHtml}
      ${skipHtml}
      <p class="report-disclaimer">Text parsing is experimental and might not be accurate.</p>
    `;
  }

  btnCancel.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  btnSubmit.addEventListener("click", () => {
    const parsed = parseCathReport(text.value);
    if (parsed.lesions.length) onApply(parsed.lesions);
    showResult(parsed.lesions, parsed.skipped);
  });

  return {
    open() {
      reset();
      overlay.hidden = false;
      text.focus();
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
