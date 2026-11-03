import { describe, expect, it, vi } from 'vitest';
import { buildTools } from './assistant-tools.js';

describe('assistant tools', () => {
  it('offers get_ai_visibility and passes the dashboard filter and brand', async () => {
    const aiVisibility = vi.fn().mockResolvedValue({ available: true });
    const tools = buildTools(
      { projectId: 7, filter: { range: '30d' }, brands: [] },
      {
        overview: vi.fn(),
        competitors: vi.fn(),
        sample: vi.fn(),
        aiVisibility,
      },
    );
    expect(Object.keys(tools)).toContain('get_ai_visibility');
    const out = await tools.get_ai_visibility.execute!({ brand: 'Telkomsel' }, {
      toolCallId: 't1',
      messages: [],
    } as never);
    expect(out).toEqual({ available: true });
    expect(aiVisibility).toHaveBeenCalledWith(
      7,
      { range: '30d' },
      { brand: 'Telkomsel' },
    );
  });

  it('returns an error object instead of throwing', async () => {
    const tools = buildTools(
      { projectId: 1, filter: {}, brands: [] },
      {
        overview: vi.fn(),
        competitors: vi.fn(),
        sample: vi.fn(),
        aiVisibility: vi.fn().mockRejectedValue(new Error('db down')),
      },
    );
    await expect(
      tools.get_ai_visibility.execute!({}, {
        toolCallId: 't2',
        messages: [],
      } as never),
    ).resolves.toEqual({ error: 'db down' });
  });
});
