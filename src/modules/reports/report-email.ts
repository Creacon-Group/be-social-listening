import { C } from './charts.js';
import { channelLabel, type ReportData } from './report-data.service.js';

const esc = (s: string) =>
  s.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!,
  );
const nf = (n: number) => n.toLocaleString('en-GB');
const compact = (n: number) =>
  new Intl.NumberFormat('en-GB', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
const signed = (n: number) =>
  `${n > 0 ? '+' : ''}${n.toLocaleString('en-GB', { maximumFractionDigits: 1 })}`;

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";

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
    `<tr><td style="padding:6px 0"><img src="cid:${cid}" alt="${esc(alt)}" width="584" style="display:block;width:100%;max-width:584px;height:auto;border:1px solid ${C.line};border-radius:12px"></td></tr>`;
  const kpi = (label: string, value: string) =>
    `<td width="25%" style="padding:12px 14px;background:${C.surface};border-radius:12px"><div style="font-size:12px;color:${C.muted}">${label}</div><div style="margin-top:4px;font-size:22px;font-weight:600;letter-spacing:-0.5px;color:${C.ink}">${value}</div></td>`;
  const pct = (n: number) => (o.total ? Math.round((n / o.total) * 100) : 0);

  let analysis: string;
  if (d.insight) {
    const urlOf = new Map(d.insight.sources.map((s) => [s.ref, s.url]));
    const ref = (n: number) => {
      const u = urlOf.get(n);
      return u
        ? `<a href="${esc(u)}" style="color:${C.accent};text-decoration:none;font-weight:600">[${n}]</a>`
        : `[${n}]`;
    };
    analysis =
      `<p style="margin:0 0 14px;font-size:16px;line-height:1.4;font-weight:600;letter-spacing:-0.2px;color:${C.ink}">${esc(d.insight.headline)}</p>` +
      d.insight.findings
        .map(
          (f, i) =>
            `<p style="margin:0 0 4px;font-size:14px;font-weight:600;color:${C.ink}">${i + 1}. ${esc(f.title)}</p>` +
            `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:${C.ink}">${esc(f.body)} ${f.refs.map(ref).join('')}</p>`,
        )
        .join('') +
      (d.insight.sources.length
        ? `<p style="margin:16px 0 6px;font-size:12px;font-weight:600;color:${C.muted}">Sources</p>` +
          d.insight.sources
            .map(
              (s) =>
                `<p style="margin:0 0 4px;font-size:12px;color:${C.muted}">[${s.ref}] ${esc(s.author ?? '-')}, ${channelLabel(s.channel)}: ${
                  s.url
                    ? `<a href="${esc(s.url)}" style="color:${C.accent};text-decoration:none">${esc(s.text.slice(0, 90))}</a>`
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
        `<tr><td style="padding:8px;border-bottom:1px solid ${C.line}">${b.isOwn ? `<span style="background:${C.accentSoft};padding:1px 5px;border-radius:4px;font-weight:600">${esc(b.name)}</span>` : esc(b.name)}</td>` +
        `<td align="right" style="padding:8px;border-bottom:1px solid ${C.line}">${nf(b.total)}</td>` +
        `<td align="right" style="padding:8px;border-bottom:1px solid ${C.line}">${b.sov.toLocaleString('en-GB')}%</td>` +
        `<td align="right" style="padding:8px;border-bottom:1px solid ${C.line}">${signed(b.netSentiment)}</td></tr>`,
    )
    .join('');

  return `<!doctype html><html><head><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"></head><body style="margin:0;padding:0;background:${C.surface}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.surface};font-family:${FONT_STACK};color:${C.ink};-webkit-font-smoothing:antialiased">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">
<tr><td style="padding:0 4px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="width:26px;vertical-align:middle"><img src="cid:logo" alt="Creacon" width="22" height="22" style="display:block;width:22px;height:22px"></td>
    <td style="vertical-align:middle;padding-left:8px;font-size:13px;line-height:1.2"><span style="font-weight:600;color:${C.ink}">Social Listening</span> <span style="color:${C.muted}">by Creacon</span></td>
    <td align="right" style="vertical-align:middle;font-size:12px;color:${C.muted}">Summary report</td>
  </tr></table>
</td></tr>
<tr><td style="background:#ffffff;border-radius:16px;padding:28px 28px 24px">
  <div style="font-size:26px;line-height:1.15;font-weight:600;letter-spacing:-0.6px;color:${C.ink}">${esc(d.project.client)}</div>
  <div style="margin-top:6px;font-size:14px;color:${C.muted}">${esc(d.periodLabel)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin-top:14px"><tr>
    ${kpi('Mentions', nf(o.total))}${kpi('Reach', compact(o.reach))}${kpi('Engagement', compact(o.engagements))}${kpi('Net sentiment', signed(o.netSentiment))}
  </tr></table>
  <p style="margin:10px 0 0;font-size:13px;line-height:1.5;color:${C.muted}">Positive ${pct(o.positive)}%, neutral ${pct(o.neutral)}%, negative ${pct(o.negative)}%. Own brands hold <span style="color:${C.ink};font-weight:600">${d.competitors.own.sov.toLocaleString('en-GB')}%</span> share of voice.</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px">
    ${img('mentions', 'Mentions per day')}${img('reach', 'Reach per day')}
  </table>
  <h2 style="margin:26px 0 10px;font-size:18px;font-weight:600;letter-spacing:-0.3px">Analysis</h2>
  ${analysis}
  <h2 style="margin:26px 0 10px;font-size:18px;font-weight:600;letter-spacing:-0.3px">Brand comparison</h2>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${img('sov', 'Share of voice per brand')}${img('sentiment', 'Sentiment per brand')}</table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;margin-top:10px;font-variant-numeric:tabular-nums">
    <tr style="color:${C.muted};font-size:12px"><td style="padding:8px;border-bottom:1px solid ${C.line}">Brand</td><td align="right" style="padding:8px;border-bottom:1px solid ${C.line}">Volume</td><td align="right" style="padding:8px;border-bottom:1px solid ${C.line}">SOV</td><td align="right" style="padding:8px;border-bottom:1px solid ${C.line}">Net sentiment</td></tr>
    ${brandRows}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px">${img('channels', 'Volume per channel')}</table>
  ${
    dashboardUrl
      ? `<p style="margin:24px 0 0"><a href="${esc(dashboardUrl)}" style="display:inline-block;background:${C.ink};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:10px">Open the dashboard</a></p>`
      : ''
  }
</td></tr>
<tr><td style="padding:16px 8px 0;font-size:11px;line-height:1.5;color:${C.muted}">The full report is attached as a PDF. Numbers come from the uploaded social listening data. The analysis is written by AI and can be wrong, so check key numbers in the dashboard.</td></tr>
</table>
</td></tr></table></body></html>`;
}
