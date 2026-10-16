export const FULL_DAY = { start: 0, end: 24 };
export const numberFormat = new Intl.NumberFormat('es-MX');
export function inHourRange(hour, start = 0, end = 24) {
  if (!Number.isFinite(hour)) return false;
  const a = start % 24, b = end % 24;
  if (a === b) return true;
  return a < b ? hour >= a && hour < b : hour >= a || hour < b;
}
export function filterRecords(records, { roadId, period = 'all', start = 0, end = 24, mappedOnly = true } = {}) {
  return records.filter(r => r.mainEligible && (!roadId || r.roadId === roadId) &&
    (period === 'all' || r.periodId === period) && inHourRange(r.hourApprox, start, end) &&
    (!mappedOnly || r.densityEligible));
}
export function groupBins(records, size = 5) {
  if (!Number.isFinite(size) || size <= 0) throw new RangeError('El tamaño de tramo debe ser positivo.');
  const bins = new Map();
  for (const record of records) {
    if (!Number.isFinite(record.km)) continue;
    const index = Math.floor(record.km / size);
    if (!bins.has(index)) bins.set(index, { id: index, from: index * size, to: (index + 1) * size, records: [], count: 0 });
    const bin = bins.get(index);
    bin.records.push(record);
    bin.count += 1;
  }
  return [...bins.values()].sort((a, b) => a.from - b.from);
}
export function formatHour(hour) { return `${String(hour % 24).padStart(2, '0')}:00`; }
export function hourLabel(start, end) { return start % 24 === end % 24 ? 'todo el día' : `${formatHour(start)}–${formatHour(end)}`; }
export function approximateTime(record) {
  const minute = record.minuteOfDayApprox % 1440;
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
export function shortDate(iso) {
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
}
export function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function csvEncode(rows) {
  const columns = ['id', 'autopista', 'fecha', 'hora_aproximada', 'hora_fraccion_original', 'km_reportado', 'sentido', 'tipo', 'lesionados', 'fallecidos', 'longitud_original', 'latitud_original', 'distancia_al_trazo_m', 'advertencias'];
  const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return '\uFEFF' + [columns, ...rows.map(r => [r.id, r.road, r.date, approximateTime(r), r.hourRaw, r.kmRaw, r.direction, r.accidentType, r.injured, r.deaths, r.coordinates[0], r.coordinates[1], r.roadDistanceMeters, r.flags.join('|')])].map(r => r.map(quote).join(',')).join('\r\n');
}
export function median(values) { const sorted = [...values].sort((a,b) => a-b); const i = Math.floor(sorted.length/2); return sorted.length%2 ? sorted[i] : (sorted[i-1]+sorted[i])/2; }
export function nearestOnLines(point, parts) {
  const cos = Math.cos(point[1] * Math.PI / 180);
  let best = null;
  for (const part of parts) for (let i=1; i<part.length; i++) {
    const a=part[i-1], b=part[i];
    const dx=(b[0]-a[0])*cos, dy=b[1]-a[1];
    const length2=dx*dx+dy*dy;
    if (!length2) continue;
    const t=Math.max(0,Math.min(1,(((point[0]-a[0])*cos)*dx+(point[1]-a[1])*dy)/length2));
    const coordinate=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
    const distance2=((coordinate[0]-point[0])*cos)**2+(coordinate[1]-point[1])**2;
    if (!best || distance2<best.distance2) best={coordinate,a,b,distance2};
  }
  return best;
}
export function colorForCount(count, max) {
  const stops=[[29,142,161],[79,176,164],[226,188,83],[231,111,73]];
  const position=Math.max(0,Math.min(1,count/Math.max(1,max)))*3;
  const a=Math.min(2,Math.floor(position)), t=position-a;
  return `rgb(${stops[a].map((c,i)=>Math.round(c+(stops[a+1][i]-c)*t)).join(',')})`;
}
