import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

/**
 * Report charts drawn as SVG and rasterised to PNG, so they show in e-mail clients and PDFs
 * (neither runs the dashboard's JavaScript charts). Colours match the dashboard.
 */
export const C = {
  ink: '#1c1a2b',
  muted: '#6b6880',
  line: '#e7e5ee',
  surface: '#f6f5f9',
  ruby: '#e11d48',
  violet: '#7c3aed',
  pos: '#0f766e',
  neu: '#cbd5e1',
  neg: '#c2410c',
};
const FONT = 'Plus Jakarta Sans';

const fontFile = (name: string) =>
  readFileSync(new URL(`../../../assets/fonts/${name}`, import.meta.url));

let ready: Promise<Uint8Array[]> | undefined;
function init() {
  ready ??= (async () => {
    const require = createRequire(import.meta.url);
    await initWasm(
      readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')),
    );
    return [
      fontFile('PlusJakartaSans_400Regular.ttf'),
      fontFile('PlusJakartaSans_700Bold.ttf'),
    ].map((b) => new Uint8Array(b));
  })();
  return ready;
}

export async function toPng(svg: string, width: number): Promise<Buffer> {
  const fontBuffers = await init();
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: width * 2 }, // 2x for sharp text on retina screens and print
    font: { fontBuffers, defaultFontFamily: FONT, loadSystemFonts: false },
  })
    .render()
    .asPng();
  return Buffer.from(png);
}

const esc = (s: string) =>
  s.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!,
  );
const compact = (n: number) =>
  new Intl.NumberFormat('id-ID', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
const dayLabel = (ymd: string) =>
  new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${ymd}T00:00:00Z`));

/** Round an axis maximum up to 1, 2 or 5 x 10^n. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

const svgOpen = (w: number, h: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}"><rect width="${w}" height="${h}" fill="#ffffff"/>`;

/** Single-series line chart over days (mentions or reach per day). */
export function lineChart(opts: {
  title: string;
  points: { day: string; value: number }[];
  color: string;
  width?: number;
  height?: number;
}) {
  const W = opts.width ?? 1000;
  const H = opts.height ?? 340;
  const pad = { l: 64, r: 24, t: 56, b: 44 };
  const pts = opts.points;
  const max = niceMax(Math.max(0, ...pts.map((p) => p.value)));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const x = (i: number) =>
    pad.l + (pts.length <= 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;

  let s = svgOpen(W, H);
  s += `<text x="${pad.l}" y="30" font-size="18" font-weight="700" fill="${C.ink}">${esc(opts.title)}</text>`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="${C.line}"/>`;
    s += `<text x="${pad.l - 10}" y="${y(v) + 4}" font-size="12" text-anchor="end" fill="${C.muted}">${compact(v)}</text>`;
  }
  const step = Math.max(1, Math.ceil(pts.length / 8));
  pts.forEach((p, i) => {
    if (i % step === 0 || (i === pts.length - 1 && i % step >= step / 2))
      s += `<text x="${x(i)}" y="${H - 16}" font-size="12" text-anchor="middle" fill="${C.muted}">${esc(dayLabel(p.day))}</text>`;
  });
  if (pts.length) {
    const d = pts
      .map(
        (p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`,
      )
      .join(' ');
    s += `<path d="${d} L${x(pts.length - 1)},${y(0)} L${x(0)},${y(0)} Z" fill="${opts.color}" fill-opacity="0.08"/>`;
    s += `<path d="${d}" fill="none" stroke="${opts.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    const peak = pts.reduce((a, p, i) => (p.value > pts[a].value ? i : a), 0);
    s += `<circle cx="${x(peak)}" cy="${y(pts[peak].value)}" r="4.5" fill="${opts.color}"/>`;
    s += `<text x="${x(peak)}" y="${y(pts[peak].value) - 10}" font-size="12" font-weight="700" text-anchor="middle" fill="${C.ink}">${compact(pts[peak].value)}</text>`;
  }
  return s + '</svg>';
}

/** Horizontal bars, one per row, with a value label (e.g. share of voice per brand). */
export function barChart(opts: {
  title: string;
  rows: { label: string; value: number; color: string; display: string }[];
  width?: number;
}) {
  const W = opts.width ?? 1000;
  const rowH = 38;
  const pad = { l: 150, r: 90, t: 56, b: 16 };
  const H = pad.t + opts.rows.length * rowH + pad.b;
  const max = Math.max(1, ...opts.rows.map((r) => r.value));
  const iw = W - pad.l - pad.r;
  let s = svgOpen(W, H);
  s += `<text x="24" y="30" font-size="18" font-weight="700" fill="${C.ink}">${esc(opts.title)}</text>`;
  opts.rows.forEach((r, i) => {
    const yy = pad.t + i * rowH;
    const w = Math.max(2, (r.value / max) * iw);
    s += `<text x="${pad.l - 12}" y="${yy + 21}" font-size="14" text-anchor="end" fill="${C.ink}">${esc(r.label)}</text>`;
    s += `<rect x="${pad.l}" y="${yy + 6}" width="${iw}" height="22" rx="6" fill="${C.surface}"/>`;
    s += `<rect x="${pad.l}" y="${yy + 6}" width="${w}" height="22" rx="6" fill="${r.color}"/>`;
    s += `<text x="${pad.l + w + 8}" y="${yy + 22}" font-size="13" font-weight="700" fill="${C.ink}">${esc(r.display)}</text>`;
  });
  return s + '</svg>';
}

/** One 100% bar per row split into positive / neutral / negative. */
export function sentimentChart(opts: {
  title: string;
  rows: {
    label: string;
    positive: number;
    neutral: number;
    negative: number;
  }[];
  width?: number;
}) {
  const W = opts.width ?? 1000;
  const rowH = 38;
  const pad = { l: 150, r: 24, t: 80, b: 16 };
  const H = pad.t + opts.rows.length * rowH + pad.b;
  const iw = W - pad.l - pad.r;
  let s = svgOpen(W, H);
  s += `<text x="24" y="30" font-size="18" font-weight="700" fill="${C.ink}">${esc(opts.title)}</text>`;
  [
    ['Positif', C.pos],
    ['Netral', C.neu],
    ['Negatif', C.neg],
  ].forEach(([label, color], i) => {
    s += `<rect x="${24 + i * 110}" y="46" width="12" height="12" rx="3" fill="${color}"/>`;
    s += `<text x="${42 + i * 110}" y="57" font-size="13" fill="${C.muted}">${label}</text>`;
  });
  opts.rows.forEach((r, i) => {
    const yy = pad.t + i * rowH;
    const total = r.positive + r.neutral + r.negative || 1;
    s += `<text x="${pad.l - 12}" y="${yy + 21}" font-size="14" text-anchor="end" fill="${C.ink}">${esc(r.label)}</text>`;
    let x0 = pad.l;
    for (const [v, color] of [
      [r.positive, C.pos],
      [r.neutral, C.neu],
      [r.negative, C.neg],
    ] as const) {
      const w = (v / total) * iw;
      if (w > 0)
        s += `<rect x="${x0}" y="${yy + 6}" width="${w}" height="22" fill="${color}"/>`;
      if (w > 44)
        s += `<text x="${x0 + w / 2}" y="${yy + 22}" font-size="12" font-weight="700" text-anchor="middle" fill="${color === C.neu ? C.ink : '#ffffff'}">${Math.round((v / total) * 100)}%</text>`;
      x0 += w;
    }
  });
  return s + '</svg>';
}
