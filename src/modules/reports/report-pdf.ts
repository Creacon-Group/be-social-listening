import PDFDocument from 'pdfkit';
import { C } from './charts.js';
import { channelLabel, type ReportData } from './report-data.service.js';

type Charts = Record<
  'mentions' | 'reach' | 'sov' | 'sentiment' | 'channels',
  Buffer
>;

const font = (name: string) =>
  new URL(`../../../assets/fonts/${name}`, import.meta.url).pathname;
const REGULAR = font('PlusJakartaSans_400Regular.ttf');
const BOLD = font('PlusJakartaSans_700Bold.ttf');

const nf = (n: number) => n.toLocaleString('id-ID');
const compact = (n: number) =>
  new Intl.NumberFormat('id-ID', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
const signed = (n: number) =>
  `${n > 0 ? '+' : ''}${n.toLocaleString('id-ID', { maximumFractionDigits: 1 })}`;

/** A4 summary report: KPIs, charts, AI analysis with sources, then the detail tables. */
export function renderPdf(d: ReportData, charts: Charts): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    font: REGULAR, // never load the built-in Helvetica (keeps the serverless bundle small)
    bufferPages: true,
    info: { Title: d.title, Author: 'Social Listening Dashboard' },
  });
  doc.registerFont('r', REGULAR).registerFont('b', BOLD);
  const W = doc.page.width - 80;
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) =>
    doc.on('end', () => resolve(Buffer.concat(chunks))),
  );

  const ensure = (h: number) => {
    if (doc.y + h > doc.page.height - 60) doc.addPage();
  };
  const heading = (t: string) => {
    ensure(40);
    doc.moveDown(0.6);
    doc
      .font('b')
      .fontSize(14)
      .fillColor(C.ink)
      .text(t, 40, doc.y, { width: W });
    doc.moveDown(0.3);
  };
  const chart = (img: Buffer, ratio: number) => {
    const h = W * ratio;
    ensure(h + 10);
    doc.image(img, 40, doc.y, { width: W });
    doc.y += h + 10;
  };
  const table = (
    cols: { label: string; w: number; align?: 'left' | 'right' }[],
    rows: string[][],
  ) => {
    const rowH = 18;
    const drawHeader = () => {
      let x = 40;
      const y = doc.y; // every header cell on one line (text() moves doc.y)
      doc.font('b').fontSize(8.5).fillColor(C.muted);
      for (const c of cols) {
        doc.text(c.label, x + 4, y, {
          width: c.w - 8,
          align: c.align,
          lineBreak: false,
        });
        x += c.w;
      }
      doc.y = y + rowH - 4;
      doc
        .moveTo(40, doc.y)
        .lineTo(40 + W, doc.y)
        .strokeColor(C.line)
        .stroke();
      doc.y += 4;
    };
    ensure(rowH * 3);
    drawHeader();
    for (const r of rows) {
      if (doc.y + rowH > doc.page.height - 60) {
        doc.addPage();
        drawHeader();
      }
      let x = 40;
      const y = doc.y;
      doc.font('r').fontSize(8.5).fillColor(C.ink);
      r.forEach((cell, i) => {
        doc.text(cell, x + 4, y, {
          width: cols[i].w - 8,
          align: cols[i].align,
          lineBreak: false,
          height: rowH - 6, // one line per cell; long names end with an ellipsis
          ellipsis: true,
        });
        x += cols[i].w;
      });
      doc.y = y + rowH;
    }
  };

  // Cover band
  doc.rect(0, 0, doc.page.width, 110).fill(C.ink);
  doc
    .font('r')
    .fontSize(10)
    .fillColor('#c9c6d6')
    .text('Summary Report Social Listening', 40, 30);
  doc
    .font('b')
    .fontSize(22)
    .fillColor('#ffffff')
    .text(d.project.client, 40, 46, { width: W });
  doc.font('r').fontSize(11).fillColor('#c9c6d6').text(d.periodLabel, 40, 78);
  doc.y = 130;

  // KPI tiles
  const o = d.overview;
  const kpis = [
    ['Mentions', nf(o.total)],
    ['Reach', compact(o.reach)],
    ['Engagement', compact(o.engagements)],
    ['Net sentiment', signed(o.netSentiment)],
  ];
  const tw = (W - 30) / 4;
  kpis.forEach(([label, value], i) => {
    const x = 40 + i * (tw + 10);
    doc.roundedRect(x, 130, tw, 58, 8).fill(C.surface);
    doc
      .font('r')
      .fontSize(9)
      .fillColor(C.muted)
      .text(label, x + 12, 140);
    doc
      .font('b')
      .fontSize(18)
      .fillColor(C.ink)
      .text(value, x + 12, 156, { width: tw - 24 });
  });
  doc.y = 200;
  const pct = (n: number) => (o.total ? Math.round((n / o.total) * 100) : 0);
  doc
    .font('r')
    .fontSize(9)
    .fillColor(C.muted)
    .text(
      `Positif ${nf(o.positive)} (${pct(o.positive)}%)  ·  Netral ${nf(o.neutral)} (${pct(o.neutral)}%)  ·  Negatif ${nf(o.negative)} (${pct(o.negative)}%)  ·  Share of voice brand sendiri ${d.competitors.own.sov.toLocaleString('id-ID')}%`,
      40,
      doc.y,
      { width: W },
    );
  doc.moveDown(0.8);

  chart(charts.mentions, 0.34);
  chart(charts.reach, 0.34);

  // AI analysis
  heading('Analisis');
  if (d.insight) {
    doc
      .font('b')
      .fontSize(11)
      .fillColor(C.ink)
      .text(d.insight.headline, { width: W });
    doc.moveDown(0.5);
    d.insight.findings.forEach((f, i) => {
      ensure(60);
      const refs = f.refs.length ? ` [${f.refs.join('][')}]` : '';
      doc
        .font('b')
        .fontSize(10)
        .fillColor(C.ink)
        .text(`${i + 1}. ${f.title}`, { width: W });
      doc
        .font('r')
        .fontSize(9.5)
        .fillColor(C.ink)
        .text(`${f.body}${refs}`, { width: W, lineGap: 2 });
      doc.moveDown(0.5);
    });
    if (d.insight.sources.length) {
      ensure(40);
      doc.font('b').fontSize(9).fillColor(C.muted).text('Sumber');
      for (const s of d.insight.sources) {
        ensure(26);
        doc
          .font('r')
          .fontSize(8)
          .fillColor(C.muted)
          .text(
            `[${s.ref}] ${s.author ?? '-'} · ${channelLabel(s.channel)} · "${s.text}"`,
            { width: W, link: s.url ?? undefined, underline: false },
          );
      }
    }
  } else {
    doc
      .font('r')
      .fontSize(10)
      .fillColor(C.muted)
      .text(d.insightNote ?? '-', { width: W });
  }

  doc.addPage();
  heading('Perbandingan brand');
  chart(charts.sov, (56 + d.competitors.brands.length * 38 + 16) / 1000);
  chart(charts.sentiment, (80 + d.competitors.brands.length * 38 + 16) / 1000);
  table(
    [
      { label: 'Brand', w: W * 0.28 },
      { label: 'Volume', w: W * 0.16, align: 'right' },
      { label: 'SOV', w: W * 0.14, align: 'right' },
      { label: 'Net sentiment', w: W * 0.2, align: 'right' },
      { label: 'Negatif', w: W * 0.22, align: 'right' },
    ],
    d.competitors.brands.map((b) => [
      `${b.name}${b.isOwn ? ' (brand sendiri)' : ''}`,
      nf(b.total),
      `${b.sov.toLocaleString('id-ID')}%`,
      signed(b.netSentiment),
      nf(b.negative),
    ]),
  );

  heading('Channel');
  chart(charts.channels, (56 + d.overview.channels.length * 38 + 16) / 1000);

  heading('Influencer teratas (berdasarkan reach)');
  table(
    [
      { label: 'Akun', w: W * 0.34 },
      { label: 'Channel', w: W * 0.16 },
      { label: 'Mentions', w: W * 0.14, align: 'right' },
      { label: 'Reach', w: W * 0.18, align: 'right' },
      { label: 'Engagement', w: W * 0.18, align: 'right' },
    ],
    d.influencers.map((a) => [
      a.name
        ? `${a.name} (@${a.handle.replace(/^@/, '')})`
        : `@${a.handle.replace(/^@/, '')}`,
      channelLabel(a.channel),
      nf(a.total),
      compact(a.reach),
      compact(a.engagements),
    ]),
  );

  heading('Sumber teratas');
  table(
    [
      { label: 'Situs / platform', w: W * 0.4 },
      { label: 'Mentions', w: W * 0.2, align: 'right' },
      { label: 'Reach', w: W * 0.2, align: 'right' },
      { label: 'Net sentiment', w: W * 0.2, align: 'right' },
    ],
    d.sources.map((s) => [
      s.host,
      nf(s.total),
      compact(s.reach),
      signed(s.netSentiment),
    ]),
  );

  heading('Hashtag teratas');
  table(
    [
      { label: 'Hashtag', w: W * 0.4 },
      { label: 'Mentions', w: W * 0.2, align: 'right' },
      { label: 'Engagement', w: W * 0.2, align: 'right' },
      { label: 'Net sentiment', w: W * 0.2, align: 'right' },
    ],
    d.hashtags.map((h) => [
      h.tag,
      nf(h.total),
      compact(h.engagements),
      signed(h.netSentiment),
    ]),
  );

  // Footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // writing below the margin must not open a new page
    doc
      .font('r')
      .fontSize(7.5)
      .fillColor(C.muted)
      .text(
        `${d.title}  ·  Halaman ${i + 1} dari ${range.count}`,
        40,
        doc.page.height - 34,
        { width: W, align: 'center', lineBreak: false },
      );
  }
  doc.end();
  return done;
}
