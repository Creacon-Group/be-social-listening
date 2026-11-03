/**
 * GEO KPIs (PRD section 6), computed from valid responses only. Each tracked brand counts at most
 * once per response. Values are 0..100 or null when there is nothing to measure.
 */
import { normalizedPosition } from './geo-evaluator.js';

export interface ResultRow {
  isTarget: boolean;
  brandId: number | null;
  name: string;
  mentioned: boolean;
  recommendation: string;
  position: number | null;
  listSize: number | null;
  sentiment: string | null;
}

export interface ResponseRow {
  runId: number;
  model: string;
  mode: 'KNOWLEDGE' | 'SEARCH';
  citationsSupported: boolean;
  citations: { domain: string; ownedBy: string | null }[];
  results: ResultRow[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const rate = (part: number, whole: number) =>
  whole ? round1((part / whole) * 100) : null;
const avg = (xs: number[]) =>
  xs.length ? round1(xs.reduce((s, x) => s + x, 0) / xs.length) : null;

export interface BrandKpi {
  isTarget: boolean;
  brandId: number | null;
  name: string;
  mentions: number;
  mentionRate: number | null;
  recommendations: number;
  recommendationRate: number | null;
  avgPosition: number | null;
  normalizedPosition: number | null;
  rankedResponses: number;
  sov: number | null;
}

/** Per-brand KPIs over a set of responses (one model x mode). */
export function brandKpis(rows: ResponseRow[]): BrandKpi[] {
  const byKey = new Map<string, ResultRow[]>();
  for (const r of rows)
    for (const b of r.results) {
      const k = b.isTarget ? 'target' : `b${b.brandId}`;
      byKey.set(k, [...(byKey.get(k) ?? []), b]);
    }
  const totalMentions = [...byKey.values()].reduce(
    (s, list) => s + list.filter((b) => b.mentioned).length,
    0,
  );
  return [...byKey.values()]
    .map((list) => {
      const mentions = list.filter((b) => b.mentioned).length;
      const recs = list.filter(
        (b) => b.recommendation === 'RECOMMENDED',
      ).length;
      const ranked = list.filter((b) => b.position !== null);
      const norm = ranked
        .map((b) => normalizedPosition(b.position, b.listSize))
        .filter((x): x is number => x !== null);
      return {
        isTarget: list[0].isTarget,
        brandId: list[0].brandId,
        name: list[0].name,
        mentions,
        mentionRate: rate(mentions, rows.length),
        recommendations: recs,
        recommendationRate: rate(recs, rows.length),
        avgPosition: avg(ranked.map((b) => b.position!)),
        normalizedPosition: avg(norm),
        rankedResponses: ranked.length,
        sov: rate(mentions, totalMentions),
      };
    })
    .sort(
      (a, b) =>
        Number(b.isTarget) - Number(a.isTarget) || b.mentions - a.mentions,
    );
}

/** Headline KPIs for the target brand in one model x mode, with sample size and citation coverage. */
export function groupKpis(rows: ResponseRow[]) {
  const brands = brandKpis(rows);
  const target = brands.find((b) => b.isTarget);
  const supported = rows.length > 0 && rows.every((r) => r.citationsSupported);
  const withAny = rows.filter((r) => r.citations.length > 0).length;
  const withOwned = rows.filter((r) =>
    r.citations.some((c) => c.ownedBy === 'TARGET'),
  ).length;
  const sentiments: Record<string, number> = {};
  for (const r of rows) {
    const t = r.results.find((b) => b.isTarget);
    if (t?.mentioned)
      sentiments[t.sentiment ?? 'unknown'] =
        (sentiments[t.sentiment ?? 'unknown'] ?? 0) + 1;
  }
  return {
    validResponses: rows.length,
    mentionRate: target?.mentionRate ?? null,
    recommendationRate: target?.recommendationRate ?? null,
    avgPosition: target?.avgPosition ?? null,
    normalizedPosition: target?.normalizedPosition ?? null,
    rankedResponses: target?.rankedResponses ?? 0,
    sov: target?.sov ?? null,
    // null = the model/mode does not return citations ("Unavailable"), not 0%
    anyCitationRate: supported ? rate(withAny, rows.length) : null,
    ownedCitationRate: supported ? rate(withOwned, rows.length) : null,
    sentiment: sentiments,
    brands,
  };
}

/** Cited domains with counts, owned ones flagged. */
export function topDomains(rows: ResponseRow[], limit = 20) {
  const m = new Map<
    string,
    {
      domain: string;
      citations: number;
      responses: number;
      ownedBy: string | null;
    }
  >();
  for (const r of rows) {
    const seen = new Set<string>();
    for (const c of r.citations) {
      const d = m.get(c.domain) ?? {
        domain: c.domain,
        citations: 0,
        responses: 0,
        ownedBy: c.ownedBy,
      };
      d.citations++;
      if (!seen.has(c.domain)) d.responses++;
      seen.add(c.domain);
      m.set(c.domain, d);
    }
  }
  return [...m.values()]
    .sort((a, b) => b.responses - a.responses || b.citations - a.citations)
    .slice(0, limit);
}
