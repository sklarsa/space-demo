"""Smallest checks that fail if the geometry or the replay derivation breaks. Run: .venv/bin/python test_feeder.py"""
import math
import numpy as np
import feeder

la, lo = feeder.destination(28.0, -80.0, 0.0, np.array([0.0, 111.195]))
assert abs(la[0] - 28) < 1e-9 and abs(lo[0] + 80) < 1e-9, "0 km must be the pad"
assert abs(la[1] - 29) < 1e-3 and abs(lo[1] + 80) < 1e-9, "111 km north is ~1 degree"
assert abs(math.degrees(feeder.gmst(2451545.0)) - 280.46062) < 1e-3, "GMST at J2000"

flights = {(f["launch"], f["stage"]): f for st in feeder.load_flights() for f in st}
rtls = flights[("SpaceX CRS-11", "1")]
assert rtls["downrange"].max() > 50 and abs(rtls["downrange"][-1]) < 20, "RTLS booster returns to the pad"
s2 = flights[("SpaceX CRS-10", "2")]
assert np.all(np.diff(s2["t"]) >= 0) and s2["downrange"][-1] > 500, "upper stage flies downrange"
assert s2["pitch"][0] == 90 and all(e not in feeder.BOOSTER_EVENTS for _, e in s2["events"]), "upright on pad, no booster events"
for f in flights.values():
    assert np.diff(f["t"]).max() < 0.05 and np.abs(np.diff(f["height"])).max() < 0.5, f"gap or jump in {f['launch']}"
for f in flights.values():
    assert f["t"][0] == 0 and f["altitude"][0] < 1 and f["velocity"][0] < 100, f"{f['launch']} stage {f['stage']} does not start on the pad"
assert [feeder.constellation(n) for n in ("NAVSTAR 43 (USA 132)", "STARLINK-1007", "ISS (ZARYA)")] == ["gps", "starlink", "other"]
print("ok")
