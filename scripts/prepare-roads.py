#!/usr/bin/env python3
"""Reproduce road selection and spatial QA from the frozen public snapshots.
No network requests are made. Requires only Python standard library.
"""
from pathlib import Path
import json, unicodedata, re, math, collections, gzip
ROOT=Path(__file__).resolve().parents[1] / "data" / "source"
network_snapshot=json.loads(gzip.decompress((ROOT/'cuota-network.raw.geojson.gz').read_bytes()).decode('utf-8'))
net=network_snapshot['features']
acc=[]
for fn in sorted(ROOT.glob('accidentes*.raw.geojson')):
 for f in json.load(open(fn))['features']:
  f['_source_file']=Path(fn).name; acc.append(f)
def norm(s):
 return re.sub(r'[^a-z0-9]','',unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower())
# Explicit mappings between reporting labels and names in the official concession network.
aliases={
 'Nuevo Necaxa - Tihuatlán (PPS)':['Nuevo Necaxa - Ávila Camacho (TC1)','Ávila Camacho - Tihuatlán'],
 'Peñón - Texcoco':['Peñón - Texcoco (PINFRA)'],
 'Cedral - Playa del Cármen':['El Cedral - Tintal - Playa del Carmen'],
 'Perote - Banderilla y Lib. De Xalapa':['Perote - Banderilla','Libramiento de Xalapa'],
 'Amozoc - Perote y Lib. De Perote':['Amozoc - Perote','Libramiento de Perote'],
 'Tuxpan - Tampico (Ozuluama)':['Tuxpan - Tampico, (Tramo Tuxpan - Ozuluama)'],
 'Libramiento Sur de Guadalajara':['Libramiento Sur de Guadalajara (Pacífico Sur)'],
 'Ent. Tulancingo - Nuevo Necaxa':['Tulancingo - Nuevo Necaxa'],
 'Tihuatlán - Tuxpan Puente Tuxpan':['Tihuatlán - Tuxpan incluye Puente Tuxpan'],
 'Jala - Compostela':['Jala - Compostela - Las Varas Incluye Ramal a Compostela'],
 'México - La Marquesa':['Constituyentes - La Marquesa'],
 'Libramiento Norte de San Luis Potosí (Tramo I)':['Libramiento Norte de San Luis Potosí'],
 'Tuxtla Gutiérrez - San Cristobal':['Tuxtla Gutiérrez - San Cristóbal de las Casas'],
 'Libramiento Norte de la Ciudad de México':['Libramiento Norte de la Ciudad de México (ARCO NORTE)'],
 'Puerto México - La Carbonera':['Puerto México-La Carbonera incluye ramal Huachichil'],
 'Ensenada - Tijuana':['Tijuana - Ensenada'],
 'Chamapa - Lechería':['Chamapa-Lechería, inlcuye Ramal Lomas Verdes'],
 'Lagos de Moreno - San Luis Potosí (Villa de Arriaga':['Lagos de Moreno - San Luis Potosí (Villa de Arriaga)'],
 'Libramiento de Chihuahua':['Libramiento Oriente de Chihuahua'],
 'San José del Cabo - Cabo San Lucas (Lib. Los Cabos)':['San José del Cabo - Cabo San Lucas incluye Ramal el Mangle'],
 'Yerbanis - Gómez Palacio':['Yerbanís - Gómez Palacios'],
 'Jantetelco - El Higuerón':['Jantetelco - El Higuerón (Siglo XXI)'],
 'Camargo - Delicias':['Delicias - Camargo. Tramo Jiménez - Chihuahua'],
 'Ventura - Peyote':['Ventura - El Peyote'],
 'Libramiento de Cd. Obregón':['Libramiento de Obregón'],
 'Mazatlán - Culiacán':['Mazatlán - Culiacán (Libramiento de Culiacán, Libramiento de Mazatlán incluye Ramal al Aeropuerto (Pacífico No'],
 'Cardel - Poza Rica':['Cardel - Poza Rica (Tramo Laguna Verde - Gutiérrez Zamora)'],
}
# Name is used in preference to an erroneous concession join for México–Pachuca.
name_overrides={'México - Pachuca':['México - Pachuca','México - Tizayuca'],'Puente Dovalí Jaime':['Puente Dovalí Jaime','Antonio Dovalí Jaime','Puente Antonio Dovalí Jaime']}
byroad=collections.defaultdict(list)
for f in acc: byroad[f['properties']['autoppte']].append(f)
features=[]; selected_byroad={}; selection_report={}
for road,points in sorted(byroad.items()):
 allowed={norm(n) for n in [road]+aliases.get(road,[])}
 selected=[]
 for f in net:
  p=f['properties']
  if road in name_overrides:
   match=norm(p['nombre']) in {norm(v) for v in name_overrides[road]}
  else:
   match=norm(p['autoppte']) in allowed or norm(p['nombre'])==norm(road)
  if not match:continue
  # The source misassigns the México–Pachuca corridor to the Jala concession.
  if road=='Jala - Compostela' and f['geometry']['coordinates'][0][0][0]>-100:continue
  selected.append(f)
 selected_byroad[road]=selected
 lines=[]
 for f in selected:
  g=f['geometry']; cs=g['coordinates']
  if g['type']=='LineString':cs=[cs]
  lines.extend([[[round(c[0],6),round(c[1],6)] for c in line] for line in cs if len(line)>1])
 if lines:
  features.append({'type':'Feature','id':norm(road),'properties':{'road':road,'sourceFeatureCount':len(selected),'sourceLayer':'GEOSSI:red_vial_cuota_concesionario_geo','sourceRoadNames':sorted({f['properties']['nombre'] or '' for f in selected}),'sourceAutopistaNames':sorted({f['properties']['autoppte'] or '' for f in selected}),'sourceUpdatedYears':sorted({(f['properties']['fecha_act'] or '')[:4] for f in selected})},'geometry':{'type':'MultiLineString','coordinates':lines}})
 selection_report[road]={'reportedAccidents':len(points),'sourceSegments':len(selected),'sourceNames':sorted({f['properties']['nombre'] or '' for f in selected}),'sourceConcessions':sorted({f['properties']['autoppte'] or '' for f in selected})}
# Distance to source line; used solely to verify reporting-road/geometry agreement.
R=6371008.8
def distance_to_line(point,lines):
 lon,lat=point; cos=math.cos(math.radians(lat)); best=float('inf'); bestpt=None
 for line in lines:
  for a,b in zip(line,line[1:]):
   ax=math.radians(a[0]-lon)*R*cos;ay=math.radians(a[1]-lat)*R
   bx=math.radians(b[0]-lon)*R*cos;by=math.radians(b[1]-lat)*R
   vx=bx-ax;vy=by-ay;den=vx*vx+vy*vy
   t=max(0,min(1,-(ax*vx+ay*vy)/den)) if den else 0
   xx=ax+t*vx;yy=ay+t*vy;dd=xx*xx+yy*yy
   if dd<best:best=dd;bestpt=[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]
 return (round(math.sqrt(best),2),bestpt) if bestpt else (None,None)
lookup={f['properties']['road']:f['geometry']['coordinates'] for f in features}
checks=[]
for road,points in sorted(byroad.items()):
 for f in points:
  point=f.get('geometry',{}).get('coordinates')
  if point and road in lookup:
   d,snap=distance_to_line(point,lookup[road])
  else:d=snap=None
  checks.append({'sourceFile':f['_source_file'],'sourceFeatureId':f['id'],'road':road,'point':point,'distanceMeters':d,'nearestRoadPoint':snap,'within1000m':d is not None and d<=1000})
for road in selection_report:
 rows=[r for r in checks if r['road']==road]
 ds=sorted(r['distanceMeters'] for r in rows if r['distanceMeters'] is not None)
 selection_report[road]|={'within1000m':sum(r['within1000m'] for r in rows),'medianDistanceMeters':ds[len(ds)//2] if ds else None,'maxDistanceMeters':max(ds) if ds else None}
(ROOT/'roads.prepared.geojson').write_text(json.dumps({'type':'FeatureCollection','features':features},ensure_ascii=False,separators=(',',':')))
(ROOT/'road-alignment-checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2))
(ROOT/'road-selection-report.json').write_text(json.dumps(selection_report,ensure_ascii=False,indent=2))
metadata={'retrievedAtUTC':network_snapshot.get('timeStamp'),'source':'Instituto Mexicano del Transporte, GeoSSI WFS','layer':'GEOSSI:red_vial_cuota_concesionario_geo','sourceFeatureCount':len(net),'query':(ROOT/'full-cuota.url').read_text(),'crs':'EPSG:4326 (GeoJSON longitude, latitude)','processing':'Official line coordinates grouped by reporting road labels using explicit aliases. Coordinate precision rounded to 6 decimal places. No segments created between accident points; no invented connectors. Both carriageways/ramps may be present, so do not use sum of line lengths as highway length.','aliases':aliases,'nameOverrides':name_overrides,'knownSourceIssues':['México - Pachuca / México - Tizayuca lines erroneously have Jala concession name; use road nombre instead.','Jala selection excludes east-central México geometry erroneously assigned to that concession.','Road geometry update dates vary and mostly precede 2025.','Point-to-road checks are QA, not evidence that a reported accident occurred on a different road.'], 'roads':len(features),'rawAccidents':len(acc),'matchedWithin1000m':sum(c['within1000m'] for c in checks),'missingGeometryRoads':[road for road,r in selection_report.items() if not r['sourceSegments']]}
(ROOT/'road-source-metadata.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2))
print(json.dumps({k:metadata[k] for k in ['sourceFeatureCount','roads','rawAccidents','matchedWithin1000m','missingGeometryRoads']},ensure_ascii=False,indent=2))
for road in ['México - Querétaro','México - Pachuca','México - Puebla','México - Cuernavaca','Cuernavaca - Acapulco']:print(road,selection_report[road])
