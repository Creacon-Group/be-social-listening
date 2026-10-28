import { Prisma } from '../../generated/prisma/client.js';

/** Trim, drop empties and case-insensitive duplicates, keep the first spelling. */
export function cleanList(values: string[] | undefined, maxLen: number) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values ?? []) {
    const v = raw.trim().replace(/\s+/g, ' ').slice(0, maxLen);
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One regular expression for all keywords, matching whole words only, so "tri" does not
 * match "strike". POSIX classes instead of \b: they work the same in MySQL (ICU) and TiDB (RE2).
 */
export function keywordPattern(keywords: string[]): string | null {
  if (!keywords.length) return null;
  return `(^|[^[:alnum:]_])(${keywords.map(escapeRegex).join('|')})($|[^[:alnum:]_])`;
}

/** SQL condition: the mention carries one of the Zanroo tags/categories, or its text has a keyword. */
export function ruleCondition(rule: {
  zanrooTags: string[];
  keywords: string[];
}): Prisma.Sql | null {
  const parts: Prisma.Sql[] = [];
  if (rule.zanrooTags.length) {
    const tags = JSON.stringify(rule.zanrooTags);
    parts.push(Prisma.sql`JSON_OVERLAPS(m.tags, CAST(${tags} AS JSON))`);
    parts.push(
      Prisma.sql`JSON_OVERLAPS(JSON_EXTRACT(m.extra, '$.categories'), CAST(${tags} AS JSON))`,
    );
  }
  const pattern = keywordPattern(rule.keywords);
  if (pattern)
    parts.push(
      Prisma.sql`REGEXP_LIKE(CONCAT_WS(' ', m.title, m.content), ${pattern}, 'i')`,
    );
  return parts.length ? Prisma.sql`(${Prisma.join(parts, ' OR ')})` : null;
}

export const asStringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
