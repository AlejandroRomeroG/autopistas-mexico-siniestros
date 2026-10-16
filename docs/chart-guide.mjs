// A separate statistical axis for the histogram. The surveyed road and event
// coordinates are never changed. All geometry here uses the complete reference
// set of bins, so an hour/week filter cannot rearrange the chart.
const EARTH = 6371008.8;
const radians = Math.PI / 180;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const validCoordinate = point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);
const xy = point => ({ x: point[0] * radians * EARTH, y: Math.log(Math.tan(Math.PI / 4 + clamp(point[1], -85, 85) * radians / 2)) * EARTH });

function cumulative(points) {
  const lengths = [0];
  for (let index = 1; index < points.length; index++) lengths.push(lengths.at(-1) + distance(points[index - 1], points[index]));
  return lengths;
}

function atDistance(points, lengths, position) {
  if (position <= 0) return { ...points[0] };
  if (position >= lengths.at(-1)) return { ...points.at(-1) };
  let low = 0, high = lengths.length - 1;
  while (high - low > 1) { const middle = (low + high) >> 1; if (lengths[middle] < position) low = middle; else high = middle; }
  const fraction = (position - lengths[low]) / (lengths[high] - lengths[low] || 1);
  return { x: points[low].x + (points[high].x - points[low].x) * fraction, y: points[low].y + (points[high].y - points[low].y) * fraction };
}

function nearest(point, points, lengths = cumulative(points)) {
  let best = { point: points[0], position: 0, distance: Infinity };
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index], dx = b.x - a.x, dy = b.y - a.y;
    const fraction = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    const projected = { x: a.x + dx * fraction, y: a.y + dy * fraction }, delta = distance(point, projected);
    if (delta < best.distance) best = { point: projected, position: lengths[index - 1] + (lengths[index] - lengths[index - 1]) * fraction, distance: delta };
  }
  return best;
}

class Heap {
  values = [];
  push(value) {
    let index = this.values.push(value) - 1;
    while (index) { const parent = (index - 1) >> 1; if (this.values[parent][0] <= value[0]) break; this.values[index] = this.values[parent]; index = parent; }
    this.values[index] = value;
  }
  pop() {
    const first = this.values[0], last = this.values.pop();
    if (this.values.length) {
      let index = 0;
      while (index * 2 + 1 < this.values.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.values.length && this.values[child + 1][0] < this.values[child][0]) child++;
        if (this.values[child][0] >= last[0]) break;
        this.values[index] = this.values[child]; index = child;
      }
      this.values[index] = last;
    }
    return first;
  }
}

function pathsFromRoad(parts) {
  // Quantisation only joins coincident surveyed vertices (~1 m), never nearby
  // roads across a geographic gap. Two separate carriageways remain components.
  const nodes = new Map();
  const nodeFor = coordinate => {
    const key = `${Math.round(coordinate[0] * 1e5)},${Math.round(coordinate[1] * 1e5)}`;
    if (!nodes.has(key)) {
      const rounded = key.split(',').map(value => +value / 1e5);
      nodes.set(key, { key, coordinate: rounded, point: xy(rounded), edges: new Map() });
    }
    return nodes.get(key);
  };
  for (const part of parts || []) {
    let previous = null;
    for (const coordinate of part || []) {
      if (!validCoordinate(coordinate)) { previous = null; continue; }
      const current = nodeFor(coordinate);
      if (previous && previous !== current) {
        const length = distance(previous.point, current.point);
        previous.edges.set(current.key, length); current.edges.set(previous.key, length);
      }
      previous = current;
    }
  }
  const visited = new Set(), paths = [];
  function furthest(start) {
    const distances = new Map([[start, 0]]), parents = new Map(), heap = new Heap();
    heap.push([0, start]);
    let far = start, farDistance = 0;
    while (heap.values.length) {
      const [length, key] = heap.pop();
      if (length !== distances.get(key)) continue;
      visited.add(key);
      if (length > farDistance || length === farDistance && key < far) { far = key; farDistance = length; }
      for (const [next, weight] of nodes.get(key).edges) {
        const candidate = length + weight;
        if (candidate < (distances.get(next) ?? Infinity)) { distances.set(next, candidate); parents.set(next, key); heap.push([candidate, next]); }
      }
    }
    return { far, parents, length: farDistance, keys: [...distances.keys()] };
  }
  for (const key of [...nodes.keys()].sort()) {
    if (visited.has(key) || !nodes.get(key).edges.size) continue;
    // A weighted graph diameter approximation follows existing edges through
    // fragmented source lines; it does not join accident locations by km order.
    let start = furthest(key).far, search = furthest(start), finish = search.far;
    // Carriageways joined only at one end can have a graph diameter that travels
    // out on one lane and all the way back on the other. Its endpoints are almost
    // coincident. In that case choose geographic extremes, still routing solely
    // over actual source edges, rather than drawing a doubled-back chart axis.
    if (distance(nodes.get(start).point, nodes.get(finish).point) < 350 && distance(nodes.get(start).point, nodes.get(finish).point) < search.length * .08) {
      const geographicFar = from => search.keys.reduce((best, candidate) => distance(nodes.get(from).point, nodes.get(candidate).point) > distance(nodes.get(from).point, nodes.get(best).point) ? candidate : best, from);
      start = geographicFar(start); finish = geographicFar(start); search = furthest(start);
    }
    const path = [];
    for (let at = finish; at !== undefined; at = search.parents.get(at)) path.push(nodes.get(at).coordinate);
    if (path[0][0] > path.at(-1)[0] || path[0][0] === path.at(-1)[0] && path[0][1] > path.at(-1)[1]) path.reverse();
    const points = path.map(xy);
    const lengths = cumulative(points);
    paths.push({ coordinates: path, points, lengths, length: lengths.at(-1) });
  }
  return paths.sort((a, b) => b.length - a.length);
}

function parallelDuplicate(a, b) {
  if (b.length / a.length < .55) return false;
  const endDistance = Math.min(
    distance(a.points[0], b.points[0]) + distance(a.points.at(-1), b.points.at(-1)),
    distance(a.points[0], b.points.at(-1)) + distance(a.points.at(-1), b.points[0]),
  );
  if (endDistance > 1200) return false;
  const gaps = [];
  for (let index = 0; index <= 12; index++) gaps.push(nearest(atDistance(b.points, b.lengths, b.length * index / 12), a.points, a.lengths).distance);
  gaps.sort((x, y) => x - y);
  return gaps[6] < 150 && gaps[11] < 350;
}

export function buildChartGuide(parts, anchors) {
  const reference = (anchors || []).filter(anchor => validCoordinate(anchor.coordinate)).map(anchor => ({ ...anchor, coordinate: [...anchor.coordinate] }));
  const paths = [];
  for (const path of pathsFromRoad(parts)) if (!paths.some(existing => parallelDuplicate(existing, path))) paths.push(path);
  const runs = paths.map(path => ({ coordinates: path.coordinates, anchors: [] }));
  for (const anchor of reference) {
    const point = xy(anchor.coordinate);
    let choice = -1, delta = Infinity;
    paths.forEach((path, index) => { const candidate = nearest(point, path.points, path.lengths).distance; if (candidate < delta) { delta = candidate; choice = index; } });
    // A branch absent from the dominant path receives its own local axis instead
    // of being dragged kilometres onto the main carriageway.
    if (choice >= 0 && delta <= 650) runs[choice].anchors.push(anchor);
    else {
      const a = validCoordinate(anchor.a) ? anchor.a : [anchor.coordinate[0] - .001, anchor.coordinate[1]];
      const b = validCoordinate(anchor.b) ? anchor.b : [anchor.coordinate[0] + .001, anchor.coordinate[1]];
      const coordinates = a[0] < b[0] || a[0] === b[0] && a[1] < b[1] ? [a, b] : [b, a];
      runs.push({ coordinates, anchors: [anchor] });
    }
  }
  return { runs: runs.filter(run => run.anchors.length), referenceMaximum: Math.max(1, ...reference.map(anchor => Number.isFinite(anchor.count) ? anchor.count : 1)) };
}

function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Set([0, points.length - 1]), stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop(); let furthest = -1, largest = tolerance;
    const segment = [points[first], points[last]], lengths = cumulative(segment);
    for (let index = first + 1; index < last; index++) { const delta = nearest(points[index], segment, lengths).distance; if (delta > largest) { largest = delta; furthest = index; } }
    if (furthest >= 0) { keep.add(furthest); stack.push([first, furthest], [furthest, last]); }
  }
  return [...keep].sort((a, b) => a - b).map(index => points[index]);
}

function regularize(points, maxHeight) {
  let result = simplify(points, 22);
  for (let iteration = 0; iteration < 3 && result.length > 2; iteration++) {
    const rounded = [result[0]];
    for (let index = 1; index < result.length; index++) {
      const a = result[index - 1], b = result[index];
      rounded.push({ x: a.x * .75 + b.x * .25, y: a.y * .75 + b.y * .25 }, { x: a.x * .25 + b.x * .75, y: a.y * .25 + b.y * .75 });
    }
    rounded.push(result.at(-1)); result = rounded;
  }
  const lengths = cumulative(result), total = lengths.at(-1);
  if (total < .001) return result;
  const step = Math.max(5, total / 1600), sampled = [];
  for (let position = 0; position < total; position += step) sampled.push(atDistance(result, lengths, position));
  sampled.push(result.at(-1));
  const radius = Math.max(1, Math.round(Math.min(65, Math.max(12, maxHeight * .45)) / step));
  return sampled.map((point, index) => {
    if (!index || index === sampled.length - 1) return point;
    let x = 0, y = 0, weightSum = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const source = sampled[clamp(index + offset, 0, sampled.length - 1)], weight = radius + 1 - Math.abs(offset);
      x += source.x * weight; y += source.y * weight; weightSum += weight;
    }
    return { x: x / weightSum, y: y / weightSum };
  });
}

function hasCollision(entries, height, referenceMaximum) {
    // Analytic separating axes avoid allocating four polygons for every pair on
    // every animation frame. The tolerance allows a subpixel shared border.
    const shapes = entries.map(bar => {
      const halfHeight = height * bar.count / referenceMaximum / 2, halfWidth = bar.width / 2;
      return { bar, halfHeight, halfWidth, x: bar.point.x + bar.normal.x * halfHeight, y: bar.point.y + bar.normal.y * halfHeight, extentX: Math.abs(bar.tangent.x) * halfWidth + Math.abs(bar.normal.x) * halfHeight, extentY: Math.abs(bar.tangent.y) * halfWidth + Math.abs(bar.normal.y) * halfHeight };
    });
    for (let a = 0; a < shapes.length; a++) for (let b = a + 1; b < shapes.length; b++) {
      const first = shapes[a], second = shapes[b], dx = second.x - first.x, dy = second.y - first.y;
      if (first.halfHeight < .04 || second.halfHeight < .04 || Math.abs(dx) >= first.extentX + second.extentX - .08 || Math.abs(dy) >= first.extentY + second.extentY - .08) continue;
      let separated = false;
      for (const axis of [first.bar.tangent, first.bar.normal, second.bar.tangent, second.bar.normal]) {
        const extent = Math.abs(axis.x * first.bar.tangent.x + axis.y * first.bar.tangent.y) * first.halfWidth + Math.abs(axis.x * first.bar.normal.x + axis.y * first.bar.normal.y) * first.halfHeight + Math.abs(axis.x * second.bar.tangent.x + axis.y * second.bar.tangent.y) * second.halfWidth + Math.abs(axis.x * second.bar.normal.x + axis.y * second.bar.normal.y) * second.halfHeight;
        if (Math.abs(dx * axis.x + dy * axis.y) >= extent - .08) { separated = true; break; }
      }
      if (!separated) return true;
    }
  return false;
}

function safeHeight(bars, maximum, referenceMaximum) {
  const entries = [...bars.values()];
  if (!hasCollision(entries, maximum, referenceMaximum)) return maximum;
  let low = 0, high = maximum;
  for (let iteration = 0; iteration < 15; iteration++) { const middle = (low + high) / 2; if (hasCollision(entries, middle, referenceMaximum)) high = middle; else low = middle; }
  return low * .98;
}

function placeRuns(groups, referenceMaximum, requestedHeight, options) {
  const bars = new Map(), runs = [], placed = [];
  // A narrow curve can limit a run's own height. Separate components can instead
  // move as whole graphic axes, preserving every individual count proportion.
  const target = Math.min(requestedHeight, ...groups.map(group => Math.max(...group.alternatives.map(alternative => alternative.safeHeight))));
  for (const group of groups) {
    const alternatives = group.alternatives.filter(alternative => alternative.safeHeight >= target - .01);
    const candidates = [];
    for (const alternative of alternatives) {
      const values = [...alternative.bars.values()];
      let nx = values.reduce((sum, bar) => sum + bar.normal.x, 0), ny = values.reduce((sum, bar) => sum + bar.normal.y, 0), norm = Math.hypot(nx, ny);
      if (norm < .01) { nx = values[0].normal.x; ny = values[0].normal.y; norm = 1; }
      nx /= norm; ny /= norm;
      const directions = [[nx, ny], [-nx, -ny], [ny, -nx], [-ny, nx], [1, 0], [-1, 0], [0, 1], [0, -1], [Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]];
      for (const radius of [0, 10, 20, 32, 48, 64, 88, 120]) {
        for (const [dx, dy] of radius ? directions : [[0, 0]]) {
          const x = dx * radius, y = dy * radius;
          let offCanvas = 0;
          if (options.width && options.height) for (const bar of values) {
            const centreX = bar.point.x + x + bar.normal.x * target * bar.count / referenceMaximum / 2, centreY = bar.point.y + y + bar.normal.y * target * bar.count / referenceMaximum / 2;
            offCanvas += Math.max(0, -centreX, centreX - options.width, -centreY, centreY - options.height);
          }
          candidates.push({ alternative, x, y, cost: radius + (alternative === group.preferred ? 0 : 2) + offCanvas * .3 });
        }
      }
    }
    candidates.sort((a, b) => a.cost - b.cost);
    let choice = null, translated = null;
    for (const candidate of candidates) {
      const moved = [...candidate.alternative.bars].map(([id, bar]) => [id, { ...bar, point: { x: bar.point.x + candidate.x, y: bar.point.y + candidate.y } }]);
      if (!hasCollision([...placed, ...moved.map(([, bar]) => bar)], target, referenceMaximum)) { choice = candidate; translated = moved; break; }
    }
    // Bounded packing is deliberately conservative. An unresolved extreme case
    // falls back to the common height guard; it never clips a single bar.
    if (!choice) {
      choice = candidates[0];
      translated = [...choice.alternative.bars].map(([id, bar]) => [id, { ...bar, point: { x: bar.point.x + choice.x, y: bar.point.y + choice.y } }]);
    }
    for (const [id, bar] of translated) { bars.set(id, bar); placed.push(bar); }
    runs.push(choice.alternative.points.map(point => ({ x: point.x + choice.x, y: point.y + choice.y })));
  }
  return { bars, runs, maxHeight: safeHeight(bars, target, referenceMaximum) };
}

export function projectChartGuide(guide, project, options = {}) {
  const requestedHeight = Math.max(0, options.maxHeight ?? 140), maxWidth = Math.max(.5, options.maxWidth ?? 32), minWidth = clamp(options.minWidth ?? 2, .5, maxWidth);
  const offset = Math.max(0, options.offset ?? 10);
  const groups = [];
  for (const referenceRun of guide?.runs || []) {
    const projected = referenceRun.coordinates.map(coordinate => project(coordinate)).map(point => Array.isArray(point) ? { x: point[0], y: point[1] } : { x: point.x, y: point.y }).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (projected.length < 2) continue;
    let points = regularize(projected, requestedHeight), lengths = cumulative(points), total = lengths.at(-1);
    const spacing = minWidth + 1.2, required = Math.max(10, referenceRun.anchors.length * spacing);
    if (total < required) {
      const middle = points[Math.floor(points.length / 2)], first = points[0], last = points.at(-1), length = distance(first, last) || 1;
      const tangent = distance(first, last) < .001 ? { x: 1, y: 0 } : { x: (last.x - first.x) / length, y: (last.y - first.y) / length };
      points = [{ x: middle.x - tangent.x * required / 2, y: middle.y - tangent.y * required / 2 }, { x: middle.x + tangent.x * required / 2, y: middle.y + tangent.y * required / 2 }];
      lengths = cumulative(points); total = lengths.at(-1);
    }
    const positions = referenceRun.anchors.map(anchor => {
      const projectedAnchor = project(anchor.coordinate), point = Array.isArray(projectedAnchor) ? { x: projectedAnchor[0], y: projectedAnchor[1] } : projectedAnchor;
      return { anchor, position: nearest(point, points, lengths).position };
    }).sort((a, b) => a.position - b.position || String(a.anchor.id).localeCompare(String(b.anchor.id)));
    // Give coincident reference bins separate slots on the same graphic axis.
    for (let index = 1; index < positions.length; index++) positions[index].position = Math.max(positions[index].position, positions[index - 1].position + spacing);
    if (positions.length && positions.at(-1).position > total) positions.at(-1).position = total;
    for (let index = positions.length - 2; index >= 0; index--) positions[index].position = Math.min(positions[index].position, positions[index + 1].position - spacing);
    const runBars = new Map();
    for (let index = 0; index < positions.length; index++) {
      const { anchor, position } = positions[index], point = atDistance(points, lengths, position), window = Math.min(total / 3, Math.max(16, requestedHeight * .65));
      const before = atDistance(points, lengths, position - window), after = atDistance(points, lengths, position + window), length = distance(before, after) || 1;
      const tangent = { x: (after.x - before.x) / length, y: (after.y - before.y) / length };
      if (Math.hypot(tangent.x, tangent.y) < .001) { tangent.x = 1; tangent.y = 0; }
      const gaps = [positions[index - 1], positions[index + 1]].filter(Boolean).map(other => distance(point, atDistance(points, lengths, other.position)));
      const width = clamp(gaps.length ? Math.min(...gaps) * .68 : maxWidth, minWidth, maxWidth);
      runBars.set(anchor.id, { point, tangent, normal: { x: tangent.y, y: -tangent.x }, width, count: Math.max(0, Number.isFinite(anchor.count) ? anchor.count : 1) });
    }
    const withSide = sign => new Map([...runBars].map(([id, bar]) => [id, { ...bar, normal: { x: bar.normal.x * sign, y: bar.normal.y * sign }, point: { x: bar.point.x + bar.normal.x * sign * offset, y: bar.point.y + bar.normal.y * sign * offset } }]));
    const left = withSide(1), right = withSide(-1);
    const window = Math.min(total / 3, Math.max(16, requestedHeight * .65));
    const offsetPoints = sign => points.map((point, index) => {
      const before = atDistance(points, lengths, lengths[index] - window), after = atDistance(points, lengths, lengths[index] + window), length = distance(before, after) || 1;
      return { x: point.x + (after.y - before.y) / length * offset * sign, y: point.y - (after.x - before.x) / length * offset * sign };
    });
    const alternatives = [{ bars: left, points: offsetPoints(1), safeHeight: safeHeight(left, requestedHeight, guide.referenceMaximum) }, { bars: right, points: offsetPoints(-1), safeHeight: safeHeight(right, requestedHeight, guide.referenceMaximum) }];
    groups.push({ alternatives, preferred: alternatives[0].safeHeight >= alternatives[1].safeHeight ? alternatives[0] : alternatives[1] });
  }
  // The limit uses every original bin and its reference count. Filtering can only
  // shorten these rectangles, preserving both layout and a common count scale.
  return placeRuns(groups, guide?.referenceMaximum || 1, requestedHeight, options);
}
