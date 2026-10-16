import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildChartGuide, projectChartGuide } from '../src/chart-guide.mjs';
import { filterRecords, groupBins, nearestOnLines } from '../src/core.mjs';

const project = ([longitude, latitude]) => ({ x: longitude * 300, y: -latitude * 300 });
const referenceAnchor = (id, coordinate, a, b, count = 5) => ({ id, coordinate, a, b, count });
const options = { maxHeight: 140, minWidth: 2, maxWidth: 32, width: 1000, height: 700 };

function polygon(bar, height) {
  const { point: p, tangent: t, normal: n, width: w } = bar;
  const start = bar.baseStart || { x: p.x - t.x * w / 2, y: p.y - t.y * w / 2 };
  const end = bar.baseEnd || { x: p.x + t.x * w / 2, y: p.y + t.y * w / 2 };
  return [
    [start.x, start.y], [end.x, end.y],
    [end.x + n.x * height, end.y + n.y * height], [start.x + n.x * height, start.y + n.y * height],
  ];
}

// Independently check interior overlap with convex separating axes. A shared
// border is allowed, while visibly overlapping coloured areas are a failure.
function interiorOverlap(a, b) {
  for (const shape of [a, b]) {
    for (let index = 0; index < shape.length; index++) {
      const from = shape[index], to = shape[(index + 1) % shape.length], axis = [to[1] - from[1], from[0] - to[0]], norm = Math.hypot(...axis);
      if (norm < .001) continue;
      const first = a.map(point => (point[0] * axis[0] + point[1] * axis[1]) / norm), second = b.map(point => (point[0] * axis[0] + point[1] * axis[1]) / norm);
      if (Math.min(Math.max(...first), Math.max(...second)) - Math.max(Math.min(...first), Math.min(...second)) <= .1) return false;
    }
  }
  return true;
}

function assertClear(layout, anchors) {
  const maximum = Math.max(1, ...anchors.map(anchor => anchor.count));
  const bars = anchors.map(anchor => {
    const bar = layout.bars.get(anchor.id);
    assert.ok(bar, `bin ${anchor.id} must remain represented`);
    for (const value of [bar.point.x, bar.point.y, bar.tangent.x, bar.tangent.y, bar.normal.x, bar.normal.y, bar.width, layout.maxHeight]) assert.ok(Number.isFinite(value));
    assert.ok(Math.abs(Math.hypot(bar.tangent.x, bar.tangent.y) - 1) < 1e-6, 'unit tangent');
    assert.ok(Math.abs(bar.tangent.x * bar.normal.x + bar.tangent.y * bar.normal.y) < 1e-6, 'orthogonal normal');
    assert.ok(bar.width > 0 && bar.width <= 32, 'nominal slots may be subpixel at a whole-road overview');
    return { id: anchor.id, points: polygon(bar, layout.maxHeight * anchor.count / maximum) };
  });
  for (let first = 0; first < bars.length; first++) for (let second = first + 1; second < bars.length; second++) {
    assert.equal(interiorOverlap(bars[first].points, bars[second].points), false, `bins ${bars[first].id} and ${bars[second].id} overlap`);
  }
}

test('a tight U uses one smooth, coherent outside axis with clear reference bars', () => {
  const road = Array.from({ length: 101 }, (_, index) => {
    const angle = Math.PI * index / 100;
    return [.25 * Math.cos(angle), 20 + .25 * Math.sin(angle)];
  });
  const anchors = Array.from({ length: 13 }, (_, index) => {
    const at = Math.round((index + 1) * 100 / 14);
    return referenceAnchor(index, road[at], road[at - 1], road[at + 1]);
  });
  const layout = projectChartGuide(buildChartGuide([road], anchors), project, options);
  assert.equal(layout.runs.length, 1);
  assert.equal(layout.bars.size, anchors.length);
  assert.ok(layout.maxHeight >= 70, `outside rail should retain useful height, received ${layout.maxHeight}`);
  const ordered = [...layout.bars.values()];
  for (let index = 1; index < ordered.length; index++) assert.ok(ordered[index].normal.x * ordered[index - 1].normal.x + ordered[index].normal.y * ordered[index - 1].normal.y > 0, 'neighbouring normals do not flip');
  assertClear(layout, anchors);
});

test('a winding S limits the common height instead of cropping individual counts', () => {
  const road = Array.from({ length: 151 }, (_, index) => [index * .008, 20 + Math.sin(index * Math.PI / 50) * .22]);
  const anchors = Array.from({ length: 22 }, (_, index) => {
    const at = 3 + index * 6;
    return referenceAnchor(index, road[at], road[at - 1], road[at + 1], index % 3 + 2);
  });
  const layout = projectChartGuide(buildChartGuide([road], anchors), project, options);
  assert.ok(layout.maxHeight > 10 && layout.maxHeight <= options.maxHeight);
  assertClear(layout, anchors);
  const again = projectChartGuide(buildChartGuide([road], anchors), project, options);
  assert.deepEqual(again, layout, 'the same complete reference set gives a stable layout');
});

test('disconnected road components remain distinct with no invented connecting line', () => {
  const parts = [[[0, 20], [.5, 20]], [[4, 20], [4.5, 20]]];
  const anchors = [referenceAnchor('west', [.25, 20], ...parts[0]), referenceAnchor('east', [4.25, 20], ...parts[1])];
  const layout = projectChartGuide(buildChartGuide(parts, anchors), project, options);
  assert.equal(layout.runs.length, 2);
  assert.ok(layout.runs.every(run => Math.max(...run.map(point => point.x)) - Math.min(...run.map(point => point.x)) <= 151));
  assertClear(layout, anchors);
});

test('opposite parallel carriageways share a regular axis without losing either direction', () => {
  const parts = [[[0, 20], [.4, 20], [.8, 20]], [[.8, 20.0006], [.4, 20.0006], [0, 20.0006]]];
  const anchors = Array.from({ length: 6 }, (_, index) => referenceAnchor(index, [.1 + index * .12, 20 + (index % 2) * .0006], ...parts[index % 2].slice(0, 2)));
  const layout = projectChartGuide(buildChartGuide(parts, anchors), project, options);
  assert.equal(layout.runs.length, 1, 'nearby reversed carriageways are one chart corridor');
  assertClear(layout, anchors);
  const reversed = projectChartGuide(buildChartGuide([...parts].reverse().map(part => [...part].reverse()), anchors), project, options);
  assert.deepEqual(reversed, layout, 'source vertex direction must not flip the chart side');
});

test('carriageways connected at one end do not create an out-and-back chart axis', () => {
  const parts = [[[0, 20], [.4, 20], [.8, 20]], [[.8, 20], [.8, 20.0006], [.4, 20.0006], [0, 20.0006]]];
  const anchors = Array.from({ length: 8 }, (_, index) => referenceAnchor(index, [.05 + index * .1, 20 + (index % 2) * .0006], ...parts[index % 2].slice(0, 2)));
  const layout = projectChartGuide(buildChartGuide(parts, anchors), project, options);
  assert.equal(layout.runs.length, 1);
  const run = layout.runs[0];
  assert.ok(Math.hypot(run[0].x - run.at(-1).x, run[0].y - run.at(-1).y) > 230, 'axis spans the route rather than returning to its start');
  assertClear(layout, anchors);
});

test('coincident bins and isolated records get separate usable chart slots', () => {
  const anchors = [referenceAnchor('one', [1, 20], [1, 20], [1, 20]), referenceAnchor('two', [1, 20], [1, 20], [1, 20])];
  const layout = projectChartGuide(buildChartGuide([[[.9, 20], [1.1, 20]]], anchors), project, options);
  assertClear(layout, anchors);
  assert.ok(Math.hypot(layout.bars.get('one').point.x - layout.bars.get('two').point.x, layout.bars.get('one').point.y - layout.bars.get('two').point.y) >= 3);
  const fallback = projectChartGuide(buildChartGuide([], [anchors[0]]), project, options);
  assert.equal(fallback.bars.size, 1, 'an isolated bin survives absent or zero-length source edges');
  assertClear(fallback, [anchors[0]]);
});

test('separate local branches keep exact observations and deterministic geometry', () => {
  const anchors = [referenceAnchor('north', [1, 20], [1, 19.99], [1, 20.01], 2), referenceAnchor('east', [1.005, 20.005], [.995, 20.005], [1.015, 20.005], 1)];
  const source = JSON.stringify(anchors), layout = projectChartGuide(buildChartGuide([], anchors), project, options);
  assert.equal(layout.runs.length, 2, 'source components remain separate');
  assertClear(layout, anchors);
  assert.equal(JSON.stringify(anchors), source, 'the chart never moves the underlying observed records');
  assert.deepEqual(layout, projectChartGuide(buildChartGuide([], anchors), project, options));
});

async function realRoad(roadId, binSize = 5) {
  const data = JSON.parse(await readFile(new URL('../src/data/pilot.json', import.meta.url), 'utf8'));
  const geo = JSON.parse(await readFile(new URL('../src/data/roads.geojson', import.meta.url), 'utf8'));
  const feature = geo.features.find(feature => feature.properties.roadId === roadId);
  const parts = feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates : [feature.geometry.coordinates];
  const bins = groupBins(filterRecords(data.records, { roadId }), binSize);
  const anchors = bins.map(bin => {
    const ordered = [...bin.records].sort((a, b) => a.km - b.km), representative = ordered[Math.floor(ordered.length / 2)];
    return { id: bin.id, count: bin.count, km: representative.km, from: bin.from, to: bin.to, ...nearestOnLines(representative.nearestRoadCoordinates || representative.coordinates, parts) };
  });
  const coordinates = parts.flat(), minX = Math.min(...coordinates.map(point => point[0])), maxX = Math.max(...coordinates.map(point => point[0])), minY = Math.min(...coordinates.map(point => point[1])), maxY = Math.max(...coordinates.map(point => point[1]));
  const scale = Math.min(650 / (maxX - minX), 350 / (maxY - minY));
  const fit = ([longitude, latitude]) => ({ x: (longitude - minX) * scale + 180, y: (maxY - latitude) * scale + 200 });
  return { parts, anchors, fit };
}

for (const roadId of ['mexico-queretaro', 'mexico-cuernavaca', 'mexico-puebla', 'cuernavaca-acapulco', 'acatzingo-cd-mendoza', 'guadalajara-colima']) {
  test(`real ${roadId}: fragmented source geometry retains every bin without overlaps`, async () => {
    const { parts, anchors, fit } = await realRoad(roadId), sourceCopy = JSON.stringify({ parts, anchors });
    const guide = buildChartGuide(parts, anchors), layout = projectChartGuide(guide, fit, options);
    assert.equal(layout.bars.size, anchors.length);
    assert.ok(layout.maxHeight >= 8, `reference height must remain visible: ${layout.maxHeight}`);
    if (['acatzingo-cd-mendoza', 'mexico-queretaro', 'mexico-cuernavaca'].includes(roadId)) {
      assert.equal(layout.runs.length, 1, 'the main corridor has one continuous reference axis');
      assert.equal(layout.maxHeight, options.maxHeight, 'broad geographic smoothing preserves the requested count scale');
    }
    assertClear(layout, anchors);
    assert.equal(JSON.stringify({ parts, anchors }), sourceCopy, 'observed coordinates and reference counts are immutable');
    const before = projectChartGuide(guide, fit, options);
    // The renderer can request a subset without rebuilding the full-data guide.
    const selectedIds = anchors.filter((_, index) => index % 2).map(anchor => anchor.id);
    for (const id of selectedIds) assert.deepEqual(before.bars.get(id), layout.bars.get(id));
    assert.equal(before.maxHeight, layout.maxHeight, 'filter changes cannot change the common count scale');
  });
}

test('the geographic spine preserves endpoints and route parameters through a winding bend', () => {
  const road = Array.from({ length: 151 }, (_, index) => [-100 + index * .007, 20 + Math.sin(index * Math.PI / 50) * .18]);
  const anchors = [20, 50, 80, 110].map(index => referenceAnchor(index, road[index], road[index - 1], road[index + 1]));
  const guide = buildChartGuide([road], anchors), run = guide.runs[0];
  assert.deepEqual(run.spine.points[0], run.points[0]);
  assert.deepEqual(run.spine.points.at(-1), run.points.at(-1));
  assert.ok(run.spine.points.length > 30, 'regular sampling resolves the complete corridor');
  assert.ok(run.anchors.every((anchor, index, list) => !index || anchor.position > list[index - 1].position), 'bins retain their original-road parameter order');
  const before = JSON.stringify(guide);
  const close = projectChartGuide(guide, point => { const p = project(point); return { x: p.x * 4, y: p.y * 4 }; }, options);
  const far = projectChartGuide(guide, project, options);
  assert.equal(JSON.stringify(guide), before, 'projection does not rebuild the geographic spine');
  for (const anchor of anchors) {
    const a = close.bars.get(anchor.id), b = far.bars.get(anchor.id);
    assert.ok(a.normal.x * b.normal.x + a.normal.y * b.normal.y > .999999, 'zoom cannot flip the chart side or jitter its normals');
    assert.equal(a.position, b.position, 'zoom keeps the same original-road parameter');
  }
});

test('bar edges follow nominal kilometre intervals instead of bridging empty bins', () => {
  const road = [[-100, 20], [-99, 20]];
  const anchors = [
    { ...referenceAnchor('a', [-99.9, 20], ...road), from: 10, to: 15, km: 12.5 },
    { ...referenceAnchor('b', [-99.5, 20], ...road), from: 50, to: 55, km: 52.5 },
  ];
  const layout = projectChartGuide(buildChartGuide([road], anchors), project, options);
  const widths = [...layout.bars.values()].map(bar => Math.hypot(bar.baseEnd.x - bar.baseStart.x, bar.baseEnd.y - bar.baseStart.y));
  assert.ok(Math.abs(widths[0] - widths[1]) < .001, 'equal kilometre intervals have equal widths on a straight route');
  assert.ok(widths.every(width => width > 8 && width < 16), 'a sparse histogram does not stretch a bar across its empty neighbour bins');
  assertClear(layout, anchors);
});

for (const [roadId, binKm] of [['cuernavaca-acapulco', 1], ['estacion-don-nogales', 1], ['estacion-don-nogales', 2], ['libramiento-nororiente-de-queretaro', 2], ['libramiento-nororiente-de-queretaro', 20]]) {
  test(`narrow and parallel ${roadId} ${binKm} km intervals retain a readable common scale`, async () => {
    const { parts, anchors, fit } = await realRoad(roadId, binKm);
    const guide = buildChartGuide(parts, anchors), layout = projectChartGuide(guide, fit, { ...options, binKm });
    assert.ok(layout.maxHeight > 45, `count scale must not collapse because of one narrow interval: ${layout.maxHeight}`);
    assertClear(layout, anchors);
    if (roadId === 'libramiento-nororiente-de-queretaro') assert.equal(layout.runs.length, 1, 'unequal carriageway tails do not create two crossing axes');
    assert.deepEqual(layout, projectChartGuide(guide, fit, { ...options, binKm }), 'layout stays deterministic through filters');
  });
}
