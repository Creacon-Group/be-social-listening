import { barChart, lineChart, toPng } from './charts.js';
import { rangeLabel } from './report-data.service.js';

describe('rangeLabel', () => {
  it('formats WIB date ranges in Indonesian', () => {
    expect(rangeLabel('2026-09-01', '2026-09-30')).toBe('1–30 September 2026');
    expect(rangeLabel('2026-08-28', '2026-09-03')).toBe(
      '28 Agustus – 3 September 2026',
    );
    expect(rangeLabel('2025-12-28', '2026-01-03')).toBe(
      '28 Desember 2025 – 3 Januari 2026',
    );
    expect(rangeLabel('2026-09-30', '2026-09-30')).toBe('30 September 2026');
  });
});

describe('report charts', () => {
  it('renders SVG charts to PNG with the bundled font', async () => {
    const svg = lineChart({
      title: 'Mentions per hari',
      points: [
        { day: '2026-09-01', value: 10 },
        { day: '2026-09-02', value: 25 },
      ],
      color: '#e11d48',
    });
    const png = await toPng(svg, 1000);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.length).toBeGreaterThan(5_000);
    const bars = barChart({
      title: 'SOV',
      rows: [{ label: 'Indosat <&>', value: 1, color: '#000', display: '1%' }],
    });
    expect(bars).toContain('Indosat &lt;&amp;&gt;'); // labels are escaped
  });
});
