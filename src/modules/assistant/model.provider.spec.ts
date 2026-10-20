import { APICallError, streamText } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { isCapacityError, ModelProvider } from './model.provider.js';

const highDemand = () =>
  new APICallError({
    message:
      'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
    url: 'https://generativelanguage.googleapis.com',
    requestBodyValues: {},
    statusCode: 503,
    isRetryable: true,
  });

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that streams a few words, then optionally fails like Gemini under load. */
const mockModel = (id: string, text: string, failMidStream: boolean) =>
  new MockLanguageModelV4({
    modelId: id,
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: text },
        ...(failMidStream
          ? [{ type: 'error' as const, error: highDemand() }]
          : [
              { type: 'text-end' as const, id: 't' },
              {
                type: 'finish' as const,
                finishReason: { unified: 'stop' as const, raw: 'STOP' },
                usage,
              },
            ]),
      ]),
    }),
  });

const providerWith = (models: Record<string, MockLanguageModelV4>) => {
  const config = {
    get: (k: string) =>
      ({
        GEMINI_API_KEY: 'test',
        GEMINI_MODEL: 'primary',
        GEMINI_FALLBACK_MODEL: 'fallback',
      })[k],
  };
  const provider = new ModelProvider(config as never);
  // Swap the real Google models for mocks.
  (provider as unknown as { build: (id: string) => unknown }).build = (id) =>
    models[id];
  return provider;
};

describe('isCapacityError', () => {
  it('recognises Gemini overload errors', () => {
    expect(isCapacityError(highDemand())).toBe(true);
    expect(isCapacityError(new Error('Invalid API key'))).toBe(false);
  });
});

describe('ModelProvider fallback', () => {
  it('reruns the step on the fallback model when the primary fails mid-answer', async () => {
    const provider = providerWith({
      primary: mockModel('primary', 'Ringkasan ', true),
      fallback: mockModel('fallback', 'Jawaban lengkap.', false),
    });
    const result = streamText({
      model: provider.get(),
      prompt: 'halo',
      streamRetries: 1,
      onError: ({ error }) => provider.reportError(error),
    });
    expect(await result.text).toBe('Jawaban lengkap.');
    expect(provider.id).toBe('fallback');
  });
});
