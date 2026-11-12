/** Match key for a Zanroo keyword: trimmed, lowercased, at most 191 chars (index limit). */
export const keywordKey = (k: string) => k.trim().slice(0, 191).toLowerCase();

/** Keys a brand matches: its name and every alias. */
export function brandKeys(brand: { name: string; aliases: unknown }) {
  const aliases = Array.isArray(brand.aliases)
    ? (brand.aliases as unknown[]).filter(
        (a): a is string => typeof a === 'string',
      )
    : [];
  return [...new Set([brand.name, ...aliases].map(keywordKey).filter(Boolean))];
}

export const ignoredSet = (v: unknown) =>
  new Set(
    Array.isArray(v)
      ? v.filter((k): k is string => typeof k === 'string').map(keywordKey)
      : [],
  );
