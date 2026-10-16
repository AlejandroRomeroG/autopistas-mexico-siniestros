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
  // Both carriageways can have unequal approach tails. Their shared corridor is
  // established by the full-route samples below, not identical endpoints.
  if (endDistance > 2500) return false;
  const gaps = [];
  for (let index = 0; index <= 12; index++) gaps.push(nearest(atDistance(b.points, b.lengths, b.length * index / 12), a.points, a.lengths).distance);
  gaps.sort((x, y) => x - y);
  return gaps[6] < 150 && gaps[11] < 350;
}

const lonLat = point => [point.x / (radians * EARTH), (2 * Math.atan(Math.exp(point.y / EARTH)) - Math.PI / 2) / radians];
const unit = (x, y, fallback = { x: 1, y: 0 }) => { const length = Math.hypot(x, y); return length > 1e-9 ? { x: x / length, y: y / length } : { ...fallback }; };
const projectedPoint = (project, coordinate) => { const point = project(coordinate); return Array.isArray(point) ? { x: point[0], y: point[1] } : { x: point.x, y: point.y }; };

function average(values, radius) {
  return values.map((value, index) => {
    const span = Math.min(radius, index, values.length - index - 1);
    if (!span) return { ...value };
    let x = 0, y = 0, weight = 0;
    for (let other = index - span; other <= index + span; other++) {
      const amount = span + 1 - Math.abs(other - index);
      x += values[other].x * amount; y += values[other].y * amount; weight += amount;
    }
    return { x: x / weight, y: y / weight };
  });
}

function sideOfCurve(points) {
  // The route orientation is canonical, so its outside never changes when the
  // camera moves. Use signed turning, rather than which side fits the viewport.
  let turning = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const before = unit(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
    const after = unit(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
    turning += Math.atan2(before.x * after.y - before.y * after.x, before.x * after.x + before.y * after.y);
  }
  return turning > 1e-5 ? -1 : 1;
}

function makeSpine(path) {
  const metreScale = 1 / Math.cos(path.coordinates.reduce((sum, point) => sum + point[1], 0) / path.coordinates.length * radians);
  const groundLength = path.length / metreScale;
  const count = Math.max(2, Math.ceil(groundLength / 1500));
  const step = path.length / count;
  const positions = Array.from({ length: count + 1 }, (_, index) => index * step);
  const original = positions.map(position => atDistance(path.points, path.lengths, position));
  // Smooth in road metres, before projection. Two broad weighted passes remove
  // hairpins without a pixel tolerance changing the geometry as the map zooms.
  // Symmetric windows taper at the ends, keeping the exact surveyed endpoints.
  const radius = Math.max(1, Math.round(Math.min(45000, Math.max(18000, groundLength * .35)) * metreScale / step));
  const points = average(average(original, radius), radius);
  const tangentRadius = Math.max(1, Math.round(8000 * metreScale / step));
  const directions = points.map((point, index) => {
    const before = points[Math.max(0, index - tangentRadius)], after = points[Math.min(points.length - 1, index + tangentRadius)];
    return unit(after.x - before.x, after.y - before.y);
  });
  const normalRadius = Math.max(1, Math.round(Math.min(30000, groundLength * .25) * metreScale / step));
  const side = sideOfCurve(points);
  const tangents = average(directions, normalRadius).map(direction => unit(direction.x, direction.y));
  const normals = tangents.map(tangent => ({ x: -tangent.y * side, y: tangent.x * side }));
  return { positions, original, points, normals, metreScale, step, side };
}

function kmDirection(anchors) {
  let vote = 0;
  for (let first = 0; first < anchors.length; first++) for (let second = first + 1; second < anchors.length; second++) {
    const a = anchors[first], b = anchors[second];
    if (!Number.isFinite(a.km) || !Number.isFinite(b.km)) continue;
    const kmDelta = b.km - a.km, positionDelta = (b.position - a.position) / 1000;
    // Distant changes of kilometre origin are not a route calibration. Nearby
    // consistent pairs only establish which direction increasing km runs in.
    if (Math.abs(kmDelta) < .1 || Math.abs(positionDelta) < .1 || Math.abs(kmDelta) > Math.abs(positionDelta) * 3 + 5) continue;
    vote += Math.sign(kmDelta * positionDelta) * Math.min(20, Math.abs(positionDelta));
  }
  return vote < 0 ? -1 : 1;
}

export function buildChartGuide(parts, anchors) {
  const reference = (anchors || []).filter(anchor => validCoordinate(anchor.coordinate)).map(anchor => ({ ...anchor, coordinate: [...anchor.coordinate] }));
  const paths = [];
  for (const path of pathsFromRoad(parts)) if (!paths.some(existing => parallelDuplicate(existing, path))) paths.push(path);
  const runs = paths.map(path => ({ ...path, anchors: [] }));
  for (const anchor of reference) {
    const point = xy(anchor.coordinate);
    let choice = -1, best = null;
    paths.forEach((path, index) => { const candidate = nearest(point, path.points, path.lengths); if (!best || candidate.distance < best.distance) { best = candidate; choice = index; } });
    if (choice >= 0 && best.distance <= 650) runs[choice].anchors.push({ ...anchor, position: best.position });
    else {
      // Keep genuinely separate source branches separate. Never bridge a gap by
      // joining records in kilometre order or move a point onto a remote route.
      const a = validCoordinate(anchor.a) ? anchor.a : [anchor.coordinate[0] - .001, anchor.coordinate[1]];
      let b = validCoordinate(anchor.b) ? anchor.b : [anchor.coordinate[0] + .001, anchor.coordinate[1]];
      if (distance(xy(a), xy(b)) < 1) b = [a[0] + .002, a[1]];
      const coordinates = a[0] < b[0] || a[0] === b[0] && a[1] < b[1] ? [a, b] : [b, a];
      const points = coordinates.map(xy), lengths = cumulative(points);
      runs.push({ coordinates, points, lengths, length: lengths.at(-1), anchors: [{ ...anchor, position: nearest(point, points, lengths).position }], local: true });
    }
  }
  return {
    runs: runs.filter(run => run.anchors.length).map(run => ({ ...run, spine: makeSpine(run), kmDirection: kmDirection(run.anchors) })),
    referenceMaximum: Math.max(1, ...reference.map(anchor => Number.isFinite(anchor.count) ? anchor.count : 1)),
  };
}

function interpolate(values, positions, position) {
  return atDistance(values, positions, position);
}

function projectedSpine(run, project, clearance) {
  const { spine } = run;
  const base = spine.points.map(point => projectedPoint(project, lonLat(point)));
  const normals = spine.points.map((point, index) => {
    const delta = spine.normals[index], nearby = projectedPoint(project, lonLat({ x: point.x + delta.x * 100, y: point.y + delta.y * 100 }));
    return unit(nearby.x - base[index].x, nearby.y - base[index].y, { x: 0, y: -1 });
  });
  const surveyed = run.points.map(point => projectedPoint(project, lonLat(point)));
  const envelopeRadius = Math.max(1, Math.round(4500 * spine.metreScale / spine.step));
  let firstVertex = 0;
  const reaches = base.map((point, index) => {
    const from = spine.positions[Math.max(0, index - envelopeRadius)], to = spine.positions[Math.min(base.length - 1, index + envelopeRadius)];
    while (firstVertex < run.lengths.length - 1 && run.lengths[firstVertex] < from) firstVertex++;
    let reach = 0;
    for (let vertex = firstVertex; vertex < surveyed.length && run.lengths[vertex] <= to; vertex++) {
      reach = Math.max(reach, (surveyed[vertex].x - point.x) * normals[index].x + (surveyed[vertex].y - point.y) * normals[index].y);
    }
    return Math.max(clearance, reach + clearance);
  });
  // Dilate first, then average a smaller window. This rounds the envelope while
  // retaining clearance at the sharpest excursion, rather than clipping through
  // the road after an ordinary smoothing pass.
  const dilation = Math.max(1, Math.round(7000 * spine.metreScale / spine.step));
  const rounding = Math.max(1, Math.floor(dilation * .6));
  const broad = reaches.map((reach, index) => Math.max(...reaches.slice(Math.max(0, index - dilation), Math.min(reaches.length, index + dilation + 1))));
  const gaps = broad.map((gap, index) => {
    const slice = broad.slice(Math.max(0, index - rounding), Math.min(broad.length, index + rounding + 1));
    return slice.reduce((sum, value) => sum + value, 0) / slice.length;
  });
  return { points: base.map((point, index) => ({ x: point.x + normals[index].x * gaps[index], y: point.y + normals[index].y * gaps[index] })), normals };
}

function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 5000; }

function barAt(run, position, frame) {
  const point = interpolate(frame.points, run.spine.positions, position);
  const normalValue = interpolate(frame.normals, run.spine.positions, position), normal = unit(normalValue.x, normalValue.y, { x: 0, y: -1 });
  const before = interpolate(frame.points, run.spine.positions, position - run.spine.step), after = interpolate(frame.points, run.spine.positions, position + run.spine.step);
  let tangent = unit(after.x - before.x, after.y - before.y);
  // Match orientation of the route, keeping the normal perpendicular even where
  // the adaptive envelope gently swells away from the original spine.
  const perpendicular = { x: -normal.y, y: normal.x };
  tangent = tangent.x * perpendicular.x + tangent.y * perpendicular.y < 0 ? { x: -perpendicular.x, y: -perpendicular.y } : perpendicular;
  return { point, normal, tangent };
}

function shape(bar, height) {
  const start = bar.baseStart, end = bar.baseEnd;
  return [start, end, { x: end.x + bar.normal.x * height, y: end.y + bar.normal.y * height }, { x: start.x + bar.normal.x * height, y: start.y + bar.normal.y * height }];
}

function overlap(a, b) {
  for (const polygon of [a, b]) for (let index = 0; index < 4; index++) {
    const first = polygon[index], second = polygon[(index + 1) % 4], axis = unit(second.y - first.y, first.x - second.x);
    const aa = a.map(point => point.x * axis.x + point.y * axis.y), bb = b.map(point => point.x * axis.x + point.y * axis.y);
    if (Math.min(Math.max(...aa), Math.max(...bb)) - Math.max(Math.min(...aa), Math.min(...bb)) < .1) return false;
  }
  return true;
}

function heightLimit(bars, requested, referenceMaximum) {
  const entries = [...bars.values()];
  const collision = height => {
    const shapes = entries.map(bar => shape(bar, height * bar.count / referenceMaximum));
    for (let first = 0; first < shapes.length; first++) for (let second = first + 1; second < shapes.length; second++) if (overlap(shapes[first], shapes[second])) return true;
    return false;
  };
  if (!collision(requested)) return requested;
  let low = 0, high = requested;
  for (let iteration = 0; iteration < 12; iteration++) { const middle = (low + high) / 2; if (collision(middle)) high = middle; else low = middle; }
  return low * .98;
}

export function projectChartGuide(guide, project, options = {}) {
  const bars = new Map(), runs = [];
  const requested = Math.max(0, options.maxHeight ?? 140), minWidth = Math.max(.5, options.minWidth ?? 2), maxWidth = Math.max(minWidth, options.maxWidth ?? 32);
  for (const run of guide?.runs || []) {
    const frame = projectedSpine(run, project, Math.max(12, options.clearance ?? 16));
    if (frame.points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) continue;
    const ordered = [...run.anchors].sort((a, b) => a.position - b.position || String(a.id).localeCompare(String(b.id)));
    const intervals = ordered.map((anchor, index) => {
      const neighbours = [ordered[index - 1], ordered[index + 1]].filter(Boolean).map(other => Math.abs(other.position - anchor.position)).filter(value => value > 1);
      const nominal = Number.isFinite(anchor.from) && Number.isFinite(anchor.to) ? (anchor.to - anchor.from) * 1000 * run.spine.metreScale : options.binKm > 0 ? options.binKm * 1000 * run.spine.metreScale : median(neighbours);
      const shift = Number.isFinite(anchor.km) && Number.isFinite(anchor.from) && Number.isFinite(anchor.to) ? ((anchor.from + anchor.to) / 2 - anchor.km) * 1000 * run.spine.metreScale * run.kmDirection : 0;
      return { anchor, center: clamp(anchor.position + shift, 0, run.length), nominal: Math.max(1, nominal) };
    });
    // Co-located observations may use incompatible kilometre origins. Give their
    // separate bins adjacent slots on this same axis, rather than inventing tiny
    // crossing axes. Source coordinates remain untouched.
    for (let index = 0; index < intervals.length;) {
      let end = index + 1;
      while (end < intervals.length && intervals[end].center - intervals[index].center < Math.min(intervals[index].nominal, intervals[end].nominal) * .15) end++;
      if (end - index > 1) {
        const members = intervals.slice(index, end).sort((a, b) => Number.isFinite(a.anchor.km) && Number.isFinite(b.anchor.km) ? (a.anchor.km - b.anchor.km) * run.kmDirection : String(a.anchor.id).localeCompare(String(b.anchor.id)));
        const span = Math.min(run.length / Math.max(1, intervals.length), median(members.map(member => member.nominal)));
        const center = members.reduce((sum, member) => sum + member.center, 0) / members.length;
        members.forEach((member, memberIndex) => { member.center = clamp(center + (memberIndex - (members.length - 1) / 2) * span, 0, run.length); });
      }
      index = end;
    }
    intervals.sort((a, b) => a.center - b.center || String(a.anchor.id).localeCompare(String(b.anchor.id)));
    runs.push(frame.points.map((point, index) => ({ ...point, normal: frame.normals[index] })));
    for (let index = 0; index < intervals.length; index++) {
      const { anchor, center, nominal } = intervals[index], previous = intervals[index - 1], next = intervals[index + 1];
      const left = Math.max(0, center - nominal / 2, previous ? (previous.center + center) / 2 : -Infinity);
      const right = Math.min(run.length, center + nominal / 2, next ? (next.center + center) / 2 : Infinity);
      const margin = (right - left) * .1;
      const start = barAt(run, left + margin, frame), end = barAt(run, right - margin, frame), centre = barAt(run, (left + right) / 2, frame);
      let width = distance(start.point, end.point), baseStart = start.point, baseEnd = end.point;
      // minWidth is a readability preference, never permission to overrun a
      // narrow route slot. A 1 km interval on a long road may be subpixel at the
      // overview; widening it to 2 px made adjacent bars overlap at their bases
      // and forced the entire count scale almost to zero.
      if (width < .001) {
        const gaps = [previous, next].filter(Boolean).map(other => distance(centre.point, barAt(run, other.center, frame).point));
        width = Math.min(minWidth, gaps.length ? Math.min(...gaps) * .4 : .5);
        width = Math.max(.001, width);
        baseStart = { x: centre.point.x - centre.tangent.x * width / 2, y: centre.point.y - centre.tangent.y * width / 2 };
        baseEnd = { x: centre.point.x + centre.tangent.x * width / 2, y: centre.point.y + centre.tangent.y * width / 2 };
      }
      bars.set(anchor.id, { ...centre, baseStart, baseEnd, width: Math.min(width, maxWidth), count: Math.max(0, Number.isFinite(anchor.count) ? anchor.count : 1), position: center });
    }
  }
  return { runs, bars, maxHeight: heightLimit(bars, requested, guide?.referenceMaximum || 1) };
}
