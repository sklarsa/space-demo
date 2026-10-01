"""Replays SpaceX webcast telemetry (30 Hz) time-shifted to 'now', and streams SGP4
positions of every active satellite (1 Hz) into QuestDB over ILP.

Like the NYC taxi demo: history replayed as if it were happening live. On start it
backfills --backfill seconds of history so the timeline is scrubbable immediately.
"""
import argparse, json, math, os, time
from pathlib import Path

import numpy as np
import requests
from questdb import Sender, TimestampMicros
from sgp4.api import Satrec, SatrecArray, jday

QDB_HTTP = os.environ.get("QDB_HTTP", "http://localhost:9000")
QDB_ILP = os.environ.get("QDB_ILP", "tcp::addr=localhost:9009;protocol_version=2;")
DATA = Path(__file__).parent / "data"
R_EARTH = 6371.0

# The replay schedule restarts with the process, so replay tables do too (satellites are real time, kept).
SCHEMA = """
DROP MATERIALIZED VIEW IF EXISTS rocket_telemetry_1s;
DROP TABLE IF EXISTS rocket_telemetry;
DROP TABLE IF EXISTS events;
CREATE TABLE IF NOT EXISTS rocket_telemetry (
  ts TIMESTAMP, launch SYMBOL, stage SYMBOL, met DOUBLE,
  velocity DOUBLE, altitude DOUBLE, height DOUBLE, vz DOUBLE, vh DOUBLE, downrange DOUBLE,
  lat DOUBLE, lon DOUBLE, heading DOUBLE, pitch DOUBLE
) TIMESTAMP(ts) PARTITION BY HOUR TTL 1 DAY WAL;
CREATE TABLE IF NOT EXISTS events (ts TIMESTAMP, launch SYMBOL, stage SYMBOL, event SYMBOL)
  TIMESTAMP(ts) PARTITION BY DAY WAL;
CREATE TABLE IF NOT EXISTS satellites (
  ts TIMESTAMP, norad SYMBOL CAPACITY 32768, constellation SYMBOL,
  x DOUBLE, y DOUBLE, z DOUBLE, alt DOUBLE
) TIMESTAMP(ts) PARTITION BY HOUR TTL 2 HOURS WAL;
ALTER TABLE satellites SET TTL 2 HOURS;
CREATE TABLE IF NOT EXISTS sat_catalog (ts TIMESTAMP, norad SYMBOL CAPACITY 32768, name VARCHAR)
  TIMESTAMP(ts) PARTITION BY YEAR WAL DEDUP UPSERT KEYS(ts, norad);
CREATE MATERIALIZED VIEW IF NOT EXISTS rocket_telemetry_1s AS (
  SELECT ts, launch, stage, max(velocity) velocity, max(altitude) altitude, last(downrange) downrange
  FROM rocket_telemetry SAMPLE BY 1s
) PARTITION BY DAY;
"""

# Pads and launch azimuths. ponytail: azimuth guessed from mission class (the webcast
# gives no ground track); good enough visually, swap for real tracks if anyone cares.
SLC40, SLC4E = (28.5619, -80.5772), (34.632, -120.611)
BOOSTER_EVENTS = {"boostback_start", "boostback_end", "apogee", "entry_start", "entry_end", "landing_start", "landing_end"}
UPPER_EVENTS = {"ses1", "seco1", "ses2", "seco2"}
VANDENBERG = ("Iridium", "Jason-3", "FormoSat", "Paz", "SAOCOM", "SSO-A")
NORTHEAST = ("CRS", "DM-1", "NROL-76", "Orbcomm", "X-37B", "ZUMA")


def site(name):
    if name.startswith(VANDENBERG):
        return SLC4E, 195.0
    if any(k in name for k in NORTHEAST):
        return SLC40, 44.0
    return SLC40, 95.0


def destination(lat0, lon0, az, d_km):
    """Great-circle point d_km from (lat0, lon0) along azimuth az (degrees, vectorised)."""
    p1, l1, th = map(np.radians, (lat0, lon0, az))
    dl = d_km / R_EARTH
    p2 = np.arcsin(np.sin(p1) * np.cos(dl) + np.cos(p1) * np.sin(dl) * np.cos(th))
    l2 = l1 + np.arctan2(np.sin(th) * np.sin(dl) * np.cos(p1), np.cos(dl) - np.sin(p1) * np.sin(p2))
    return np.degrees(p2), (np.degrees(l2) + 540) % 360 - 180


def load_flight(launch, stage, raw, events):
    t = np.asarray(raw["time"], float)
    v = np.asarray(raw["velocity"], float)
    alt = np.asarray(raw["altitude"], float)
    # End the flight at the first webcast cut (>5 s gap, usually the coast to a later burn) or
    # OCR misread (>50 km jump, e.g. 999 -> 100), then resample to a steady 30 Hz so short
    # dropouts don't look like the flight ended.
    bad = np.flatnonzero((np.diff(t) > 5) | (np.abs(np.diff(alt)) > 50))
    if len(bad):
        t, v, alt = t[: bad[0] + 1], v[: bad[0] + 1], alt[: bad[0] + 1]
    tt = np.arange(0, t[-1], 1 / 30)
    t, v, alt = tt, np.interp(tt, t, v), np.interp(tt, t, alt)
    # Webcast gives only speed + altitude. Derive vertical/horizontal split on a smoothed
    # 1 Hz grid, integrate horizontal speed for downrange, then map back to 30 Hz.
    g = np.arange(0, t[-1] + 1)
    smooth = lambda x: np.convolve(np.pad(x, 2, "edge"), np.ones(5) / 5, "valid")
    ag = smooth(np.interp(g, t, alt))
    vg = smooth(np.interp(g, t, v))
    vz = np.gradient(ag) * 1000
    vh = np.sqrt(np.clip(vg**2 - vz**2, 0, None))
    sign = np.ones_like(vh)
    bb0, bb1 = events.get("boostback_start"), events.get("boostback_end")
    if stage == "1" and bb0 and bb1:
        # ponytail: RTLS if horizontal speed nearly vanishes during boostback; ASDS partial
        # boostbacks keep going forward. Heuristic, not physics.
        w = slice(int(bb0), int(bb1) + 1)
        i = int(bb0) + int(np.argmin(vh[w]))
        if vh[i] < 0.15 * max(vh[int(bb0)], 1):
            sign[i:] = -1
    down = np.concatenate([[0], np.cumsum(vh[1:] * sign[1:])]) / 1000
    (lat0, lon0), az = site(launch)
    lat, lon = destination(lat0, lon0, az, np.interp(t, g, down))
    s = np.interp(t, g, sign)
    return dict(
        # altitude: raw webcast reading (0.1 km steps); height: smoothed, for drawing the rocket
        launch=launch, stage=stage, t=t, velocity=v, altitude=alt, height=np.interp(t, g, ag),
        vz=np.interp(t, g, vz), vh=np.interp(t, g, vh) * s, downrange=np.interp(t, g, down),
        lat=lat, lon=lon, heading=np.where(s < 0, (az + 180) % 360, az),
        # Flight-path angle is undefined near zero speed: stand the rocket up on the pad.
        pitch=np.where(v < 150, 90.0, np.degrees(np.arctan2(np.interp(t, g, vz), np.abs(np.interp(t, g, vh)) + 1e-9))),
        events=sorted([(0.0, "liftoff")] + [(float(sec), ev) for ev, sec in events.items()
                       if sec is not None and ev not in (UPPER_EVENTS if stage == "1" else BOOSTER_EVENTS)]),
    )


def load_flights():
    flights = []
    for d in sorted((DATA / "launches").iterdir()):
        events = json.loads((d / "events.json").read_text())
        stages = []
        for stage in ("1", "2"):
            f = d / f"stage{stage} raw.json"
            if f.exists():
                stages.append(load_flight(d.name, stage, json.loads(f.read_text()), events))
        if stages:
            flights.append(stages)
    return flights


def constellation(name):
    for k in ("STARLINK", "ONEWEB", "KUIPER", "IRIDIUM", "GPS", "GLOBALSTAR", "ORBCOMM", "PLANET", "FLOCK", "LEMUR"):
        if name.startswith(k):
            return k.lower()
    return "other"


def load_sats():
    lines = [l.rstrip() for l in (DATA / "active.tle").read_text().splitlines() if l.strip()]
    names, sats = [], []
    for i in range(0, len(lines) - 2, 3):
        names.append(lines[i].strip())
        sats.append(Satrec.twoline2rv(lines[i + 1], lines[i + 2]))
    return names, [str(s.satnum) for s in sats], SatrecArray(sats)


def gmst(jd):
    """Greenwich mean sidereal time (radians), IAU 1982. Enough to rotate TEME -> ECEF."""
    tu = (jd - 2451545.0) / 36525.0
    sec = 67310.54841 + (876600 * 3600 + 8640184.812866) * tu + 0.093104 * tu**2 - 6.2e-6 * tu**3
    return math.radians((sec % 86400) / 240.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spacing", type=float, default=30, help="seconds between replayed launches")
    ap.add_argument("--backfill", type=float, default=1800, help="seconds of history written at start")
    ap.add_argument("--no-sats", action="store_true")
    args = ap.parse_args()

    for stmt in filter(str.strip, SCHEMA.split(";")):
        r = requests.get(f"{QDB_HTTP}/exec", params={"query": stmt}).json()
        if "error" in r:
            raise SystemExit(f"schema: {r['error']}")

    flights = load_flights()
    names, norads, sat_arr = load_sats()
    groups = [constellation(n) for n in names]
    print(f"{len(flights)} launches, {len(norads)} satellites")

    start = time.time() - args.backfill
    next_launch, active = 0, []  # active: [t0, flight_stage, row_idx, event_idx]
    next_sat = time.time()
    with Sender.from_conf(QDB_ILP) as sender:
        for name, norad in zip(names, norads):
            sender.row("sat_catalog", symbols={"norad": norad}, columns={"name": name}, at=TimestampMicros(0))
        while True:
            now = time.time()
            while start + next_launch * args.spacing <= now:
                t0 = start + next_launch * args.spacing
                active += [[t0, st, 0, 0] for st in flights[next_launch % len(flights)]]
                next_launch += 1
            n = 0
            for a in active:
                t0, f, i, e = a
                t = f["t"]
                j = np.searchsorted(t, now - t0, "right")
                for k in range(i, j):
                    sender.row(
                        "rocket_telemetry", symbols={"launch": f["launch"], "stage": f["stage"]},
                        columns={"met": float(t[k]), **{c: float(f[c][k]) for c in
                                 ("velocity", "altitude", "height", "vz", "vh", "downrange", "lat", "lon", "heading", "pitch")}},
                        at=TimestampMicros(int((t0 + t[k]) * 1e6)),
                    )
                ev = f["events"]
                while e < len(ev) and t0 + ev[e][0] <= now:
                    sender.row("events", symbols={"launch": f["launch"], "stage": f["stage"], "event": ev[e][1]},
                               at=TimestampMicros(int((t0 + ev[e][0]) * 1e6)))
                    e += 1
                n += j - i
                a[2], a[3] = j, e
            active = [a for a in active if a[2] < len(a[1]["t"])]

            if not args.no_sats and now >= next_sat:
                next_sat = math.floor(now) + 1
                jd, fr = jday(*time.gmtime(now)[:5], now % 60)
                err, r, _ = sat_arr.sgp4(np.array([jd]), np.array([fr]))
                th = gmst(jd + fr)
                c, s = math.cos(th), math.sin(th)
                x, y, z = r[:, 0, 0] * c + r[:, 0, 1] * s, -r[:, 0, 0] * s + r[:, 0, 1] * c, r[:, 0, 2]
                alt = np.sqrt(x**2 + y**2 + z**2) - R_EARTH
                ts = TimestampMicros(int(now * 1e6))
                for k in np.flatnonzero(err[:, 0] == 0):
                    sender.row("satellites", symbols={"norad": norads[k], "constellation": groups[k]},
                               columns={"x": float(x[k]), "y": float(y[k]), "z": float(z[k]), "alt": float(alt[k])}, at=ts)
                n += len(norads)
            sender.flush()
            if n > 50000:
                print(f"backfilled {n} rows")
            time.sleep(max(0.0, 0.05 - (time.time() - now)))


if __name__ == "__main__":
    main()
