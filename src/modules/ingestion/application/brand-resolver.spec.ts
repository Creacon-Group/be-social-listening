import { BrandResolver } from './brand-resolver.js';

const prismaWith = (brands: { id: number; name: string; aliases: unknown }[]) =>
  ({ brand: { findMany: async () => brands } }) as never;

describe('BrandResolver', () => {
  const brands = [
    { id: 1, name: 'Indosat', aliases: ['IM3', 'Indosat Ooredoo Hutchison'] },
    {
      id: 2,
      name: 'Tri',
      aliases: ['3 Indonesia', 'Indosat Ooredoo Hutchison'],
    },
    { id: 3, name: 'XL', aliases: null },
  ];

  it('matches names and aliases exactly, ignoring case', async () => {
    const index = await new BrandResolver(prismaWith(brands)).load(1);
    expect(index.resolve(['im3', 'XL Axiata', 'xl'])).toEqual({
      brandIds: [1, 3],
      unmatched: ['XL Axiata'],
    });
  });

  it('assigns a joint keyword to every brand that lists it', async () => {
    const index = await new BrandResolver(prismaWith(brands)).load(1);
    expect(
      index.resolve(['Indosat Ooredoo Hutchison']).brandIds.sort(),
    ).toEqual([1, 2]);
  });

  it('does not match substrings', async () => {
    const index = await new BrandResolver(prismaWith(brands)).load(1);
    expect(index.resolve(['Activation Tri']).brandIds).toEqual([]);
  });
});
