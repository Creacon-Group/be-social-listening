import { describe, expect, it } from 'vitest';
import {
  buildResults,
  type Entity,
  findMentions,
  normalizedPosition,
  numberedLists,
  parseEvaluatorJson,
  positions,
} from './geo-evaluator.js';
import { brandKpis, groupKpis, type ResponseRow } from './geo-metrics.js';
import { citationDomain, classify, parseCompletion } from './sumopod.client.js';
import { looksEnglish } from './geo.service.js';

const IOH: Entity = {
  isTarget: true,
  brandId: null,
  name: 'IOH',
  aliases: ['Indosat', 'IM3', 'Tri', '3 Indonesia'],
};
const TSEL: Entity = {
  isTarget: false,
  brandId: 3,
  name: 'Telkomsel',
  aliases: ['by.U', 'simPATI'],
};
const XL: Entity = {
  isTarget: false,
  brandId: 4,
  name: 'XL',
  aliases: ['XL Axiata', 'Axis'],
};
const ALL = [IOH, TSEL, XL];

// Hand-labelled answers in the shape both models returned in the SumoPod test.
const RANKED = `Berikut rekomendasi operator untuk gaming:

1. **Telkomsel** – jaringan paling luas, ping stabil di luar kota.
   - Lebih mahal dibanding XL.
2. **Indosat (IM3)** – kuota besar dan harga bersaing di kota besar.
3. **XL Axiata** – cocok untuk pengguna Axis.

Kesimpulan: pilih Telkomsel kalau sering bepergian.`;

const PROSE = `Telkomsel adalah pilihan paling aman. Indosat juga bagus di kota besar, tetapi XL kurang stabil.`;

describe('mention detection', () => {
  it('matches whole words only, in any case', () => {
    expect(findMentions('Pakai TRI atau tri, bukan strip', IOH)).toEqual([
      'TRI',
      'tri',
    ]);
    expect(findMentions('strip dan trigger', IOH)).toEqual([]);
    expect(findMentions('Paket by.U murah', TSEL)).toEqual(['by.U']);
  });
});

describe('position', () => {
  it('ranks from the item heading of a numbered list', () => {
    expect(numberedLists(RANKED)).toHaveLength(1);
    const p = positions(RANKED, ALL);
    expect(p.get(TSEL)).toEqual({ position: 1, listSize: 3 });
    expect(p.get(IOH)).toEqual({ position: 2, listSize: 3 });
    expect(p.get(XL)).toEqual({ position: 3, listSize: 3 }); // not 1, though XL is in item 1's sub-bullet
  });

  it('never infers a rank from prose', () => {
    expect(positions(PROSE, ALL).size).toBe(0);
  });

  it('normalises: first = 100, last = 0, single item = N/A', () => {
    expect(normalizedPosition(1, 3)).toBe(100);
    expect(normalizedPosition(3, 3)).toBe(0);
    expect(normalizedPosition(2, 3)).toBe(50);
    expect(normalizedPosition(1, 1)).toBeNull();
    expect(normalizedPosition(null, 3)).toBeNull();
  });
});

describe('recommendation classification', () => {
  const reply = `\`\`\`json
{"brands":[
 {"name":"Telkomsel","recommendation":"RECOMMENDED","sentiment":"positive","evidence":"pilih Telkomsel kalau sering bepergian"},
 {"name":"IOH","recommendation":"POSITIVE","sentiment":"positive","evidence":"kuota besar dan harga bersaing"},
 {"name":"XL","recommendation":"RECOMMENDED","sentiment":"positive","evidence":"XL is the best network in Asia"}
]}
\`\`\``;

  it('keeps judgements whose evidence is in the answer and downgrades the rest', () => {
    const r = buildResults(RANKED, ALL, parseEvaluatorJson(reply));
    const by = (n: string) => r.find((x) => x.name === n)!;
    expect(by('Telkomsel')).toMatchObject({
      mentioned: true,
      recommendation: 'RECOMMENDED',
      position: 1,
    });
    expect(by('IOH')).toMatchObject({
      mentioned: true,
      recommendation: 'POSITIVE',
      position: 2,
      matches: ['Indosat', 'IM3'],
    });
    expect(by('XL')).toMatchObject({
      mentioned: true,
      recommendation: 'UNCLEAR',
      evidence: null,
    }); // invented quote
  });

  it('marks brands that are not named as NOT_MENTIONED without asking the model', () => {
    const r = buildResults('Gunakan WiFi rumah saja.', ALL, null);
    expect(
      r.every((x) => x.recommendation === 'NOT_MENTIONED' && !x.mentioned),
    ).toBe(true);
  });

  it('treats an unreadable evaluator reply as UNCLEAR', () => {
    expect(parseEvaluatorJson('sorry, cannot help')).toBeNull();
    const r = buildResults(PROSE, ALL, null);
    expect(r.find((x) => x.isTarget)).toMatchObject({
      mentioned: true,
      recommendation: 'UNCLEAR',
    });
  });
});

describe('KPIs', () => {
  const row = (
    runId: number,
    target: Partial<ResponseRow['results'][0]>,
    comp: Partial<ResponseRow['results'][0]>,
    citations: ResponseRow['citations'] = [],
  ): ResponseRow => ({
    runId,
    model: 'gemini',
    mode: 'SEARCH',
    citationsSupported: true,
    citations,
    results: [
      {
        isTarget: true,
        brandId: null,
        name: 'IOH',
        mentioned: false,
        recommendation: 'NOT_MENTIONED',
        position: null,
        listSize: null,
        sentiment: null,
        ...target,
      },
      {
        isTarget: false,
        brandId: 3,
        name: 'Telkomsel',
        mentioned: false,
        recommendation: 'NOT_MENTIONED',
        position: null,
        listSize: null,
        sentiment: null,
        ...comp,
      },
    ],
  });
  const rows = [
    row(
      1,
      {
        mentioned: true,
        recommendation: 'RECOMMENDED',
        position: 1,
        listSize: 3,
        sentiment: 'positive',
      },
      { mentioned: true, recommendation: 'NEUTRAL', position: 2, listSize: 3 },
      [{ domain: 'im3.id', ownedBy: 'TARGET' }],
    ),
    row(
      2,
      { mentioned: true, recommendation: 'POSITIVE', sentiment: 'positive' },
      { mentioned: true, recommendation: 'RECOMMENDED' },
    ),
    row(3, {}, { mentioned: true, recommendation: 'RECOMMENDED' }, [
      { domain: 'opensignal.com', ownedBy: null },
    ]),
    row(4, {}, {}),
  ];

  it('computes mention, recommendation, position and SoV for the target', () => {
    const k = groupKpis(rows);
    expect(k.validResponses).toBe(4);
    expect(k.mentionRate).toBe(50);
    expect(k.recommendationRate).toBe(25); // a positive mention is not a recommendation
    expect(k.avgPosition).toBe(1);
    expect(k.normalizedPosition).toBe(100);
    expect(k.sov).toBe(40); // 2 of 5 brand mentions
    expect(k.anyCitationRate).toBe(50);
    expect(k.ownedCitationRate).toBe(25);
  });

  it('reports citations as unavailable, not 0%, when the model cannot cite', () => {
    const k = groupKpis(
      rows.map((r) => ({ ...r, citationsSupported: false, citations: [] })),
    );
    expect(k.anyCitationRate).toBeNull();
    expect(k.ownedCitationRate).toBeNull();
  });

  it('ranks competitors with the same rules', () => {
    const t = brandKpis(rows).find((b) => b.name === 'Telkomsel')!;
    expect(t).toMatchObject({
      mentionRate: 75,
      recommendationRate: 50,
      avgPosition: 2,
      sov: 60,
    });
  });
});

describe('SumoPod parsing', () => {
  it('reads text, usage and Gemini grounding citations (domain from the title)', () => {
    const c = parseCompletion(
      {
        id: 'chatcmpl-1',
        choices: [
          {
            message: {
              content: 'Jawaban',
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: {
                    title: 'opensignal.com',
                    url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
                    start_index: 3,
                    end_index: 9,
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 21,
          completion_tokens: 600,
          completion_tokens_details: { reasoning_tokens: 500 },
        },
      },
      120,
    );
    expect(c).toMatchObject({
      text: 'Jawaban',
      promptTokens: 21,
      completionTokens: 600,
      reasoningTokens: 500,
      requestId: 'chatcmpl-1',
    });
    expect(c.citations).toEqual([
      {
        domain: 'opensignal.com',
        url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
        startIndex: 3,
        endIndex: 9,
      },
    ]);
  });

  it('fails an empty answer (all tokens spent on reasoning) as retryable', () => {
    expect(() =>
      parseCompletion({ choices: [{ message: { content: '' } }] }, 1),
    ).toThrow(/no answer text/);
  });

  it('classifies provider errors', () => {
    expect(
      classify(403, {
        error: { type: 'key_model_access_denied', message: 'no access' },
      }),
    ).toMatchObject({ type: 'invalid_model', retryable: false });
    expect(classify(429, {})).toMatchObject({
      type: 'rate_limit',
      retryable: true,
    });
    expect(classify(502, {})).toMatchObject({
      type: 'provider_error',
      retryable: true,
    });
    expect(classify(401, {})).toMatchObject({ type: 'auth', retryable: false });
  });

  it('falls back to the URL host for the domain', () => {
    expect(citationDomain('Some page', 'https://www.tri.co.id/paket')).toBe(
      'tri.co.id',
    );
  });
});

describe('suggestion language check', () => {
  it('flags English questions and keeps Indonesian ones', () => {
    expect(
      looksEnglish(
        'What are the main cellular network operators providing mobile data plans in Indonesia?',
      ),
    ).toBe(true);
    expect(
      looksEnglish(
        'Which telecommunications providers offer prepaid SIM cards with high-speed internet in Indonesia?',
      ),
    ).toBe(true);
    expect(
      looksEnglish(
        'Operator seluler apa yang paling stabil buat main game online?',
      ),
    ).toBe(false);
    expect(
      looksEnglish('Bandingkan IM3 dan Telkomsel untuk streaming video.'),
    ).toBe(false);
  });
});
