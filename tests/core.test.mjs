import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  inHourRange, filterRecords, groupBins, hourLabel,
  approximateTime, csvEncode, nearestOnLines,
} from '../src/core.mjs';

const record = (id, changes = {}) => ({
  id, roadId: 'mexico-queretaro', road: 'México - Querétaro',
  periodId: '2025-06-30_2025-07-06', date: '2025-07-01',
  hourApprox: 8, minuteOfDayApprox: 480, hourRaw: 0.33,
  km: 5, kmRaw: '5+000', direction: 'A', accidentType: 'Choque',
  injured: 0, deaths: 0, coordinates: [-99.3, 19.8],
  roadDistanceMeters: 4, flags: [], mainEligible: true,
  densityEligible: true, ...changes,
});

// Small independent parser, used to assert what a spreadsheet user receives,
// including commas, quotes and embedded newlines inside a quoted cell.
function readCsv(input) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const csv = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell); cell = '';
    } else if ((char === '\r' || char === '\n') && !quoted) {
      if (char === '\r' && csv[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  assert.equal(quoted, false, 'CSV must close every quoted cell');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [headers, ...values] = rows;
  return values.map(cells => {
    assert.equal(cells.length, headers.length, 'CSV rows must match the header width');
    return Object.fromEntries(headers.map((header, i) => [header, cells[i]]));
  });
}

test('a daytime filter includes its start and excludes its end', () => {
  const cases = new Map([
    [0, false], [5.9999, false], [6, true], [6.01, true],
    [17.9999, true], [18, false], [23.99, false],
  ]);
  for (const [hour, expected] of cases) {
    assert.equal(inHourRange(hour, 6, 18), expected, `${hour} in 06:00–18:00`);
  }
});

test('22:00–06:00 includes both sides of midnight without including 06:00', () => {
  const included = [22, 22.25, 23.99, 0, 0.25, 5.9999];
  const excluded = [6, 6.01, 12, 21.9999];
  for (const hour of included) assert.equal(inHourRange(hour, 22, 6), true, String(hour));
  for (const hour of excluded) assert.equal(inHourRange(hour, 22, 6), false, String(hour));
  assert.equal(hourLabel(22, 6), '22:00–06:00');
});

test('equal endpoints and 00:00–24:00 represent a whole day', () => {
  for (const [start, end] of [[0, 24], [0, 0], [6, 6], [23, 23]]) {
    for (const hour of [0, 0.01, 6, 12, 18, 23.9999]) {
      assert.equal(inHourRange(hour, start, end), true, `${start}→${end}, hour ${hour}`);
    }
    assert.equal(hourLabel(start, end), 'todo el día');
  }
  for (const invalid of [NaN, Infinity, -Infinity, null, undefined, '8']) {
    assert.equal(inHourRange(invalid), false, `non-numeric hour ${String(invalid)}`);
  }
});

test('midnight as the end has the same meaning whether expressed as 0 or 24', () => {
  for (const end of [0, 24]) {
    assert.equal(inHourRange(22.99, 23, end), false);
    assert.equal(inHourRange(23, 23, end), true);
    assert.equal(inHourRange(23.99, 23, end), true);
    assert.equal(inHourRange(0, 23, end), false);
  }
});

test('map and downloadable audit scopes apply road, week and hour consistently', () => {
  const records = [
    record('mapped'),
    record('same-filter-outside-trace', { densityEligible: false, flags: ['off_trace'] }),
    record('different-road', { roadId: 'mexico-puebla' }),
    record('different-week', { periodId: '2025-07-07_2025-07-13' }),
    record('before-start', { hourApprox: 5.99 }),
    record('at-end', { hourApprox: 18 }),
    record('outside-source-week', { mainEligible: false }),
  ];
  const filter = { roadId: 'mexico-queretaro', period: '2025-06-30_2025-07-06', start: 6, end: 18 };
  assert.deepEqual(filterRecords(records, filter).map(r => r.id), ['mapped']);
  const auditScope = filterRecords(records, { ...filter, mappedOnly: false });
  assert.deepEqual(auditScope.map(r => r.id), ['mapped', 'same-filter-outside-trace']);
  const csv = readCsv(csvEncode(auditScope));
  assert.deepEqual(csv.map(r => r.id), ['mapped', 'same-filter-outside-trace']);
  assert.equal(csv[1].advertencias, 'off_trace');
  assert.equal(filterRecords(records, { ...filter, period: 'all', mappedOnly: false }).length, 3);
  assert.equal(filterRecords(records, { ...filter, roadId: undefined, mappedOnly: false }).length, 3);
});

test('bin boundaries give every known kilometre exactly one interval', () => {
  const records = [
    record('zero', { km: 0 }), record('below-five', { km: 4.999 }),
    record('five', { km: 5 }), record('ten', { km: 10 }),
    record('unknown', { km: null }), record('invalid', { km: NaN }),
  ];
  const bins = groupBins(records, 5);
  assert.deepEqual(bins.map(({ from, to, count }) => ({ from, to, count })), [
    { from: 0, to: 5, count: 2 }, { from: 5, to: 10, count: 1 },
    { from: 10, to: 15, count: 1 },
  ]);
  assert.deepEqual(bins.flatMap(bin => bin.records.map(r => r.id)), ['zero', 'below-five', 'five', 'ten']);
  for (const invalidSize of [0, -5, NaN, Infinity]) assert.throws(() => groupBins(records, invalidSize), RangeError);
});

test('CSV preserves raw location and hour evidence, accents, quotes and multiline values', () => {
  const row = record('source.42', {
    road: 'México, "Cuota"', direction: 'Norte\nSur',
    minuteOfDayApprox: 1439, hourRaw: 0.999, kmRaw: '005+200',
    injured: 3, deaths: 1, coordinates: [-99.123456, 19.654321],
    flags: ['hora_inferida', 'fuera_del_trazo'],
  });
  const encoded = csvEncode([row]);
  assert.equal(encoded.charCodeAt(0), 0xFEFF, 'UTF-8 BOM for spreadsheet accent compatibility');
  const [decoded] = readCsv(encoded);
  assert.deepEqual(decoded, {
    id: 'source.42', autopista: 'México, "Cuota"', fecha: '2025-07-01',
    hora_aproximada: '23:59', hora_fraccion_original: '0.999',
    km_reportado: '005+200', sentido: 'Norte\nSur', tipo: 'Choque',
    lesionados: '3', fallecidos: '1', longitud_original: '-99.123456',
    latitud_original: '19.654321', distancia_al_trazo_m: '4',
    advertencias: 'hora_inferida|fuera_del_trazo',
  });
  assert.deepEqual(readCsv(csvEncode([])), []);
  assert.equal(approximateTime({ minuteOfDayApprox: 1440 }), '00:00');
});

test('snapping follows the closest actual road part and never bridges disconnected lines', () => {
  const roadParts = [ [[0, 0], [2, 0]], [[10, 0], [12, 0]] ];
  assert.deepEqual(nearestOnLines([1, 1], roadParts).coordinate, [1, 0]);
  assert.deepEqual(nearestOnLines([6, 1], roadParts).coordinate, [2, 0]);
  assert.equal(nearestOnLines([0, 0], []), null);
});

test('the downloadable pilot snapshot is available with inspectable source provenance', async () => {
  // Read the real delivered file at test time, so a missing deploy asset fails.
  const data = JSON.parse(await readFile(new URL('../src/data/pilot.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(data.records) && data.records.length > 0, 'pilot must contain observed records');
  assert.ok(data.metadata?.source, 'pilot must identify its source');
  assert.ok(data.metadata?.sources?.every(source => source.url && source.sha256), 'each original source must be linked and hashed');
});

test('real source totals remain 975 published rows, 965 in period, 879 usable on the map', async () => {
  const data = JSON.parse(await readFile(new URL('../src/data/pilot.json', import.meta.url), 'utf8'));
  assert.equal(data.records.length, 975);
  assert.equal(new Set(data.records.map(r => r.id)).size, 975, 'source feature identifiers must not be duplicated during packaging');
  assert.equal(filterRecords(data.records, { mappedOnly: false }).length, 965);
  assert.equal(filterRecords(data.records).length, 879);
  const weeklyExpectations = [
    ['2025-06-30_2025-07-06', 461, 424],
    ['2025-07-07_2025-07-13', 504, 455],
  ];
  for (const [period, total, mapped] of weeklyExpectations) {
    assert.equal(filterRecords(data.records, { period, mappedOnly: false }).length, total, `${period} all eligible rows`);
    assert.equal(filterRecords(data.records, { period }).length, mapped, `${period} map rows`);
  }
  const historicOutlier = data.records.find(r => r.id === 'accidentes30jun6jul2025datos.1');
  assert.equal(historicOutlier.date, '2002-07-02', 'retain the anomalous source date instead of silently repairing it');
  assert.equal(historicOutlier.mainEligible, false);
});

test('México–Querétaro uses the audited real totals and CSV matches the mapped scope', async () => {
  const data = JSON.parse(await readFile(new URL('../src/data/pilot.json', import.meta.url), 'utf8'));
  const route = { roadId: 'mexico-queretaro' };
  assert.equal(filterRecords(data.records, { ...route, mappedOnly: false }).length, 101);
  const mapped = filterRecords(data.records, route);
  assert.equal(mapped.length, 80);
  for (const size of [1, 5, 10, 25]) {
    const bins = groupBins(mapped, size);
    assert.equal(bins.reduce((sum, bin) => sum + bin.count, 0), 80, `no loss or duplication at ${size} km`);
  }
  const nightScope = { ...route, start: 22, end: 6 };
  const nightAudit = filterRecords(data.records, { ...nightScope, mappedOnly: false });
  const nightMap = filterRecords(data.records, nightScope);
  assert.equal(nightAudit.length, 24);
  assert.equal(nightMap.length, 17);
  const csv = readCsv(csvEncode(nightMap));
  assert.equal(csv.length, 17, 'CSV contains the same mapped scope as the visible table and map');
  assert.deepEqual(new Set(csv.map(r => r.id)), new Set(nightMap.map(r => r.id)));
  const midnightRow = nightAudit.find(r => r.id === 'accidentes7_13jul2025datos.132');
  assert.equal(midnightRow.hourRaw, 1, 'original boundary encoding remains available');
  assert.equal(midnightRow.hourApprox, 0, 'inferred midnight belongs to the night filter');
  assert.equal(csv.find(r => r.id === midnightRow.id).hora_aproximada, '00:00');
  assert.equal(filterRecords(data.records, { ...route, start: 6, end: 22, mappedOnly: false }).length, 77);
  assert.equal(filterRecords(data.records, { start: 22, end: 6, mappedOnly: false }).length, 217);
  assert.equal(filterRecords(data.records, { start: 22, end: 6 }).length, 194);
});

test('zero mapped records remain distinct from absent source records and unknown kilometre', async () => {
  const data = JSON.parse(await readFile(new URL('../src/data/pilot.json', import.meta.url), 'utf8'));
  const unlocatedRoute = { roadId: 'cd-valles-tamuin' };
  assert.equal(filterRecords(data.records, unlocatedRoute).length, 0);
  assert.equal(filterRecords(data.records, { ...unlocatedRoute, mappedOnly: false }).length, 2);
  assert.equal(data.roads.find(r => r.id === unlocatedRoute.roadId).mainCount, 2);
  const excludedRoute = { roadId: 'libramiento-sur-de-guadalajara' };
  assert.equal(data.records.filter(r => r.roadId === excludedRoute.roadId).length, 1);
  assert.equal(filterRecords(data.records, { ...excludedRoute, mappedOnly: false }).length, 0);

  const roadWithUnknownKm = filterRecords(data.records, { roadId: 'yerbanis-gomez-palacio' });
  assert.equal(roadWithUnknownKm.length, 2, 'a usable point need not have interpretable kilometre');
  const bars = groupBins(roadWithUnknownKm, 5);
  assert.equal(bars.reduce((sum, bin) => sum + bin.count, 0), 1, 'do not invent a kilometre or silently draw an incorrect bar');
  const ambiguous = roadWithUnknownKm.find(r => r.id === 'accidentes7_13jul2025datos.12');
  assert.equal(ambiguous.km, null);
  assert.equal(ambiguous.kmRaw, '148+18');
  const csv = readCsv(csvEncode(roadWithUnknownKm));
  assert.equal(csv.length, 2, 'the point remains available in the mapped CSV scope');
  assert.equal(csv.find(r => r.id === ambiguous.id).km_reportado, '148+18');
});

test('built local asset links resolve and original source downloads match their published hashes', async () => {
  const project = new URL('../', import.meta.url);
  const site = new URL('docs/', project);
  const source = await Promise.all(['src/index.html', 'src/app.mjs'].map(path => readFile(new URL(path, project), 'utf8')));
  const links = source.flatMap(text => [...text.matchAll(/(?:href|src)="(\.\/[^"$]+)"/g)].map(match => match[1]));
  assert.ok(links.includes('./data/pilot.json'));
  assert.ok(links.includes('./data/audit.json'));
  for (const link of new Set(links)) {
    const asset = new URL(link, site);
    assert.ok(asset.pathname.startsWith(site.pathname), `local link stays within the published site: ${link}`);
    await access(asset);
  }
  const data = JSON.parse(await readFile(new URL('data/pilot.json', site), 'utf8'));
  assert.equal(data.metadata.sources.length, 2);
  for (const original of data.metadata.sources) {
    assert.equal(new URL(original.url).protocol, 'https:');
    const bytes = await readFile(new URL(`${data.metadata.sourceArtifactsBase}${original.rawFile}`, site));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), original.sha256);
    assert.equal(JSON.parse(bytes).features.length, original.rawCount);
  }
  for (const link of [data.metadata.auditUrl, data.metadata.roadAuditUrl, data.metadata.roadAlignment.file]) {
    await access(new URL(link, site));
  }
});
