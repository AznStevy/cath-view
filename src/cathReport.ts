import { DEFAULT_LENGTH_T } from "./lesions";

/** A stenosis the model can place. */
export type ReportLesion = {
  vesselId: string;
  /** Curve parameter ∈ [0, 1]. */
  t: number;
  /** Diameter stenosis ∈ [0, 1]. */
  severity: number;
  lengthT: number;
  summary: string;
};

/** A finding that looked like disease but was not placed. */
export type ReportSkip = {
  summary: string;
  reason: string;
};

export type CathReportParse = {
  lesions: ReportLesion[];
  skipped: ReportSkip[];
};

type VesselRef = { id: string | null; label: string };

type VesselHit = VesselRef & { index: number; length: number };

const ALIASES: { id: string | null; label: string; source: string }[] = [
  { id: null, label: "Ramus", source: String.raw`\b(?:ramus(?:\s+intermedius)?|intermediate\s+(?:artery|branch))\b` },
  { id: "lm", label: "Left main", source: String.raw`\b(?:left\s+main(?:\s+coronary)?(?:\s+artery)?|lmca|\blm\b)\b` },
  { id: "lad", label: "LAD", source: String.raw`\b(?:left\s+anterior\s+descending(?:\s+artery)?|\blad\b)\b` },
  { id: "d1", label: "D1", source: String.raw`\b(?:(?:1st|first)\s+diagonal(?:\s+branch)?|diagonal\s*1|\bd1\b)\b` },
  { id: "d2", label: "D2", source: String.raw`\b(?:(?:2nd|second)\s+diagonal(?:\s+branch)?|diagonal\s*2|\bd2\b)\b` },
  { id: "d3", label: "D3", source: String.raw`\b(?:(?:3rd|third)\s+diagonal(?:\s+branch)?|diagonal\s*3|\bd3\b)\b` },
  { id: "d1", label: "Diagonal", source: String.raw`\b(?:diagonal(?:\s+branch)?|diags?)\b` },
  { id: "s1", label: "Septal", source: String.raw`\b(?:(?:1st|first)\s+septal(?:\s+perforator)?|septal(?:\s+perforator)?s?)\b` },
  { id: "lcx", label: "LCx", source: String.raw`\b(?:left\s+circumflex(?:\s+artery)?|circumflex|\bcirc\b|\blcx\b)\b` },
  { id: "om1", label: "OM1", source: String.raw`\b(?:(?:1st|first)\s+(?:om|obtuse\s+marginal)(?:\s+branch)?|\bom\s*1\b|\bom1\b)\b` },
  { id: "om2", label: "OM2", source: String.raw`\b(?:(?:2nd|second)\s+(?:om|obtuse\s+marginal)(?:\s+branch)?|\bom\s*2\b|\bom2\b)\b` },
  { id: "om3", label: "OM3", source: String.raw`\b(?:(?:3rd|third)\s+(?:om|obtuse\s+marginal)(?:\s+branch)?|\bom\s*3\b|\bom3\b)\b` },
  { id: "om1", label: "OM", source: String.raw`\b(?:obtuse\s+marginal(?:\s+branch)?|\bom\b)\b` },
  { id: "lpl", label: "LCx PL", source: String.raw`\b(?:left\s+(?:pl|posterolateral)(?:\s+branch)?|lcx\s+pl|\blpl\b)\b` },
  { id: "rca", label: "RCA", source: String.raw`\b(?:right\s+coronary(?:\s+artery)?|\brca\b)\b` },
  { id: "pda", label: "PDA", source: String.raw`\b(?:posterior\s+descending(?:\s+artery)?|\bpda\b)\b` },
  { id: "rpl", label: "RPL", source: String.raw`\b(?:right\s+(?:pl|posterolateral)(?:\s+branch)?|(?:posterolateral|pl)\s+branch|\brpl\b|\bplv\b)\b` },
  { id: "sn", label: "SN", source: String.raw`\b(?:sinoatrial|sinus\s+node|\bsn\b)(?:\s+branch)?\b` },
  { id: "conus", label: "Conus", source: String.raw`\bconus(?:\s+branch)?\b` },
  { id: "am1", label: "Acute marginal", source: String.raw`\b(?:acute\s+marginal(?:\s+branch)?|\bam1\b)\b` },
  { id: "rv", label: "RV branch", source: String.raw`\b(?:rv\s+branch|right\s+ventricular\s+branch)\b` },
];

const LOC_RE = /\b(ostial|ostium|proximal|prox|mid|middle|distal|dist)\b/i;

function normalize(raw: string): string {
  return raw
    .replace(/[\u00b7\u2022\u25aa\u25cf\uF0B7]/g, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function findVessels(text: string): VesselHit[] {
  const hits: VesselHit[] = [];
  for (const alias of ALIASES) {
    const re = new RegExp(alias.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      hits.push({
        id: alias.id,
        label: alias.label,
        index: m.index,
        length: m[0].length,
      });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  const kept: VesselHit[] = [];
  let end = -1;
  for (const hit of hits) {
    if (hit.index < end) continue;
    kept.push(hit);
    end = hit.index + hit.length;
  }
  return kept;
}

function matchHeader(line: string): { vessel: VesselRef; rest: string } | null {
  const m = line.match(/^(.{2,60}?)(?:\s*[:;\-–—]\s+)([\s\S]*)$/);
  if (!m) return null;
  const prefix = m[1]!.trim();
  const hits = findVessels(prefix);
  if (hits.length !== 1) return null;
  const hit = hits[0]!;
  const leftover = (prefix.slice(0, hit.index) + prefix.slice(hit.index + hit.length)).trim();
  // Header should be the vessel name, not a sentence that mentions one.
  if (leftover.length > 12) return null;
  return { vessel: { id: hit.id, label: hit.label }, rest: m[2] ?? "" };
}

function splitClauses(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/[.;]+/)) {
    const parts = sentence.split(/,(?!\s*\d)/);
    for (const part of parts) {
      const pcts = part.match(/(?:\d{1,3}\s*(?:%|percent))/gi);
      if ((pcts?.length ?? 0) > 1 && /\band\b/i.test(part)) {
        for (const bit of part.split(/\band\b/i)) {
          const t = bit.trim();
          if (t) out.push(t);
        }
      } else {
        const t = part.trim();
        if (t) out.push(t);
      }
    }
  }
  return out;
}

function isNonCoronary(clause: string): boolean {
  return /\b(ejection\s+fraction|lvef|\bef\b|troponin|creatinine|hemoglobin|hba1c)\b/i.test(clause);
}

function extractPercents(clause: string): { value: number; index: number; length: number }[] {
  const found: { value: number; index: number; length: number }[] = [];
  const range = /(\d{1,3})\s*(?:-|–|—|to)\s*(\d{1,3})\s*(?:%|percent)/gi;
  let m: RegExpExecArray | null;
  const covered: [number, number][] = [];
  while ((m = range.exec(clause))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    found.push({ value: Math.max(a, b), index: m.index, length: m[0].length });
    covered.push([m.index, m.index + m[0].length]);
  }
  const single = /(\d{1,3})\s*(?:%|percent)/gi;
  while ((m = single.exec(clause))) {
    const start = m.index;
    if (covered.some(([a, b]) => start >= a && start < b)) continue;
    found.push({ value: Number(m[1]), index: start, length: m[0].length });
  }
  return found.filter((p) => p.value >= 0 && p.value <= 100);
}

function locationIn(text: string): { name: string; t: number } | null {
  const m = text.match(LOC_RE);
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  if (word === "ostial" || word === "ostium") return { name: "Ostial", t: 0.04 };
  if (word === "proximal" || word === "prox") return { name: "Prox", t: 0.2 };
  if (word === "mid" || word === "middle") return { name: "Mid", t: 0.5 };
  return { name: "Distal", t: 0.82 };
}

function windowAround(text: string, index: number, radius: number): string {
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius));
}

function vesselNear(clause: string, index: number, section: VesselRef | null): VesselRef | null {
  const hits = findVessels(clause).map((hit) => remapPosterolateral(hit, section));
  const near = hits.filter((h) => h.index >= index - 60 && h.index <= index + 36);
  if (near.length) {
    near.sort((a, b) => Math.abs(a.index - index) - Math.abs(b.index - index));
    return near[0]!;
  }
  const before = hits.filter((h) => h.index <= index + 8);
  if (before.length) return before[before.length - 1]!;
  return section;
}

function remapPosterolateral(hit: VesselHit, section: VesselRef | null): VesselHit {
  if (hit.id === "rpl" && (section?.id === "lcx" || section?.id === "lpl" || section?.id === "om1")) {
    return { ...hit, id: "lpl", label: "LCx PL" };
  }
  return hit;
}

function lengthFor(clause: string): number {
  if (/\b(diffuse|long(?:\s+segment)?|tubular)\b/i.test(clause)) return 0.09;
  return DEFAULT_LENGTH_T;
}

function qualitativeSeverity(clause: string): { severity: number; name: string } | null {
  const checks: { re: RegExp; severity: number; name: string }[] = [
    { re: /\b(subtotal|sub-total|near[- ]total)\b/i, severity: 0.99, name: "subtotal" },
    { re: /\b(occluded|occlusion|totally occluded|total occlusion|\bcto\b|timi\s*0)\b/i, severity: 1, name: "occluded" },
    { re: /\b(critical|tight|severe|high[- ]grade)\b/i, severity: 0.8, name: "severe" },
    { re: /\bmoderate\b/i, severity: 0.6, name: "moderate" },
  ];
  for (const check of checks) {
    const m = check.re.exec(clause);
    if (!m) continue;
    const after = clause.slice(m.index, m.index + m[0].length + 16);
    if (/\b(sized|caliber|calibre)\b/i.test(after)) continue;
    return { severity: check.severity, name: check.name };
  }
  return null;
}

function ignoredFiller(clause: string): boolean {
  if (/\d{2,3}\s*(?:%|percent)/i.test(clause)) return false;
  if (/\b(occlu|subtotal|critical|tight|severe|high[- ]grade)\b/i.test(clause)) return false;
  return (
    /\bpatent\b/i.test(clause) ||
    /\bno\s+(?:significant|obstructive|angiographic|flow-limiting)?\s*(?:disease|stenosis|lesions?|narrowing|obstruction)/i.test(clause) ||
    /\bwithout\s+(?:significant|obstructive)/i.test(clause) ||
    /\bnon[- ]obstructive\b/i.test(clause) ||
    /\b(tapers?|ectasi[ac]|ectatic|calcifi|bridging|aneurysm|tortuous|irregularit)/i.test(clause) ||
    /\bmild\b/i.test(clause)
  );
}

function placeKey(vesselId: string, t: number): string {
  return `${vesselId}:${Math.round(t * 8)}`;
}

/**
 * Pull stenoses out of a free-text cath report.
 * Any explicit percent stenosis is placed, including under 50%. Patent stents,
 * unlabeled mild disease, and "no significant disease" are ignored.
 * Unmapped vessels (e.g. ramus) are skipped.
 */
export function parseCathReport(raw: string): CathReportParse {
  const lesions: ReportLesion[] = [];
  const skipped: ReportSkip[] = [];
  const seen = new Set<string>();
  const seenSkip = new Set<string>();

  const pushLesion = (lesion: ReportLesion) => {
    const key = placeKey(lesion.vesselId, lesion.t);
    const prev = lesions.findIndex((L) => placeKey(L.vesselId, L.t) === key);
    if (prev >= 0) {
      if (lesion.severity > lesions[prev]!.severity) lesions[prev] = lesion;
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    lesions.push(lesion);
  };

  const pushSkip = (skip: ReportSkip) => {
    const key = `${skip.summary}|${skip.reason}`;
    if (seenSkip.has(key)) return;
    seenSkip.add(key);
    skipped.push(skip);
  };

  let section: VesselRef | null = null;
  for (const line of normalize(raw).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const header = matchHeader(trimmed);
    const body = header ? header.rest : trimmed;
    if (header) section = header.vessel;
    for (const clause of splitClauses(body)) {
      if (isNonCoronary(clause)) continue;
      if (ignoredFiller(clause)) continue;

      const percents = extractPercents(clause);
      if (percents.length) {
        const mentioned = findVessels(clause).map((h) => remapPosterolateral(h, section));
        const share =
          percents.length === 1 &&
          mentioned.length > 1 &&
          /\binvolving\b/i.test(clause);
        for (const pct of percents) {
          const targets = share
            ? mentioned
            : [vesselNear(clause, pct.index, section)].filter((v): v is VesselRef => !!v);
          if (!targets.length) {
            pushSkip({
              summary: `${Math.round(pct.value)}% stenosis`,
              reason: "Could not tell which vessel.",
            });
            continue;
          }
          for (const vessel of targets) {
            const loc = locationIn(windowAround(clause, pct.index, 48)) ?? locationIn(clause);
            const where = loc?.name ?? "";
            const summary = `${where ? where + " " : ""}${vessel.label} ${Math.round(pct.value)}%`
              .replace(/\s+/g, " ")
              .trim();
            if (vessel.id == null) {
              pushSkip({ summary, reason: "That vessel is not in this model." });
              continue;
            }
            pushLesion({
              vesselId: vessel.id,
              t: loc?.t ?? 0.4,
              severity: Math.min(1, pct.value / 100),
              lengthT: lengthFor(clause),
              summary,
            });
          }
        }
        continue;
      }

      const qual = qualitativeSeverity(clause);
      if (!qual) continue;
      const hits = findVessels(clause).map((h) => remapPosterolateral(h, section));
      const targets: VesselRef[] = hits.length ? hits : section ? [section] : [];
      if (!targets.length) continue;
      const loc = locationIn(clause);
      for (const vessel of targets) {
        const summary = `${loc?.name ? loc.name + " " : ""}${vessel.label} ${qual.name}`.replace(/\s+/g, " ").trim();
        if (vessel.id == null) {
          pushSkip({ summary, reason: "That vessel is not in this model." });
          continue;
        }
        pushLesion({
          vesselId: vessel.id,
          t: loc?.t ?? 0.4,
          severity: qual.severity,
          lengthT: lengthFor(clause),
          summary,
        });
      }
    }
  }

  return { lesions, skipped };
}
