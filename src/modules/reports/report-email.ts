import { C } from './charts.js';
import { channelLabel, type ReportData } from './report-data.service.js';

const esc = (s: string) =>
  s.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!,
  );
const nf = (n: number) => n.toLocaleString('id-ID');
const compact = (n: number) =>
  new Intl.NumberFormat('id-ID', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
const signed = (n: number) =>
  `${n > 0 ? '+' : ''}${n.toLocaleString('id-ID', { maximumFractionDigits: 1 })}`;

/** Inline images are referenced as cid:<name>; the mail service attaches them under those ids. */
export const CHART_CIDS = [
  'mentions',
  'reach',
  'sov',
  'sentiment',
  'channels',
] as const;

/**
 * E-mail body: table layout with inline styles only, because mail clients ignore most CSS.
 * Charts are PNG attachments shown inline (cid:), so they appear without loading remote images.
 */
export function renderEmailHtml(d: ReportData, dashboardUrl: string | null) {
  const o = d.overview;
  const img = (cid: string, alt: string) =>
    `<tr><td style="padding:8px 0"><img src="cid:${cid}" alt="${esc(alt)}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:1px solid ${C.line};border-radius:10px"></td></tr>`;
  const kpi = (label: string, value: string) =>
    `<td width="25%" style="padding:12px;background:${C.surface};border-radius:10px"><div style="font-size:12px;color:${C.muted}">${label}</div><div style="font-size:20px;font-weight:700;color:${C.ink}">${value}</div></td>`;
  const pct = (n: number) => (o.total ? Math.round((n / o.total) * 100) : 0);

  let analysis: string;
  if (d.insight) {
    const urlOf = new Map(d.insight.sources.map((s) => [s.ref, s.url]));
    const ref = (n: number) => {
      const u = urlOf.get(n);
      return u
        ? `<a href="${esc(u)}" style="color:${C.violet};text-decoration:none">[${n}]</a>`
        : `[${n}]`;
    };
    analysis =
      `<p style="margin:0 0 12px;font-size:15px;font-weight:700;color:${C.ink}">${esc(d.insight.headline)}</p>` +
      d.insight.findings
        .map(
          (f, i) =>
            `<p style="margin:0 0 4px;font-size:14px;font-weight:700;color:${C.ink}">${i + 1}. ${esc(f.title)}</p>` +
            `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:${C.ink}">${esc(f.body)} ${f.refs.map(ref).join('')}</p>`,
        )
        .join('') +
      (d.insight.sources.length
        ? `<p style="margin:12px 0 4px;font-size:12px;font-weight:700;color:${C.muted}">Sumber</p>` +
          d.insight.sources
            .map(
              (s) =>
                `<p style="margin:0 0 4px;font-size:12px;color:${C.muted}">[${s.ref}] ${esc(s.author ?? '-')} · ${channelLabel(s.channel)} · ${
                  s.url
                    ? `<a href="${esc(s.url)}" style="color:${C.violet}">${esc(s.text.slice(0, 90))}</a>`
                    : esc(s.text.slice(0, 90))
                }</p>`,
            )
            .join('')
        : '');
  } else {
    analysis = `<p style="margin:0;font-size:14px;color:${C.muted}">${esc(d.insightNote ?? '-')}</p>`;
  }

  const brandRows = d.competitors.brands
    .map(
      (b) =>
        `<tr><td style="padding:6px 8px;border-bottom:1px solid ${C.line}">${esc(b.name)}${b.isOwn ? ' <span style="color:' + C.ruby + '">●</span>' : ''}</td>` +
        `<td align="right" style="padding:6px 8px;border-bottom:1px solid ${C.line}">${nf(b.total)}</td>` +
        `<td align="right" style="padding:6px 8px;border-bottom:1px solid ${C.line}">${b.sov.toLocaleString('id-ID')}%</td>` +
        `<td align="right" style="padding:6px 8px;border-bottom:1px solid ${C.line}">${signed(b.netSentiment)}</td></tr>`,
    )
    .join('');

  return `<!doctype html><html><body style="margin:0;padding:0;background:${C.surface}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.surface};font-family:'Plus Jakarta Sans',Segoe UI,Helvetica,Arial,sans-serif;color:${C.ink}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:16px">
<tr><td style="padding:24px 20px;background:${C.ink};border-radius:16px 16px 0 0">
  <div style="font-size:12px;color:#c9c6d6">Summary Report Social Listening</div>
  <div style="font-size:22px;font-weight:700;color:#ffffff">${esc(d.project.client)}</div>
  <div style="font-size:13px;color:#c9c6d6">${esc(d.periodLabel)}</div>
</td></tr>
<tr><td style="padding:20px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>
    ${kpi('Mentions', nf(o.total))}${kpi('Reach', compact(o.reach))}${kpi('Engagement', compact(o.engagements))}${kpi('Net sentiment', signed(o.netSentiment))}
  </tr></table>
  <p style="margin:8px 0 0;font-size:12px;color:${C.muted}">Positif ${pct(o.positive)}% · Netral ${pct(o.neutral)}% · Negatif ${pct(o.negative)}% · SOV brand sendiri ${d.competitors.own.sov.toLocaleString('id-ID')}%</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px">
    ${img('mentions', 'Mentions per hari')}${img('reach', 'Reach per hari')}
  </table>
  <h2 style="margin:20px 0 10px;font-size:17px">Analisis</h2>
  ${analysis}
  <h2 style="margin:20px 0 10px;font-size:17px">Perbandingan brand</h2>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${img('sov', 'Share of voice per brand')}${img('sentiment', 'Sentimen per brand')}</table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;margin-top:8px">
    <tr style="color:${C.muted}"><td style="padding:6px 8px">Brand</td><td align="right" style="padding:6px 8px">Volume</td><td align="right" style="padding:6px 8px">SOV</td><td align="right" style="padding:6px 8px">Net sentiment</td></tr>
    ${brandRows}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px">${img('channels', 'Volume per channel')}</table>
  ${
    dashboardUrl
      ? `<p style="margin:20px 0 0"><a href="${esc(dashboardUrl)}" style="display:inline-block;background:${C.ink};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 18px;border-radius:10px">Buka dashboard</a></p>`
      : ''
  }
  <p style="margin:20px 0 0;font-size:11px;color:${C.muted}">Laporan lengkap (PDF) terlampir. Angka berasal dari data social listening yang sudah diunggah; analisis dibuat AI dan bisa keliru, periksa angka penting di dashboard.</p>
</td></tr></table>
</td></tr></table></body></html>`;
}
