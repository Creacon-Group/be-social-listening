import ExcelJS from 'exceljs';
import { PrismaService } from '../../database/prisma.service.js';
import type { ResolvedFilter } from '../mentions/mention-filter.js';
import { channelLabel, type ReportData } from './report-data.service.js';

const SENTIMENT: Record<string, string> = {
  POSITIVE: 'Positive',
  NEUTRAL: 'Neutral',
  NEGATIVE: 'Negative',
};
const MAX_MENTION_ROWS = 20_000;

function sheet(
  wb: ExcelJS.Workbook,
  name: string,
  columns: { header: string; key: string; width: number; numFmt?: string }[],
  rows: Record<string, unknown>[],
) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width,
    style: c.numFmt ? { numFmt: c.numFmt } : {},
  }));
  ws.getRow(1).font = { bold: true };
  ws.addRows(rows);
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };
  return ws;
}

/** Underlying numbers for analysis: one sheet per report section plus the raw mentions. */
export async function renderExcel(
  d: ReportData,
  prisma: PrismaService,
  f: ResolvedFilter,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Social Listening Dashboard';
  const o = d.overview;

  const sum = wb.addWorksheet('Summary');
  sum.columns = [
    { key: 'k', width: 34 },
    { key: 'v', width: 60 },
  ];
  sum.addRows([
    { k: 'Report', v: d.title },
    { k: 'Period (WIB)', v: `${d.period.from} to ${d.period.to}` },
    { k: 'Mentions', v: o.total },
    { k: 'Positive', v: o.positive },
    { k: 'Neutral', v: o.neutral },
    { k: 'Negative', v: o.negative },
    { k: 'Net sentiment (-100 to +100)', v: o.netSentiment },
    { k: 'Reach', v: o.reach },
    { k: 'Engagement', v: o.engagements },
    { k: 'Own-brand share of voice (%)', v: d.competitors.own.sov },
  ]);
  sum.getColumn('k').font = { bold: true };
  if (d.insight) {
    sum.addRow({});
    sum.addRow({ k: 'AI analysis', v: d.insight.headline });
    d.insight.findings.forEach((fd, i) =>
      sum.addRow({
        k: `${i + 1}. ${fd.title}`,
        v: `${fd.body}${fd.refs.length ? ` [${fd.refs.join('][')}]` : ''}`,
      }),
    );
    for (const s of d.insight.sources)
      sum.addRow({ k: `[${s.ref}] ${s.author ?? '-'}`, v: s.url ?? s.text });
    sum.getColumn('v').alignment = { wrapText: true, vertical: 'top' };
  }

  sheet(
    wb,
    'Daily trend',
    [
      { header: 'Date', key: 'day', width: 12 },
      { header: 'Mentions', key: 'total', width: 12 },
      { header: 'Positive', key: 'positive', width: 10 },
      { header: 'Neutral', key: 'neutral', width: 10 },
      { header: 'Negative', key: 'negative', width: 10 },
      { header: 'Reach', key: 'reach', width: 14, numFmt: '#,##0' },
      { header: 'Engagement', key: 'engagements', width: 14, numFmt: '#,##0' },
    ],
    d.trend,
  );
  sheet(
    wb,
    'Brand',
    [
      { header: 'Brand', key: 'name', width: 18 },
      { header: 'Own brand', key: 'own', width: 14 },
      { header: 'Volume', key: 'total', width: 10 },
      { header: 'SOV (%)', key: 'sov', width: 10 },
      { header: 'Positive', key: 'positive', width: 10 },
      { header: 'Neutral', key: 'neutral', width: 10 },
      { header: 'Negative', key: 'negative', width: 10 },
      { header: 'Net sentiment', key: 'netSentiment', width: 14 },
      { header: 'Ratio to own brand', key: 'ratioToOwn', width: 22 },
    ],
    d.competitors.brands.map((b) => ({ ...b, own: b.isOwn ? 'Yes' : 'No' })),
  );
  sheet(
    wb,
    'Channel',
    [
      { header: 'Channel', key: 'channel', width: 16 },
      { header: 'Mentions', key: 'total', width: 10 },
      { header: 'Positive', key: 'positive', width: 10 },
      { header: 'Neutral', key: 'neutral', width: 10 },
      { header: 'Negative', key: 'negative', width: 10 },
      { header: 'Net sentiment', key: 'netSentiment', width: 14 },
    ],
    o.channels.map((c) => ({ ...c, channel: channelLabel(c.channel) })),
  );
  sheet(
    wb,
    'Influencer',
    [
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Account', key: 'handle', width: 24 },
      { header: 'Channel', key: 'channel', width: 12 },
      { header: 'Followers', key: 'followers', width: 12, numFmt: '#,##0' },
      { header: 'Mentions', key: 'total', width: 10 },
      { header: 'Reach', key: 'reach', width: 14, numFmt: '#,##0' },
      { header: 'Engagement', key: 'engagements', width: 14, numFmt: '#,##0' },
      { header: 'Net sentiment', key: 'netSentiment', width: 14 },
      { header: 'Profile', key: 'userLink', width: 40 },
    ],
    d.influencers.map((a) => ({ ...a, channel: channelLabel(a.channel) })),
  );
  sheet(
    wb,
    'Sources',
    [
      { header: 'Site or platform', key: 'host', width: 30 },
      { header: 'Mentions', key: 'total', width: 10 },
      { header: 'Reach', key: 'reach', width: 14, numFmt: '#,##0' },
      { header: 'Engagement', key: 'engagements', width: 14, numFmt: '#,##0' },
      { header: 'Net sentiment', key: 'netSentiment', width: 14 },
    ],
    d.sources,
  );
  sheet(
    wb,
    'Hashtag',
    [
      { header: 'Hashtag', key: 'tag', width: 30 },
      { header: 'Mentions', key: 'total', width: 10 },
      { header: 'Engagement', key: 'engagements', width: 14, numFmt: '#,##0' },
      { header: 'Reach', key: 'reach', width: 14, numFmt: '#,##0' },
      { header: 'Net sentiment', key: 'netSentiment', width: 14 },
      { header: 'Top channel', key: 'topChannel', width: 18 },
    ],
    d.hashtags.map((h) => ({
      ...h,
      topChannel: h.topChannel ? channelLabel(h.topChannel) : '',
    })),
  );

  const mentions = await prisma.mention.findMany({
    where: {
      projectId: f.projectId,
      publishedAt: { gte: f.from, lt: f.to },
      ...(f.channels && { channel: { in: f.channels } }),
      ...(f.sentiments && { sentimentLabel: { in: f.sentiments } }),
      ...(f.brandIds && { brands: { some: { brandId: { in: f.brandIds } } } }),
    },
    orderBy: { publishedAt: 'desc' },
    take: MAX_MENTION_ROWS,
    select: {
      publishedAt: true,
      channel: true,
      postType: true,
      authorName: true,
      authorHandle: true,
      title: true,
      content: true,
      sentimentLabel: true,
      reach: true,
      engagements: true,
      url: true,
      brands: { select: { brand: { select: { name: true } } } },
    },
  });
  const ms = sheet(
    wb,
    'Mentions',
    [
      {
        header: 'Time (UTC)',
        key: 'publishedAt',
        width: 20,
        numFmt: 'yyyy-mm-dd hh:mm',
      },
      { header: 'Channel', key: 'channel', width: 12 },
      { header: 'Type', key: 'postType', width: 12 },
      { header: 'Author', key: 'author', width: 24 },
      { header: 'Brand', key: 'brands', width: 20 },
      { header: 'Sentiment', key: 'sentiment', width: 10 },
      { header: 'Reach', key: 'reach', width: 12, numFmt: '#,##0' },
      { header: 'Engagement', key: 'engagements', width: 12, numFmt: '#,##0' },
      { header: 'Content', key: 'content', width: 80 },
      { header: 'Link', key: 'url', width: 40 },
    ],
    mentions.map((m) => ({
      publishedAt: m.publishedAt,
      channel: channelLabel(m.channel),
      postType: m.postType,
      author: m.authorName ?? m.authorHandle,
      brands: m.brands.map((b) => b.brand.name).join(', '),
      sentiment: SENTIMENT[m.sentimentLabel],
      reach: m.reach,
      engagements: m.engagements,
      content: (m.title ? `${m.title}\n` : '') + (m.content ?? ''),
      url: m.url,
    })),
  );
  if (mentions.length === MAX_MENTION_ROWS)
    ms.addRow({
      content: `Limited to the latest ${MAX_MENTION_ROWS.toLocaleString('en-GB')} mentions. Narrow the filters to get every row.`,
    });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
