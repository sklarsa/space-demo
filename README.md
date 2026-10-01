# QuestDB Mission Control

QuestDB is the time-series database inside [OpenC3 COSMOS 7](https://openc3.com/).

A 3D space display driven entirely by QuestDB SQL. It works like the taxi demo: real
history is replayed as if it were happening live.

- **Rockets:** 30 Hz webcast telemetry from 46 of the 52 SpaceX launches between Dec 2015 and Mar 2019 ([shahar603/Telemetry-Data](https://github.com/shahar603/Telemetry-Data)), with their original dates from Launch Library 2 (`launches` table).
  One launch lifts off every 30 s, on a loop, so around 20 are in the air at once. Boosters that
  return to the launch site fly back to the pad.
- **Satellites:** every active satellite from CelesTrak (~16k), propagated with SGP4 and
  written at 1 Hz. That's about **16k rows/s over 16k distinct symbols**.
- **Rendering:** CesiumJS, served locally (no Cesium ion account, no internet needed).
  Models come from NASA 3D Resources.

## Run

Needs Docker, Python 3, Node and a browser. Works on Linux and macOS.

```sh
./start.sh                # QuestDB in Docker + feeder + web server, then opens http://localhost:8080
./start.sh --spacing 15   # busier sky
```

- QuestDB web console: http://localhost:9000
- Conference kiosk: `chromium --kiosk http://localhost:8080`
- Check: `.venv/bin/python test_feeder.py`

On startup the feeder backfills 30 minutes of history (`--backfill`), so the timeline can be
scrubbed straight away.

## What it shows about QuestDB

Every panel runs live SQL. The bottom-right panel shows each query with its execution time.

| On screen | QuestDB feature |
|---|---|
| Rocket positions, 10 Hz | `LATEST ON ts PARTITION BY launch, stage` |
| Flight phase (MAXQ, MECO, SES1…) | `ASOF JOIN events ON (launch, stage)`: each telemetry row is matched to the most recent event |
| Orbit trails | `SAMPLE BY 2s` over the last 10 minutes |
| 16k satellites, 1 Hz | `LATEST ON … PARTITION BY norad` on a high-cardinality `SYMBOL` |
| Velocity/altitude chart | `rocket_telemetry_1s` **materialized view** |
| Ingest counters | ILP ingestion, ~17k rows/s |
| Nothing fills the disk | `TTL 1 DAY` / `TTL 2 HOURS` on hourly partitions (satellites write ~16k rows/s, ~2.7 GB/hour) |
| Drag the timeline back | The same queries, keyed to the clock instead of `now()` |

Queries to try in the console:

```sql
-- speed and altitude at Max-Q for every launch: each event matched to its telemetry
SELECT e.launch, t.velocity, t.altitude FROM events e ASOF JOIN rocket_telemetry t ON (launch, stage) WHERE e.event = 'maxq';
-- satellites per constellation right now
SELECT constellation, count() FROM (SELECT * FROM satellites WHERE ts > dateadd('s', -3, now()) LATEST ON ts PARTITION BY norad) ORDER BY 2 DESC;
-- highest satellites, with names from a regular JOIN to the catalog
SELECT c.name, s.alt FROM (SELECT * FROM satellites WHERE ts > dateadd('s', -3, now()) LATEST ON ts PARTITION BY norad) s
JOIN sat_catalog c ON (norad) ORDER BY s.alt DESC LIMIT 10;
```

## Known simplifications

- The webcasts only give speed and altitude, so the ground track is reconstructed from a
  guessed launch azimuth per mission class (see `site()` in `feeder.py`).
- Each webcast follows one stage at a time, so a stage's file often starts only when the camera
  cuts to it (T+430–1500 s). Before MECO both stages share the data that starts at liftoff. After
  that each stage uses its own; gaps up to 10 min are filled with a straight line, and anything
  longer ends that stage at MECO. Short dropouts are filled at 30 Hz, and a flight ends at its
  first long webcast cut or obvious misread.
- Return-to-launch-site detection for boosters is a heuristic, and a few boosters (e.g. CRS-13) miss it.
- `data/active.tle` is a snapshot. Refresh it before the conference:
  `curl -o data/active.tle 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle'`
- The rocket model is NASA's Saturn V, not a Falcon 9.

## Credits

- Launch telemetry: [shahar603/Telemetry-Data](https://github.com/shahar603/Telemetry-Data) (public domain), read from SpaceX webcasts using OCR
- Satellite orbit data: [CelesTrak](https://celestrak.org/) active-satellite catalogue
- 3D models: [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources) (Saturn V, ISS)
- Globe: [CesiumJS](https://cesium.com/platform/cesiumjs/) with its bundled Natural Earth II imagery
