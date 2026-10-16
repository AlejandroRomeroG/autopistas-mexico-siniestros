import { TimeDial } from './time-dial.js';
import { THEME_STORAGE_KEY, resolveTheme, themeColors, basemapTiles } from './theme.mjs';
import { filterRecords, groupBins, hourLabel, approximateTime, shortDate, escapeHtml as esc, csvEncode, nearestOnLines, colorForCount, numberFormat as nf } from './core.mjs';

const $ = id => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const compactLayout = () => matchMedia('(max-width:760px), (max-width:1100px) and (max-height:500px)').matches;
const state = { roadId: '', period: 'all', start: 0, end: 24, bin: 5, page: 0 };
let data, roadsGeo, map, dial, selectedRoad, selectedFeature, filtered = [], bins = [], anchors = new Map(), scaleMax = 1, barHits = [], markers = [], pendingFrame = false;
const canvas = $('density-overlay');
const ctx = canvas.getContext('2d');
const tooltip = $('map-tooltip');
const pageSize = 15;

function currentTheme(){return document.documentElement.dataset.theme==='dark'?'dark':'light';}
function updateMapTheme(){
  if(!map)return;
  const colors=themeColors(currentTheme());
  map.getSource('basemap')?.setTiles(basemapTiles(currentTheme()));
  map.getSource('basemap-labels')?.setTiles(basemapTiles(currentTheme(),true));
  for(const layer of ['selected-road','accident-points']) if(map.getLayer(layer)) map.setPaintProperty(layer,layer==='selected-road'?'line-color':'circle-color',colors.accent);
  if(map.getLayer('road-halo'))map.setPaintProperty('road-halo','line-color',colors.halo);
  if(map.getLayer('all-roads'))map.setPaintProperty('all-roads','line-color',colors.context);
  if(map.getLayer('accident-points'))map.setPaintProperty('accident-points','circle-stroke-color',colors.halo);
  scheduleDraw();
}
function initializeTheme(){
  const system=matchMedia('(prefers-color-scheme: dark)');
  let preference;try{preference=localStorage.getItem(THEME_STORAGE_KEY);}catch{}
  const apply=theme=>{
    document.documentElement.dataset.theme=theme;
    const button=$('theme-toggle');
    if(button){button.setAttribute('aria-pressed',String(theme==='dark'));button.setAttribute('aria-label',`Cambiar a tema ${theme==='dark'?'claro':'oscuro'}`);button.title=button.getAttribute('aria-label');}
    if($('theme-label'))$('theme-label').textContent=theme==='dark'?'Oscuro':'Claro';
    updateMapTheme();
  };
  apply(resolveTheme(preference,system.matches));
  $('theme-toggle')?.addEventListener('click',()=>{preference=currentTheme()==='dark'?'light':'dark';try{localStorage.setItem(THEME_STORAGE_KEY,preference);}catch{}apply(preference);});
  system.addEventListener('change',event=>{if(preference!=='dark'&&preference!=='light')apply(resolveTheme(null,event.matches));});
}

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`No se pudo cargar ${path} (${response.status}).`);
  return response.json();
}

function geometryForRoad(id) { return roadsGeo.features.find(f => f.properties.roadId === id); }
function partsForFeature(feature) { return feature?.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature?.geometry.coordinates || []; }
function boundsForFeature(feature) {
  const coords = partsForFeature(feature).flat();
  if (!coords.length) return null;
  return coords.reduce((b,c) => [[Math.min(b[0][0],c[0]), Math.min(b[0][1],c[1])],[Math.max(b[1][0],c[0]), Math.max(b[1][1],c[1])]],[[Infinity,Infinity],[-Infinity,-Infinity]]);
}
function selection() { return { ...state }; }
function getRows(changes = {}) { return filterRecords(data.records, { ...selection(), ...changes }); }
function periodLabel() { return state.period === 'all' ? '30 jun–13 jul 2025' : data.periods.find(p => p.id === state.period)?.label || ''; }
function currentScope() { return `${periodLabel()} · ${hourLabel(state.start,state.end)}`; }

function saveView() {
  const url = new URL(location.href);
  url.search = new URLSearchParams({ carretera: state.roadId, semana: state.period, desde: state.start, hasta: state.end, tramo: state.bin }).toString();
  history.replaceState(null, '', url);
}
function restoreView() {
  const params = new URLSearchParams(location.search);
  const roadId = params.get('carretera');
  state.roadId = data.roads.some(r=>r.id===roadId) ? roadId : 'mexico-queretaro';
  if (!data.roads.some(r=>r.id===state.roadId)) state.roadId = data.roads[0].id;
  const period = params.get('semana');
  state.period = data.periods.some(p=>p.id===period) ? period : 'all';
  for (const [key,param,max] of [['start','desde',23],['end','hasta',24]]) {
    const value = params.get(param);
    if (value !== null && /^\d+$/.test(value) && +value <= max) state[key] = +value;
  }
  const bin = +params.get('tramo');
  if ([1,2,5,10,20].includes(bin)) state.bin=bin;
}

function updateWeekButtons() {
  const focusedPeriod=document.activeElement?.closest?.('.week-button')?.dataset.period;
  const options = [{ id:'all', label:'Ambas semanas' }, ...data.periods.map((p,i)=>({ id:p.id, label:i===0?'30 jun – 6 jul':'7 – 13 jul' }))];
  $('week-buttons').replaceChildren(...options.map(option => {
    const button = document.createElement('button');
    button.type='button'; button.className='week-button'; button.dataset.period=option.id;
    button.setAttribute('aria-pressed', String(option.id === state.period));
    const count = getRows({period:option.id}).length;
    button.innerHTML=`<span aria-hidden="true"></span><span class="week-text">${option.label}</span><strong>${nf.format(count)}</strong>`;
    button.setAttribute('aria-label', `${option.label}: ${count} registros en mapa en el horario elegido`);
    button.addEventListener('click',()=>{state.period=option.id; update();});
    return button;
  }));
  if(focusedPeriod) $('week-buttons').querySelector(`[data-period="${focusedPeriod}"]`)?.focus({preventScroll:true});
}

function buildAnchors() {
  anchors = new Map();
  const allBins = groupBins(getRows({period:'all',start:0,end:24}),state.bin);
  scaleMax = Math.max(1,...allBins.map(b=>b.count));
  const parts = partsForFeature(selectedFeature);
  for (const bin of allBins) {
    const ordered=[...bin.records].sort((a,b)=>a.km-b.km);
    const representative=ordered[Math.floor(ordered.length/2)];
    const nearest=nearestOnLines(representative.nearestRoadCoordinates || representative.coordinates,parts);
    if (!nearest) continue;
    anchors.set(bin.id,{...nearest});
  }
}

function update() {
  filtered=getRows();
  bins=groupBins(filtered,state.bin);
  state.page=0;
  const eligible=getRows({mappedOnly:false});
  const omitted=eligible.length-filtered.length;
  const withoutKm=filtered.filter(r=>!Number.isFinite(r.km)).length;
  $('stat-count').textContent=nf.format(filtered.length);
  $('stat-bins').textContent=nf.format(bins.length);
  $('stat-peak').textContent=nf.format(Math.max(0,...bins.map(b=>b.count)));
  $('selection-summary').innerHTML=`<strong>${esc(selectedRoad.name)}</strong><br>${esc(currentScope())}: <strong>${nf.format(filtered.length)}</strong> registros ubicables, agrupados cada ${state.bin} km.`;
  $('coverage-note').textContent=(omitted ? `${nf.format(omitted)} de ${nf.format(eligible.length)} registros del filtro quedan fuera del mapa por ubicación no verificable. ` : 'Los registros del filtro superan los controles de fecha y ubicación. ')+(withoutKm ? `${withoutKm} registro en mapa no tiene kilometraje interpretable y se muestra sin barra. ` : '')+'Consulta la metodología.';
  $('legend-max').textContent=`${scaleMax} registros`;
  $('map-caption-text').textContent=`${nf.format(filtered.length)} registros en mapa · ${periodLabel()}`;
  $('road-label').textContent=selectedRoad.name.replaceAll(' - ',' – ');
  $('empty-state').hidden=filtered.length>0;
  const allDay=state.start%24===state.end%24;
  $('empty-state').querySelector('strong').textContent=eligible.length && !filtered.length ? 'Sin registros ubicables para este filtro' : selectedRoad.mainCount===0 ? 'Sin registros con fecha válida' : 'Sin registros en este filtro';
  $('empty-state').querySelector('p').textContent=eligible.length ? 'La ubicación de estos registros no supera los controles del piloto. Consulta los datos completos en metodología.' : selectedRoad.mainCount===0 ? 'La fuente sólo reporta registros con fechas fuera de las semanas anunciadas para esta carretera.' : allDay ? 'Prueba la otra semana o explora una autopista distinta.' : 'Prueba otro rango de horas o restablece el reloj.';
  $('empty-reset').hidden=allDay;
  updateWeekButtons();
  if (map?.getSource('accidents')) map.getSource('accidents').setData({type:'FeatureCollection',features:filtered.map(r=>({type:'Feature',id:r.id,properties:{recordId:r.id},geometry:{type:'Point',coordinates:r.coordinates}}))});
  saveView();
  scheduleDraw();
  if ($('records-dialog').open) renderRecords();
}

function selectRoad(id, fit=true) {
  state.roadId=id;
  selectedRoad=data.roads.find(r=>r.id===id);
  selectedFeature=geometryForRoad(id);
  $('road-select').value=id;
  buildAnchors();
  if (map?.getSource('selected-road')) map.getSource('selected-road').setData({type:'FeatureCollection',features:selectedFeature?[selectedFeature]:[]});
  update();
  updateMarkers();
  if (fit) fitRoad();
}

function fitRoad() {
  if (!map) return;
  const bounds=boundsForFeature(selectedFeature);
  if (!bounds) {map.fitBounds([[-117.5,14.7],[-86.7,32.7]],{padding:50,duration:reduceMotion?0:1100});return;}
  const narrow=compactLayout();
  const h=canvas.clientHeight,w=canvas.clientWidth;
  const mapRect=$('map').getBoundingClientRect(),filterRect=$('sidebar').getBoundingClientRect(),dockRect=document.querySelector('.exploration-dock')?.getBoundingClientRect();
  const topCover=document.body.classList.contains('panel-collapsed')?55:Math.max(55,filterRect.bottom-mapRect.top+18);
  const bottomCover=dockRect?Math.max(40,mapRect.bottom-dockRect.top+22):50;
  const maxCoveredHeight=h*.65,coverageScale=Math.min(1,maxCoveredHeight/(topCover+bottomCover));
  const padding={top:topCover*coverageScale,bottom:bottomCover*coverageScale,left:narrow?Math.min(30,w*.1):Math.min(70,w*.1),right:narrow?Math.min(30,w*.1):Math.min(230,w*.2)};
  map.fitBounds(bounds,{padding,maxZoom:12.3,duration:reduceMotion?0:1150,essential:false});
}

function updateMarkers() {
  markers.forEach(marker=>marker.remove()); markers=[];
  if (!map) return;
  const bounds=map.getBounds();
  const candidates=data.roads.filter(r=>r.id!==state.roadId && r.mappedCount>=10).map(r=>({road:r,feature:geometryForRoad(r.id)})).filter(x=>x.feature).map(x=>{
    const b=boundsForFeature(x.feature); return {...x,center:[(b[0][0]+b[1][0])/2,(b[0][1]+b[1][1])/2]};
  }).filter(x=>bounds.contains(x.center)).sort((a,b)=>b.road.mappedCount-a.road.mappedCount).slice(0,4);
  for (const {road,center} of candidates) {
    const button=document.createElement('button');button.type='button';button.className='road-marker';button.textContent=road.name.replaceAll(' - ','–');
    button.setAttribute('aria-label',`Explorar ${road.name}, ${road.mappedCount} registros ubicables en ambas semanas`);
    const show=()=>{const p=map.project(center);showTooltip(p.x,p.y,`<strong>${esc(road.name)}</strong><span>${road.mappedCount} registros ubicables</span><br><span class="muted">30 jun–13 jul 2025 · Pulsa para explorar</span>`);};
    button.addEventListener('mouseenter',show);button.addEventListener('focus',show);button.addEventListener('mouseleave',hideTooltip);button.addEventListener('blur',hideTooltip);
    button.addEventListener('click',()=>{hideTooltip();selectRoad(road.id);});
    markers.push(new maplibregl.Marker({element:button}).setLngLat(center).addTo(map));
  }
}

function scheduleDraw() {if(pendingFrame)return;pendingFrame=true;requestAnimationFrame(()=>{pendingFrame=false;drawBars();});}
function drawBars() {
  if (!map||!selectedFeature) {ctx.clearRect(0,0,canvas.width,canvas.height);barHits=[];return;}
  const width=canvas.clientWidth,height=canvas.clientHeight,dpr=Math.min(devicePixelRatio||1,2);
  if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);barHits=[];
  const maxHeight=Math.min(150,Math.max(80,width*.12),height*.28);
  const allRecords=getRows({period:'all',start:0,end:24}).sort((a,b)=>a.km-b.km);
  const first=allRecords[0]?.coordinates,last=allRecords.at(-1)?.coordinates;
  const globalVector=first&&last?[last[0]-first[0],last[1]-first[1]]:[1,1];
  for(const bin of bins){
    const anchor=anchors.get(bin.id);if(!anchor)continue;
    const p=map.project(anchor.coordinate),a=map.project(anchor.a),b=map.project(anchor.b);
    let vx=b.x-a.x,vy=b.y-a.y;
    if((anchor.b[0]-anchor.a[0])*globalVector[0]+(anchor.b[1]-anchor.a[1])*globalVector[1]<0){vx=-vx;vy=-vy;}
    const length=Math.hypot(vx,vy);if(length<.00001)continue;
    const tx=vx/length,ty=vy/length,nx=ty,ny=-tx;
    const ref=map.project([anchor.coordinate[0]+state.bin/(111.32*Math.cos(anchor.coordinate[1]*Math.PI/180)),anchor.coordinate[1]]);
    const bw=Math.max(4,Math.min(32,Math.abs(ref.x-p.x)*.77));
    const h=bin.count/scaleMax*maxHeight;
    const points=[{x:p.x-tx*bw/2,y:p.y-ty*bw/2},{x:p.x+tx*bw/2,y:p.y+ty*bw/2},{x:p.x+tx*bw/2+nx*h,y:p.y+ty*bw/2+ny*h},{x:p.x-tx*bw/2+nx*h,y:p.y-ty*bw/2+ny*h}];
    if(points.every(c=>c.x<-200||c.x>width+200||c.y<-200||c.y>height+200))continue;
    ctx.beginPath();points.forEach((c,i)=>i?ctx.lineTo(c.x,c.y):ctx.moveTo(c.x,c.y));ctx.closePath();
    ctx.fillStyle=colorForCount(bin.count,scaleMax);ctx.globalAlpha=.85;ctx.fill();ctx.globalAlpha=1;ctx.strokeStyle='#ffffff9c';ctx.lineWidth=.7;ctx.stroke();
    barHits.push({bin,points});
  }
}

function inPolygon(point,polygon){let inside=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;}
function showTooltip(x,y,html){tooltip.innerHTML=html;tooltip.hidden=false;const w=tooltip.offsetWidth,h=tooltip.offsetHeight;tooltip.style.left=`${Math.max(8,Math.min(canvas.clientWidth-w-8,x+15))}px`;tooltip.style.top=`${Math.max(8,Math.min(canvas.clientHeight-h-8,y-h-12))}px`;}
function hideTooltip(){tooltip.hidden=true;}
function inspectMap(event){
  if(map.isMoving())return hideTooltip();
  const hit=barHits.find(h=>inPolygon(event.point,h.points));
  if(hit){const b=hit.bin;showTooltip(event.point.x,event.point.y,`<strong>${esc(selectedRoad.name)}</strong><span>Km ${nf.format(b.from)} a menos de ${nf.format(b.to)}</span><div class="tooltip-count">${b.count} <span style="font-size:11px;font-weight:500">registros</span></div><span class="muted">${esc(currentScope())}</span>`);map.getCanvas().style.cursor='pointer';return;}
  const features=map.queryRenderedFeatures(event.point,{layers:map.getLayer('accident-points')?['accident-points']:[]});
  if(features.length){const r=data.records.find(r=>r.id===features[0].properties.recordId);if(r){showTooltip(event.point.x,event.point.y,`<strong>${esc(r.accidentType)}</strong><span>${shortDate(r.date)} · ≈ ${approximateTime(r)} · km ${esc(r.kmRaw)}</span><br><span class="muted">${esc(r.road)} · ${esc(r.direction)}<br>${r.injured} lesionados · ${r.deaths} fallecidos</span>`);map.getCanvas().style.cursor='pointer';return;}}
  hideTooltip();map.getCanvas().style.cursor='';
}

function createMap() {
  const colors=themeColors(currentTheme());
  map=new maplibregl.Map({container:'map',center:[-99.5,20.2],zoom:7.2,maxZoom:16,canvasContextAttributes:{antialias:true,preserveDrawingBuffer:true},attributionControl:true,style:{version:8,sources:{basemap:{type:'raster',tiles:basemapTiles(currentTheme()),tileSize:256,maxzoom:16,attribution:'Tiles © Esri · Sources: Esri, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'},'basemap-labels':{type:'raster',tiles:basemapTiles(currentTheme(),true),tileSize:256,maxzoom:16}},layers:[{id:'basemap',type:'raster',source:'basemap'},{id:'basemap-labels',type:'raster',source:'basemap-labels'}]}});
  map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');
  map.on('load',()=>{
    map.addSource('all-roads',{type:'geojson',data:roadsGeo});
    map.addLayer({id:'all-roads',type:'line',source:'all-roads',paint:{'line-color':themeColors(currentTheme()).context,'line-width':1,'line-opacity':.35}});
    map.addSource('selected-road',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
    map.addLayer({id:'road-halo',type:'line',source:'selected-road',paint:{'line-color':themeColors(currentTheme()).halo,'line-width':6,'line-opacity':.65}});
    map.addLayer({id:'selected-road',type:'line',source:'selected-road',paint:{'line-color':themeColors(currentTheme()).accent,'line-width':2.6,'line-opacity':.95}});
    map.addSource('accidents',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
    map.addLayer({id:'accident-points',type:'circle',source:'accidents',paint:{'circle-color':themeColors(currentTheme()).accent,'circle-radius':['interpolate',['linear'],['zoom'],5,2,10,3.3,14,5],'circle-stroke-width':1,'circle-stroke-color':themeColors(currentTheme()).halo,'circle-opacity':.85}});
    updateMapTheme();
    selectRoad(state.roadId);
    $('loading').hidden=true;
  });
  map.on('render',scheduleDraw);
  map.on('moveend',updateMarkers);
  map.on('mousemove',inspectMap);
  map.on('mouseout',hideTooltip);
  map.on('movestart',hideTooltip);
  map.on('click',event=>{const hit=barHits.find(h=>inPolygon(event.point,h.points));if(hit){openRecords();}});
  let tileErrorShown=false;
  map.on('error',event=>{if(event.error?.message?.includes('tile')&&!tileErrorShown){tileErrorShown=true;$('map-error').textContent='El fondo cartográfico no se pudo cargar. Los trazados y los registros siguen disponibles.';$('map-error').hidden=false;}});
  new ResizeObserver(()=>{map.resize();scheduleDraw();}).observe($('map'));
}

function renderSources() {
  const m=data.metadata;
  const raw=data.records.length,period=data.records.filter(r=>r.mainEligible).length,mapped=data.records.filter(r=>r.densityEligible).length;
  const outside=raw-period,unmapped=period-mapped;
  $('source-content').innerHTML=`
    <h3>Dos semanas de registros publicados</h3><p>Capas de accidentes de la red de cuota de la <a href="https://rnc.imt.mx/geossi/" target="_blank" rel="noopener">GeoPlataforma SICT / IMT</a>: <strong>30 de junio–6 de julio</strong> y <strong>7–13 de julio de 2025</strong>. Esta es una descarga histórica; no representa la totalidad de los siniestros, de las autopistas o del país.</p>
    <div class="audit-strip"><div><strong>${raw}</strong><span>registros de origen</span></div><div><strong>${period}</strong><span>dentro del periodo</span></div><div><strong>${mapped}</strong><span>ubicables para el mapa</span></div></div>
    <h3>Qué entra al mapa</h3><p>Cada conteo corresponde a un registro publicado, no a un evento único confirmado. Se conservan los posibles duplicados porque no hay una clave de evento documentada.</p><p>Se excluyen <strong>${outside}</strong> fechas fuera de la semana anunciada y <strong>${unmapped}</strong> registros del periodo sin trazo asignado o a más de 1 km del trazo oficial. Un registro ubicable tiene un kilometraje ambiguo: aparece como punto, pero no alimenta las barras. Los registros originales y las advertencias se conservan en la descarga completa. No se corrigen sus fechas ni posiciones.</p>
    <h3 id="hour-explanation">Horas aproximadas</h3><p>La fuente publica la hora como valores entre 0 y 1 con dos decimales. El piloto los interpreta como <strong>fracciones de un día</strong> (valor × 24 horas). Es una interpretación inferida de los valores, sin diccionario de la capa que confirme la codificación. Su resolución observada equivale a <strong>14.4 minutos</strong>; no permite recuperar minutos exactos.</p><p>El reloj filtra estas horas aproximadas, incluyendo el inicio y excluyendo el final. Un intervalo de 22:00 a 06:00 combina ambos lados de medianoche dentro de las fechas seleccionadas. El valor original 1 se muestra como medianoche aproximada, con una advertencia. No se aplica conversión de zona horaria. Extremos iguales significan todo el día.</p>
    <h3>Tramos y geometría</h3><p>Las barras cuentan registros por intervalos del <strong>kilometraje reportado</strong>, sumando ambos sentidos. Cada barra se ancla al trazo oficial más próximo a un registro representativo del tramo. La altura y el color expresan el conteo; el ancho se adapta a la escala del mapa. La escala se mantiene fija al cambiar horas o semana para una misma autopista y tamaño de tramo.</p><p>Los trazados proceden de la capa <code>red_vial_cuota_concesionario_geo</code> del IMT, con alias explícitos entre sus nombres y los de los accidentes. Se preservan calzadas y ramales; su suma no se presenta como longitud de la autopista. La geometría disponible puede ser anterior a 2025. Un tramo sin barra indica ausencia de registros seleccionados, sin acreditar cobertura o ausencia real de siniestros.</p>
    <h3>Revisión de históricos · 16 de octubre de 2026</h3><p>Se revisaron las capas públicas del IMT, reportes de CAPUFE y el catálogo histórico de Policía Federal. Los archivos descargables revisados de CAPUFE son agregados sin ubicación ni hora por evento. El enlace original del histórico de Policía Federal está caído y no se recuperó una copia de datos verificable. Por eso el piloto conserva estas dos semanas y no genera puntos a partir de totales.</p><p>Siniestralimap de Jalisco sí ofrece 2015–2025, pero cubre siniestros con víctimas en municipios metropolitanos y georreferencia al cruce vial más cercano; no respalda una serie nacional de autopistas de cuota. <a href="./data/history-search.json" target="_blank" rel="noopener">Consultar fuentes revisadas y opciones para ampliar ↗</a>.</p>
    <h3>Consulta y reutilización</h3><p>Fuentes: <a href="https://rnc.imt.mx/geossi/" target="_blank" rel="noopener">GeoPlataforma SICT</a> y <a href="https://rnc.imt.mx/geossi/recursos/ol3.js" target="_blank" rel="noopener">definición pública de las capas</a>. Fondo: Esri y sus contribuidores. Motor: MapLibre GL JS 5.6.0, distribuido con su licencia BSD.</p>
    <div class="source-links"><a href="./data/pilot.json" target="_blank" download="piloto-siniestros.json">Datos completos + advertencias · JSON</a><a href="./data/audit.json" target="_blank" download="auditoria-siniestros.json">Auditoría · JSON</a><a href="https://github.com/AlejandroRomeroG/autopistas-mexico-siniestros" target="_blank" rel="noopener">Código y reproducción ↗</a></div>`;
}

function openRecords(){state.page=0;renderRecords();$('records-dialog').showModal();}
function renderRecords(){
  const rows=[...filtered].sort((a,b)=>a.date.localeCompare(b.date)||a.hourApprox-b.hourApprox||a.km-b.km);
  const pages=Math.max(1,Math.ceil(rows.length/pageSize));
  state.page=Math.max(0,Math.min(state.page,pages-1));
  $('records-heading').textContent=selectedRoad.name;
  $('records-description').textContent=`${nf.format(rows.length)} registros en mapa · ${currentScope()}. Horas aproximadas según la interpretación descrita en metodología.`;
  $('records-pagination').textContent=`${state.page+1} / ${pages}`;
  $('records-prev').disabled=state.page===0;$('records-next').disabled=state.page>=pages-1;
  $('records-body').innerHTML=rows.slice(state.page*pageSize,(state.page+1)*pageSize).map(r=>`<tr><td>${shortDate(r.date)}</td><td>≈ ${approximateTime(r)}</td><td>${esc(r.kmRaw)}</td><td>${esc(r.accidentType)}</td><td>${r.injured}</td><td>${r.deaths}</td></tr>`).join('') || '<tr><td colspan="6">No hay registros para el filtro actual.</td></tr>';
}
function exportCsv(){
  const blob=new Blob([csvEncode(filtered)],{type:'text/csv;charset=utf-8;'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`${state.roadId}_${state.period}_${state.start}-${state.end}h.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function resetHours(){state.start=0;state.end=24;dial.setRange(0,24);update();}

async function init(){
  try{
    [data,roadsGeo]=await Promise.all([loadJson('./data/pilot.json'),loadJson('./data/roads.geojson')]);
    restoreView();
    $('road-select').replaceChildren(...[...data.roads].sort((a,b)=>a.name.localeCompare(b.name,'es')).map(road=>{const option=document.createElement('option');option.value=road.id;option.textContent=`${road.name} · ${road.mappedCount} ubicables`;return option;}));
    $('road-select').value=state.roadId;$('bin-select').value=String(state.bin);
    dial=new TimeDial($('time-dial'),{start:state.start,end:state.end,onChange:range=>{Object.assign(state,range);update();}});
    selectRoad(state.roadId,false);
    if(compactLayout()){document.body.classList.add('panel-collapsed');$('sidebar').inert=true;$('panel-toggle').setAttribute('aria-expanded','false');$('panel-toggle').setAttribute('aria-label','Mostrar panel');}
    $('road-select').addEventListener('change',event=>selectRoad(event.target.value));
    $('bin-select').addEventListener('change',event=>{state.bin=+event.target.value;buildAnchors();update();});
    $('road-form').addEventListener('submit',event=>{event.preventDefault();if(compactLayout()){document.body.classList.add('panel-collapsed');$('sidebar').inert=true;$('panel-toggle').setAttribute('aria-expanded','false');$('panel-toggle').setAttribute('aria-label','Mostrar panel');$('panel-toggle').focus();}fitRoad();});
    $('panel-toggle').addEventListener('click',()=>{const collapsed=document.body.classList.toggle('panel-collapsed');$('sidebar').inert=collapsed;$('panel-toggle').setAttribute('aria-expanded',String(!collapsed));$('panel-toggle').setAttribute('aria-label',collapsed?'Mostrar panel':'Ocultar panel');setTimeout(()=>{map.resize();scheduleDraw();},260);});
    $('close-panel').addEventListener('click',()=>{document.body.classList.add('panel-collapsed');$('sidebar').inert=true;$('panel-toggle').setAttribute('aria-expanded','false');$('panel-toggle').setAttribute('aria-label','Mostrar panel');$('panel-toggle').focus();});
    $('view-toggle').addEventListener('click',()=>{const tilt=map.getPitch()<10;$('view-toggle').setAttribute('aria-pressed',String(tilt));$('view-toggle').setAttribute('aria-label',tilt?'Volver a vista plana':'Inclinar el mapa');map.easeTo({pitch:tilt?48:0,duration:reduceMotion?0:800});});
    $('reset-hours').addEventListener('click',resetHours);$('empty-reset').addEventListener('click',resetHours);
    $('open-sources').addEventListener('click',()=>$('sources-dialog').showModal());
    $('hour-method').addEventListener('click',()=>{$('sources-dialog').showModal();$('hour-explanation').scrollIntoView({block:'start'});});
    $('open-records').addEventListener('click',openRecords);
    $('download-csv').addEventListener('click',exportCsv);
    $('records-prev').addEventListener('click',()=>{state.page--;renderRecords();});$('records-next').addEventListener('click',()=>{state.page++;renderRecords();});
    for(const dialog of document.querySelectorAll('dialog')){dialog.querySelector('.close-dialog').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});}
    renderSources();createMap();
  }catch(error){console.error(error);$('loading').innerHTML=`<div style="padding:30px;max-width:420px;text-align:center"><strong>No se pudo preparar el mapa</strong><p>${esc(error.message)}</p><p>Recarga la página. Los datos también están disponibles en el repositorio.</p><a href="https://github.com/AlejandroRomeroG/autopistas-mexico-siniestros">Abrir repositorio ↗</a></div>`;}
}
initializeTheme();
init();
