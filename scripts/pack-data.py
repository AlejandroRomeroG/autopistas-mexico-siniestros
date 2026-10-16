#!/usr/bin/env python3
"""Build the web's compact JSON assets from reviewed, frozen source artifacts.

This script never downloads data. To regenerate every reviewed intermediate,
run prepare-roads.py, prepare-data.py, then this script, from the repository root.
"""
from __future__ import annotations

import collections
import gzip
import hashlib
import json
from pathlib import Path
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "source"
DESTINATION = ROOT / "src" / "data"


def load(name):
    return json.loads((SOURCE / name).read_text(encoding="utf-8"))


def road_id(name):
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-")


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")


def preferred_name(names):
    # Two source labels differ only in the accent. Keep both as provenance and
    # display the accented spelling without inventing a new corridor.
    if "Durango - Yerbanís" in names:
        return "Durango - Yerbanís"
    return sorted(names)[0]


def main():
    clean = load("clean-accidents.json")
    prepared_roads = load("roads.prepared.geojson")
    road_metadata = load("road-source-metadata.json")
    records = []
    grouped = collections.defaultdict(list)
    for source_record in clean["records"]:
        record = {**source_record, "roadId": source_record["roadKey"]}
        if record["roadId"] != road_id(record["road"]):
            raise ValueError("Inconsistent road ID: " + record["id"])
        records.append(record)
        grouped[record["roadId"]].append(record)

    geometries = collections.defaultdict(list)
    for feature in prepared_roads["features"]:
        geometries[road_id(feature["properties"]["road"])].append(feature)

    roads, features = [], []
    removed_lines = 0
    for key in sorted(grouped):
        rows = grouped[key]
        names = sorted({r["road"] for r in rows})
        name = preferred_name(names)
        lines, seen_lines = [], set()
        for source_feature in geometries.get(key, []):
            geometry = source_feature["geometry"]
            source_lines = geometry["coordinates"] if geometry["type"] == "MultiLineString" else [geometry["coordinates"]]
            for line in source_lines:
                if len(line) < 2:
                    continue
                forward = tuple(tuple(c) for c in line)
                reverse = tuple(reversed(forward))
                line_key = min(forward, reverse)
                if line_key in seen_lines:
                    removed_lines += 1
                    continue
                seen_lines.add(line_key)
                lines.append(line)
        has_geometry = bool(lines)
        main_count = sum(r["mainEligible"] for r in rows)
        mapped_count = sum(r["densityEligible"] for r in rows)
        road = {
            "id": key, "key": key, "name": name, "sourceNames": names,
            "rawCount": len(rows), "mainCount": main_count, "mappedCount": mapped_count,
            "hasGeometry": has_geometry, "usable": has_geometry and mapped_count > 0,
            "periods": [{
                "periodId": period["id"],
                "rawCount": sum(r["periodId"] == period["id"] for r in rows),
                "mainCount": sum(r["periodId"] == period["id"] and r["mainEligible"] for r in rows),
                "mappedCount": sum(r["periodId"] == period["id"] and r["densityEligible"] for r in rows),
            } for period in clean["periods"]],
        }
        roads.append(road)
        if has_geometry:
            provenance = geometries[key]
            features.append({
                "type": "Feature", "id": key,
                "properties": {
                    "roadId": key, "road": name,
                    "sourceReportingNames": names,
                    "sourceLayer": "GEOSSI:red_vial_cuota_concesionario_geo",
                    "sourceRoadNames": sorted({name for f in provenance for name in f["properties"].get("sourceRoadNames", [])}),
                    "sourceAutopistaNames": sorted({name for f in provenance for name in f["properties"].get("sourceAutopistaNames", [])}),
                    "sourceUpdatedYears": sorted({year for f in provenance for year in f["properties"].get("sourceUpdatedYears", [])}),
                    "selectedSegmentsBeforeLineDedup": sum(f["properties"]["sourceFeatureCount"] for f in provenance),
                    "lineCountAfterDedup": len(lines),
                },
                "geometry": {"type": "MultiLineString", "coordinates": lines},
            })
    metadata = {
        **clean["metadata"],
        "schemaVersion": 2,
        "roadCount": len(roads), "geometryRoadCount": len(features),
        "usableRoadCount": sum(r["usable"] for r in roads),
        "mappedCount": sum(r["mappedCount"] for r in roads),
        "roadGroupingMethod": "Identidad por nombre normalizado sin acentos y con separadores uniformes. Los nombres originales se conservan; Durango - Yerbanis y Durango - Yerbanís comparten un roadId. Se eliminan sólo líneas exactamente iguales dentro del mismo roadId, considerando inversión de orientación. No se eliminan registros de accidentes.",
        "identicalGeometryLinesRemoved": removed_lines,
        "roadGeometrySource": road_metadata,
        "sourceArtifactsBase": "data/source/",
        "auditUrl": "data/source/source-audit.json",
        "roadAuditUrl": "data/source/road-selection-report.json",
        "reproduceCommands": ["python3 scripts/prepare-roads.py", "python3 scripts/prepare-data.py", "python3 scripts/pack-data.py", "npm run build"],
        "refreshCommand": "python3 scripts/prepare-data.py --download",
        "reproduceCommand": "python3 scripts/pack-data.py",
        "buildDataPolicy": "Los artefactos web se generan desde snapshots congelados; estos scripts no descargan al compilar. prepare-data.py sólo accede a la red cuando se pasa --download explícitamente.",
    }
    metadata["roadAlignment"]["file"] = "data/source/road-alignment-checks.json"
    periods = [{**period, "mappedCount": period["densityCount"]} for period in clean["periods"]]
    pilot = {"metadata": metadata, "periods": periods, "roads": roads, "records": records}
    geojson = {"type": "FeatureCollection", "metadata": {
        "source": "Instituto Mexicano del Transporte, GeoSSI WFS",
        "layer": road_metadata["layer"], "query": road_metadata["query"],
        "crs": "EPSG:4326", "processing": road_metadata["processing"],
        "grouping": metadata["roadGroupingMethod"],
    }, "features": features}

    if len(records) != len({r["id"] for r in records}):
        raise ValueError("Feature IDs are not unique")
    if sum(r["mainCount"] for r in roads) != metadata["mainCount"]:
        raise ValueError("Grouped main counts do not reconcile")
    if sum(r["mappedCount"] for r in roads) != metadata["densityCount"]:
        raise ValueError("Grouped mapped counts do not reconcile")
    if any(r["mappedCount"] > 0 and not r["hasGeometry"] for r in roads):
        raise ValueError("Mapped records lack road geometry")
    DESTINATION.mkdir(parents=True, exist_ok=True)
    write(DESTINATION / "pilot.json", pilot)
    write(DESTINATION / "roads.geojson", geojson)
    snapshots = []
    for name in [p["layer"] + ".raw.geojson" for p in clean["periods"]] + ["cuota-network.raw.geojson.gz"]:
        path = SOURCE / name
        raw_bytes = path.read_bytes()
        uncompressed = gzip.decompress(raw_bytes) if path.suffix == ".gz" else raw_bytes
        snapshots.append({"file": name, "bytes": len(raw_bytes), "sha256": hashlib.sha256(raw_bytes).hexdigest(), "uncompressedSha256": hashlib.sha256(uncompressed).hexdigest()})
    write(SOURCE / "snapshot-manifest.json", {
        "snapshots": snapshots, "rawRecords": len(records),
        "mainRecords": metadata["mainCount"], "mappedRecords": metadata["mappedCount"],
        "roads": len(roads), "geometryRoads": len(features), "usableRoads": metadata["usableRoadCount"],
        "reproduceCommands": metadata["reproduceCommands"],
        "networkPolicy": metadata["buildDataPolicy"],
    })
    print(json.dumps({"records": len(records), "main": metadata["mainCount"], "mapped": metadata["mappedCount"], "roads": len(roads), "geometryRoads": len(features), "usableRoads": metadata["usableRoadCount"], "identicalGeometryLinesRemoved": removed_lines}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
