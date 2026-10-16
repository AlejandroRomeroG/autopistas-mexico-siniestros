#!/usr/bin/env python3
"""Download and audit the two public GeoSSI pilot layers, using only stdlib.

Run `python3 scripts/prepare-data.py --download` to refresh the original responses or
`python3 scripts/prepare-data.py` to reproduce the clean JSON and audit from the snapshots.
No source values are corrected, no candidate duplicates are removed, and no
coordinates are inferred from the often malformed text latitude/longitude fields.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import unicodedata
import urllib.parse

HERE = Path(__file__).resolve().parents[1] / "data" / "source"
WFS = "https://rnc.imt.mx/geoserver/GEOSSI/wfs"
VIEWER = "https://rnc.imt.mx/geossi/"
JS_SOURCE = VIEWER + "recursos/ol3.js"
EXCEL_REFERENCE = "https://support.microsoft.com/en-gb/excel/change-the-date-system-format-or-two-digit-year-interpretation"
PERIODS = [
    {"id": "2025-06-30_2025-07-06", "label": "30 jun – 6 jul 2025", "start": "2025-06-30", "end": "2025-07-06", "layer": "accidentes30jun6jul2025datos"},
    {"id": "2025-07-07_2025-07-13", "label": "7 – 13 jul 2025", "start": "2025-07-07", "end": "2025-07-13", "layer": "accidentes7_13jul2025datos"},
]
DUPLICATE_FIELDS = ["autoppte", "sentido", "km", "fecha", "hora", "tsini", "causa", "tipoveh", "nolesion", "nodeces"]


def url_for(layer):
    return WFS + "?" + urllib.parse.urlencode({
        "service": "WFS", "version": "1.0.0", "request": "GetFeature",
        "typeName": "GEOSSI:" + layer, "outputFormat": "application/json",
    })


def normalized_text(value):
    return re.sub(r"\s+", " ", str(value or "").strip())


def slug(value):
    ascii_text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")


def parse_km(value):
    compact = re.sub(r"\s+", "", str(value))
    match = re.fullmatch(r"(\d+)\+(\d{3})", compact)
    if match:
        return int(match.group(1)) + int(match.group(2)) / 1000, None
    if "+" in compact:
        return None, "chainage_short_or_malformed_suffix"
    if re.fullmatch(r"\d+(?:\.\d+)?", compact):
        return float(compact), None
    return None, "chainage_unparseable"


def decode_date(value):
    # For contemporary Excel serial dates the 1899-12-30 origin preserves the
    # historical 1900 leap-year compatibility adjustment.
    if not isinstance(value, (float, int)) or not math.isfinite(value) or value != int(value):
        return None
    try:
        return (dt.date(1899, 12, 30) + dt.timedelta(days=value)).isoformat()
    except (OverflowError, ValueError):
        return None


def haversine_meters(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 12742000 * math.asin(min(1, math.sqrt(h)))


def is_valid_geometry(geometry):
    if not geometry or geometry.get("type") != "Point":
        return False
    coordinates = geometry.get("coordinates", [])
    return len(coordinates) == 2 and all(isinstance(n, (int, float)) and math.isfinite(n) for n in coordinates) and -118.5 <= coordinates[0] <= -86 and 14 <= coordinates[1] <= 33.5


def write_json(name, data):
    (HERE / name).write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    records, sources, raw_features = [], [], []
    for period in PERIODS:
        raw_path = HERE / (period["layer"] + ".raw.geojson")
        source_url = url_for(period["layer"])
        if args.download:
            temporary_path = raw_path.with_suffix(raw_path.suffix + ".tmp")
            subprocess.run(["curl", "--fail", "--location", "--max-time", "60", "--silent", "--show-error", source_url, "--output", str(temporary_path)], check=True)
            # Never replace the previous snapshot with a challenge/error page.
            response = json.loads(temporary_path.read_text(encoding="utf-8-sig"))
            if response.get("type") != "FeatureCollection":
                raise ValueError("Response is not a GeoJSON FeatureCollection: " + period["layer"])
            temporary_path.replace(raw_path)
        raw_bytes = raw_path.read_bytes()
        source = json.loads(raw_bytes.decode("utf-8-sig"))
        features = source["features"]
        advertised_count = source.get("numberMatched", source.get("totalFeatures"))
        if advertised_count is not None and int(advertised_count) != len(features):
            raise ValueError("Incomplete WFS response: " + period["layer"])
        sources.append({
            "layer": period["layer"], "periodId": period["id"], "url": source_url,
            "rawFile": raw_path.name, "sha256": hashlib.sha256(raw_bytes).hexdigest(),
            "serverTimestamp": source.get("timeStamp"), "rawCount": len(features),
            "advertisedCount": advertised_count, "crs": source.get("crs"),
        })
        for feature in features:
            p = feature["properties"]
            flags = []
            raw_features.append((feature, p))
            date = decode_date(p.get("fecha"))
            date_within_period = date is not None and period["start"] <= date <= period["end"]
            if date is None:
                flags.append("date_unparseable")
            elif not date_within_period:
                flags.append("date_outside_source_period")
            raw_hour = p.get("hora")
            valid_hour = isinstance(raw_hour, (int, float)) and math.isfinite(raw_hour) and 0 <= raw_hour <= 1
            # A value 1 is retained as an ambiguous midnight boundary and wrapped
            # to 00:00 for the circular approximate-hour control, with no date shift.
            minute_approx = round((raw_hour % 1) * 1440) if valid_hour else None
            if not valid_hour:
                flags.append("hour_outside_fraction_day_range")
            elif raw_hour == 1:
                flags.append("hour_midnight_boundary_ambiguous")
            km, km_flag = parse_km(p.get("km"))
            if km_flag:
                flags.append(km_flag)
            source_aux_id = p.get("id")
            if km is not None and isinstance(source_aux_id, (int, float)) and abs(source_aux_id - km * 1000) > 1:
                flags.append("chainage_auxiliary_id_mismatch")
            geometry_valid = is_valid_geometry(feature.get("geometry"))
            if not geometry_valid:
                flags.append("geometry_invalid_or_outside_mexico_bounds")
            accident_type = normalized_text(p.get("tsini")) or None
            cause = normalized_text(p.get("causa")) or None
            if accident_type is None:
                flags.append("accident_type_missing")
            if cause is None or cause == "0":
                flags.append("cause_missing_or_unspecified")
            road = normalized_text(p.get("autoppte"))
            records.append({
                "id": feature["id"], "sourceLayer": period["layer"], "periodId": period["id"],
                "road": road, "roadKey": slug(road), "direction": normalized_text(p.get("sentido")),
                "kmRaw": p.get("km"), "km": km, "sourceAuxiliaryId": source_aux_id,
                "dateRaw": p.get("fecha"), "date": date, "dateWithinPeriod": date_within_period,
                "hourRaw": raw_hour, "minuteOfDayApprox": minute_approx,
                "hourApprox": round((raw_hour % 1) * 24, 4) if valid_hour else None,
                "coordinates": feature.get("geometry", {}).get("coordinates"),
                "geometryValid": geometry_valid, "accidentType": accident_type,
                "cause": cause, "vehicle": normalized_text(p.get("tipoveh")),
                "injured": p.get("nolesion"), "deaths": p.get("nodeces"),
                "mainEligible": date_within_period and geometry_valid,
                "temporalEligible": date_within_period and geometry_valid and valid_hour,
                "flags": flags,
            })
    ids = [r["id"] for r in records]
    if len(ids) != len(set(ids)):
        raise ValueError("GeoServer feature IDs are not unique across the selected layers")
    by_id = {r["id"]: r for r in records}
    alignment_path = HERE / "road-alignment-checks.json"
    alignment_metadata = None
    if alignment_path.exists():
        alignment_bytes = alignment_path.read_bytes()
        alignment_rows = json.loads(alignment_bytes)
        alignment_by_id = {r["sourceFeatureId"]: r for r in alignment_rows}
        if len(alignment_by_id) != len(alignment_rows):
            raise ValueError("Repeated feature ID in road alignment checks")
        alignment_metadata = {
            "file": "road-alignment-checks.json",
            "sha256": hashlib.sha256(alignment_bytes).hexdigest(),
            "thresholdMeters": 1000,
            "method": "Distancia mínima del punto publicado al trazo oficial de la autopista con el mismo nombre. Umbral de elegibilidad para dibujar densidad; no corrige posición ni demuestra que la fuente esté equivocada. Geometría vial de otra fecha puede contribuir a la discrepancia.",
        }
        for record in records:
            alignment = alignment_by_id.get(record["id"])
            # Reject stale/mismatched QA rather than silently matching on an ID.
            if alignment and (alignment["point"] != record["coordinates"] or alignment["road"] != record["road"]):
                raise ValueError("Road alignment snapshot differs from source row: " + record["id"])
            available = alignment is not None and alignment["distanceMeters"] is not None
            record["roadDistanceMeters"] = alignment["distanceMeters"] if alignment else None
            record["nearestRoadCoordinates"] = alignment["nearestRoadPoint"] if alignment else None
            record["roadAlignmentChecked"] = available
            record["alignmentEligible"] = bool(available and alignment["within1000m"])
            record["densityEligible"] = record["mainEligible"] and record["alignmentEligible"]
            if not available:
                record["flags"].append("road_geometry_unavailable_for_alignment")
            elif not alignment["within1000m"]:
                record["flags"].append("road_alignment_gt_1000m")
    groups = collections.defaultdict(list)
    for feature, p in raw_features:
        signature = json.dumps({k: normalized_text(p.get(k)) for k in DUPLICATE_FIELDS}, sort_keys=True, ensure_ascii=False)
        groups[signature].append(feature)
    duplicate_groups = []
    for group in groups.values():
        if len(group) < 2:
            continue
        group_id = "candidate-" + str(len(duplicate_groups) + 1)
        feature_ids = [f["id"] for f in group]
        for feature_id in feature_ids:
            by_id[feature_id]["flags"].append("possible_duplicate_attributes")
            by_id[feature_id]["duplicateCandidateGroup"] = group_id
        separation = max(haversine_meters(a["geometry"]["coordinates"], b["geometry"]["coordinates"]) for a in group for b in group)
        duplicate_groups.append({"id": group_id, "recordIds": feature_ids, "maxGeometrySeparationMeters": round(separation, 2), "removed": False})
    by_road = collections.defaultdict(list)
    for record in records:
        by_road[record["road"]].append(record)
    road_summaries = []
    for road in sorted(by_road):
        rows = by_road[road]
        road_summaries.append({
            "name": road, "key": slug(road), "rawCount": len(rows),
            "mainCount": sum(r["mainEligible"] for r in rows),
            "temporalCount": sum(r["temporalEligible"] for r in rows),
            "densityCount": sum(r.get("densityEligible", False) for r in rows) if alignment_metadata else None,
            "periods": [{"periodId": p["id"], "rawCount": sum(r["periodId"] == p["id"] for r in rows), "mainCount": sum(r["periodId"] == p["id"] and r["mainEligible"] for r in rows), "densityCount": sum(r["periodId"] == p["id"] and r.get("densityEligible", False) for r in rows) if alignment_metadata else None} for p in PERIODS],
        })
    period_summaries = []
    for p in PERIODS:
        rows = [r for r in records if r["periodId"] == p["id"]]
        period_summaries.append({**p, "rawCount": len(rows), "mainCount": sum(r["mainEligible"] for r in rows), "temporalCount": sum(r["temporalEligible"] for r in rows), "densityCount": sum(r.get("densityEligible", False) for r in rows) if alignment_metadata else None, "outsidePeriodCount": sum(not r["dateWithinPeriod"] for r in rows)})
    coordinates = [r["coordinates"] for r in records if r["geometryValid"]]
    bounds = [min(c[0] for c in coordinates), min(c[1] for c in coordinates), max(c[0] for c in coordinates), max(c[1] for c in coordinates)]
    flags = collections.Counter(flag for record in records for flag in record["flags"])
    metadata = {
        "schemaVersion": 1, "title": "Piloto de registros de accidentes en autopistas de cuota",
        "source": "GeoPlataforma SICT / Instituto Mexicano del Transporte",
        "sourceViewerUrl": VIEWER, "sourceCodeUrl": JS_SOURCE, "sources": sources,
        "coverage": "Dos capas semanales publicadas para red de cuota; no representa todos los siniestros ni toda la red carretera de México.",
        "recordGrain": "Un feature del servicio WFS; conteos de registros publicados, sin deduplicación confirmada de eventos.",
        "rawCount": len(records), "mainCount": sum(r["mainEligible"] for r in records),
        "temporalCount": sum(r["temporalEligible"] for r in records), "roadNameCount": len(by_road), "bounds": bounds,
        "densityCount": sum(r.get("densityEligible", False) for r in records) if alignment_metadata else None,
        "roadAlignment": alignment_metadata,
        "dateMethod": "Conversión inferida de serial Excel 1900 (base contemporánea 1899-12-30). Se conservan fecha raw y fecha derivada. Los registros fuera de la semana anunciada se excluyen mediante mainEligible=false; no se corrigen ni trasladan de periodo.",
        "hourMethod": "Interpretación inferida, no confirmada por diccionario GeoSSI: hora como fracción de día, hora aproximada=(horaRaw mod 1)*24 y minuto aproximado=round((horaRaw mod 1)*1440). Todos los valores publicados tienen como máximo dos decimales: paso observado 0.01 día=14.4 minutos. No se recuperan minutos exactos ni se supone zona horaria. Hora raw=1 se representa como medianoche aproximada con flag de frontera ambigua, sin cambiar la fecha.",
        "hourPrecision": "Aproximada; resolución observada de 14.4 minutos, método de redondeo upstream desconocido.",
        "dateHourEncodingStatus": "inferred_from_values_not_confirmed_by_layer_documentation",
        "excelConventionReferenceUrl": EXCEL_REFERENCE,
        "geometryMethod": "Se conserva únicamente la geometría Point EPSG:4326 publicada; no se reconstruye desde las cadenas textuales latitud/longitud, que incluyen ceros y formatos heterogéneos. La posición no se interpreta como medición GPS verificada.",
        "duplicateMethod": "Se marcan coincidencias en autopista, sentido, km, fecha, hora, tipo, causa, vehículo, lesionados y decesos. No se elimina ninguna: faltan identificadores de evento confirmados y hay coincidencias con geometrías distantes.",
        "chainageMethod": "El valor id de propiedades coincide con km*1000 en la gran mayoría de filas; discrepancias se marcan como prueba auxiliar de consistencia, sin corregir kilometraje ni coordenadas y sin asumir que id sea clave de evento.",
        "displayGuidance": "Usar mainEligible para registros dentro del periodo y densityEligible para barras sobre autopistas cuando la auditoría de alineación esté presente. Diferenciar registros totales del periodo y registros alineados usados en barras. Etiquetar conteos como registros y horas como aproximadas. Las densidades son conteos, no riesgo ajustado por tránsito.",
        "refreshCommand": "python3 scripts/prepare-data.py --download",
        "reproduceCommand": "python3 scripts/prepare-data.py",
    }
    clean = {"metadata": metadata, "periods": period_summaries, "roads": road_summaries, "records": records}
    audit = {
        "metadata": metadata, "periods": period_summaries, "byRoad": road_summaries,
        "checks": {
            "downloadComplete": all(s["rawCount"] == s["advertisedCount"] for s in sources),
            "featureIdsUnique": True, "rawCount": len(records),
            "geometryValidCount": sum(r["geometryValid"] for r in records),
            "geometryBounds": bounds, "flagCounts": dict(sorted(flags.items())),
            "hourRawMin": min(r["hourRaw"] for r in records), "hourRawMax": max(r["hourRaw"] for r in records),
            "hourRawDistinctCount": len(set(r["hourRaw"] for r in records)),
            "hourRawDecimalPlacesAtMost2": all(abs(r["hourRaw"] * 100 - round(r["hourRaw"] * 100)) < 1e-7 for r in records),
            "dateCounts": dict(sorted(collections.Counter(r["date"] for r in records).items())),
            "causeZeroCodeCount": sum(r["cause"] == "0" for r in records),
            "duplicateCandidateGroups": duplicate_groups,
        },
        "dateAnomalies": [{k:r[k] for k in ("id", "periodId", "road", "dateRaw", "date", "flags")} for r in records if not r["dateWithinPeriod"]],
        "hourBoundaryAnomalies": [{k:r[k] for k in ("id", "periodId", "road", "hourRaw", "minuteOfDayApprox", "flags")} for r in records if "hour_midnight_boundary_ambiguous" in r["flags"]],
        "chainageAuxiliaryMismatches": [{k:r[k] for k in ("id", "road", "kmRaw", "sourceAuxiliaryId", "coordinates")} for r in records if "chainage_auxiliary_id_mismatch" in r["flags"]],
        "limitations": [
            "Sólo dos semanas de red de cuota; no se verificó exhaustividad de notificación ni comparabilidad entre operadores.",
            "Horas aproximadas y codificación inferida; no se dispone de diccionario de la capa que confirme semántica o zona horaria.",
            "Hay fechas fuera de periodo, candidatos a duplicado y discrepancias auxiliares de kilometraje. Se preservan para inspección.",
            "La validez numérica de coordenadas no confirma que pertenezcan a la autopista declarada: corresponde validar distancia al trazo antes de agregar barras sobre cada corredor.",
            "La categoría causa está ausente o codificada como 0 en muchas filas; no usar para conclusiones causales.",
        ],
    }
    write_json("clean-accidents.json", clean)
    write_json("source-audit.json", audit)
    print(json.dumps({"rawCount": metadata["rawCount"], "mainCount": metadata["mainCount"], "temporalCount": metadata["temporalCount"], "densityCount": metadata["densityCount"], "roadNameCount": metadata["roadNameCount"], "periods": period_summaries, "flagCounts": audit["checks"]["flagCounts"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
