// Everything on screen comes from QuestDB SQL, keyed off the Cesium clock, so live and
// replay (drag the timeline) are the same code path.
const C = Cesium;
const TRAIL_MIN = 10;
const CHASE = new C.Cartesian3(140, -180, 50); // default chase cam offset (east, north, up metres)
const RENDER_DELAY = 1.0; // seconds behind the clock; rows land up to ~0.5 s late (WAL apply), so there's always a sample ahead

const viewer = new C.Viewer("globe", {
  baseLayer: C.ImageryLayer.fromProviderAsync(
    C.TileMapServiceImageryProvider.fromUrl(C.buildModuleUrl("Assets/Textures/NaturalEarthII"))),
  baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
  navigationHelpButton: false, animation: false, fullscreenButton: false, infoBox: false,
  selectionIndicator: false, timeline: true, shouldAnimate: true,
});
viewer.scene.globe.enableLighting = true;
viewer.scene.debugShowFramesPerSecond = false;
const clock = viewer.clock;
const liveNow = () => C.JulianDate.now();
clock.startTime = C.JulianDate.addMinutes(liveNow(), -35, new C.JulianDate());
clock.stopTime = C.JulianDate.addMinutes(liveNow(), 2, new C.JulianDate());
clock.currentTime = liveNow();
clock.clockRange = C.ClockRange.UNBOUNDED;
clock.clockStep = C.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
viewer.timeline.zoomTo(clock.startTime, clock.stopTime);
viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(-85, 25, 22e6) });

// ---------- QuestDB ----------
const sqlPanel = document.getElementById("sql");
const sqlBoxes = {};
const KW = /\b(SELECT|FROM|WHERE|BETWEEN|AND|LATEST ON|PARTITION BY|ASOF JOIN|ON|SAMPLE BY|UNION ALL|AS|ORDER BY|DESC|last|count|max)\b/g;
async function q(label, sql) {
  const t0 = performance.now();
  const r = await fetch("/exec?timings=true&query=" + encodeURIComponent(sql));
  const j = await r.json();
  if (j.error) throw new Error(`${label}: ${j.error}`);
  let box = sqlBoxes[label];
  if (!box) {
    box = sqlBoxes[label] = document.createElement("div");
    box.className = "q";
    sqlPanel.appendChild(box);
  }
  const ms = (j.timings.execute / 1e6).toFixed(1);
  box.innerHTML = `<div class="h">${label} · <b>${ms} ms</b> in QuestDB · ${j.count} rows · ${(performance.now() - t0).toFixed(0)} ms round trip</div>` +
    `<pre>${sql.replace(/'[^']*'/g, (s) => s.length > 20 ? "'…'" : s).replace(KW, '<span class="kw">$1</span>')}</pre>`;
  return j.dataset;
}
const iso = (jd, dSec = 0) => C.JulianDate.toIso8601(C.JulianDate.addSeconds(jd, dSec, new C.JulianDate()), 6);
const between = (t, back) => `ts BETWEEN '${iso(t, -back)}' AND '${iso(t)}'`;
function loop(fn, ms) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error(e); } finally { busy = false; }
  }, ms);
}

// ---------- rockets ----------
const rockets = new Map(); // key -> {entity, samples, row, seen}
let follow = null, lastPollT = null, lastPollWall = 0, lastInput = 0;
// Don't yank the camera to a new launch while someone is steering it.
for (const ev of ["pointerdown", "wheel", "touchstart"]) viewer.canvas.addEventListener(ev, () => (lastInput = Date.now()), { passive: true });
const scratch = new C.JulianDate();

function orientation(pos, headingDeg, pitchDeg) {
  // Model nose is +Z; point it along (heading, flight-path angle) in the local ENU frame.
  const h = C.Math.toRadians(headingDeg), p = C.Math.toRadians(pitchDeg);
  const d = new C.Cartesian3(Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p));
  const axis = C.Cartesian3.cross(C.Cartesian3.UNIT_Z, d, new C.Cartesian3());
  const local = C.Cartesian3.magnitude(axis) < 1e-6 ? C.Quaternion.IDENTITY
    : C.Quaternion.fromAxisAngle(C.Cartesian3.normalize(axis, axis), Math.acos(C.Math.clamp(d.z, -1, 1)));
  const enu = C.Matrix4.getMatrix3(C.Transforms.eastNorthUpToFixedFrame(pos), new C.Matrix3());
  return C.Quaternion.multiply(C.Quaternion.fromRotationMatrix(enu), local, new C.Quaternion());
}

function rocket(key, launch, stage) {
  let r = rockets.get(key);
  if (r) return r;
  const samples = new C.SampledPositionProperty();
  samples.forwardExtrapolationType = samples.backwardExtrapolationType = C.ExtrapolationType.HOLD;
  r = { samples, q: C.Quaternion.IDENTITY };
  r.entity = viewer.entities.add({
    viewFrom: CHASE,
    position: new C.CallbackProperty((t, res) =>
      samples.getValue(C.JulianDate.addSeconds(t, -RENDER_DELAY, scratch), res), false),
    orientation: new C.CallbackProperty(() => r.q, false),
    model: {
      uri: "models/rocket.glb", minimumPixelSize: stage === "1" ? 36 : 56, maximumScale: 5000,
      color: stage === "1" ? C.Color.fromCssColorString("#9fd6ff") : C.Color.WHITE,
      colorBlendMode: C.ColorBlendMode.MIX, colorBlendAmount: stage === "1" ? 0.5 : 0,
    },
    label: {
      text: stage === "1" ? `${launch} · booster` : launch, font: "12px monospace",
      fillColor: stage === "1" ? C.Color.fromCssColorString("#9fd6ff") : C.Color.WHITE,
      outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new C.Cartesian2(14, -14), horizontalOrigin: C.HorizontalOrigin.LEFT,
      distanceDisplayCondition: new C.DistanceDisplayCondition(0, 2.5e6), // no label pile-up in globe view
    },
  });
  r.entity.rocketKey = key;
  rockets.set(key, r);
  return r;
}

const PRE_SEP = new Set(["liftoff", "maxq", "throttle_down_start", "throttle_down_end"]);
let pollN = 0;
async function pollRockets() {
  const t = clock.currentTime;
  // A jump is the clock moving differently from the wall clock (scrub), not just a slow/throttled poll.
  const wall = Date.now();
  if (lastPollT && Math.abs(C.JulianDate.secondsDifference(t, lastPollT) - (wall - lastPollWall) / 1000 * clock.multiplier) > 3) {
    // Timeline jumped: drop interpolation history so rockets don't slide across the gap.
    for (const r of rockets.values()) viewer.entities.remove(r.entity);
    rockets.clear();
  }
  lastPollT = C.JulianDate.clone(t);
  lastPollWall = wall;
  const rows = await q("rocket state (10 Hz)",
    `SELECT t.ts, t.launch, t.stage, t.met, t.velocity, t.altitude, t.height, t.lat, t.lon, t.heading, t.pitch, e.event
FROM (SELECT * FROM rocket_telemetry WHERE ${between(t, 3)}
      LATEST ON ts PARTITION BY launch, stage) t
ASOF JOIN events e ON (launch, stage)`);
  pollN++;
  for (const [ts, launch, stage, met, vel, alt, height, lat, lon, heading, pitch, event] of rows) {
    const r = rocket(`${launch}|${stage}`, launch, stage);
    const when = C.JulianDate.fromIso8601(ts);
    const pos = C.Cartesian3.fromDegrees(lon, lat, height * 1000);
    r.samples.addSample(when, pos);
    // Before separation booster and upper stage are one vehicle: draw only one or they z-fight.
    r.entity.show = stage === "2" || !PRE_SEP.has(event);
    r.q = orientation(pos, heading, pitch);
    // Liftoff time from mission elapsed time: stable across polls, same for both stages.
    r.row = { launch, stage, met, vel, alt, event, liftoff: C.JulianDate.toDate(when).getTime() - met * 1000 };
    r.seen = pollN;
  }
  for (const [key, r] of rockets) {
    if (pollN - r.seen > 15) {
      viewer.entities.remove(r.entity);
      rockets.delete(key);
    }
  }
  pickFollow();
  if (pollN % 3 === 0) renderFlights();
}

// mode: "auto" follows each new launch, "user" sticks to a picked flight until it ends, "globe" follows nothing.
let mode = "auto";
const newestFirst = (a, b) => b.row.liftoff - a.row.liftoff || b.row.stage.localeCompare(a.row.stage);
function pickFollow() {
  if (follow && !rockets.has(follow)) {
    follow = null;
    if (mode === "user") mode = "auto";
  }
  if (mode === "auto") {
    // Newest launch, upper stage preferred (some launches only have booster telemetry).
    const [newest] = [...rockets.values()].sort(newestFirst);
    const cur = follow && rockets.get(follow);
    const idle = Date.now() - lastInput > 20000;
    if (newest && (!cur || (idle && newest.row.liftoff > cur.row.liftoff + 1000))) follow = newest.entity.rocketKey;
  }
  const ent = follow ? rockets.get(follow).entity : undefined;
  if (viewer.trackedEntity === ent) return;
  // While tracking, camera.position is the offset from the tracked rocket: hand it to the next one
  // so switching keeps the current zoom and angle instead of snapping to the default chase view.
  // (Only a sane chase distance: mid-flight from the globe view the offset is thousands of km.)
  const offset = viewer.trackedEntity && C.Cartesian3.clone(viewer.camera.position);
  if (ent) ent.viewFrom = offset && C.Cartesian3.magnitude(offset) < 2e5 ? offset : CHASE;
  viewer.trackedEntity = ent;
}

function followUser(key) {
  if (!rockets.has(key)) return;
  follow = key;
  mode = "user";
  pickFollow();
  renderFlights();
}

const flightRows = document.getElementById("flight-rows");
const met = (s) => `T+${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function renderFlights() {
  // Update rows in place (keyed by flight) so clicks aren't lost to a re-render.
  const list = [...rockets.values()].sort(newestFirst);
  const keep = new Set(list.map((r) => r.entity.rocketKey));
  for (const tr of [...flightRows.children]) if (!keep.has(tr.dataset.k)) tr.remove();
  list.forEach((r, i) => {
    const key = r.entity.rocketKey, row = r.row;
    let tr = flightRows.querySelector(`tr[data-k="${CSS.escape(key)}"]`);
    if (!tr) {
      tr = document.createElement("tr");
      tr.dataset.k = key;
      tr.innerHTML = `<td>${row.launch.slice(0, 17)}${row.stage === "1" ? " ⇣" : ""}</td><td class="n"></td><td class="phase"></td><td class="n"></td><td class="n"></td>`;
    }
    if (flightRows.children[i] !== tr) flightRows.insertBefore(tr, flightRows.children[i] || null);
    tr.className = key === follow ? "on" : "";
    const c = tr.children;
    c[1].textContent = met(row.met);
    c[2].textContent = (row.event || "").replace(/_/g, " ").toUpperCase().slice(0, 13);
    c[3].textContent = `${(row.vel / 1000).toFixed(2)} km/s`;
    c[4].textContent = `${row.alt.toFixed(0)} km`;
  });
  document.getElementById("s-flights").textContent = rockets.size;
}
flightRows.addEventListener("pointerdown", (e) => {
  const tr = e.target.closest("tr");
  if (tr) followUser(tr.dataset.k);
});
// Click a rocket (or its trail) in the 3D view. drillPick because the trail ends on the rocket and
// would otherwise win the pick. Replaces Cesium's own click/double-click selection, which fights ours.
const clicks = viewer.cesiumWidget.screenSpaceEventHandler;
clicks.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
clicks.setInputAction(({ position }) => {
  for (const o of viewer.scene.drillPick(position, 6)) {
    const key = o.id?.rocketKey ?? (typeof o.id === "string" ? o.id : null);
    if (key && rockets.has(key)) return followUser(key);
  }
}, C.ScreenSpaceEventType.LEFT_CLICK);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    mode = "globe"; follow = null; viewer.trackedEntity = undefined;
    viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(-85, 25, 22e6) });
    renderFlights();
  } else if (e.key === "f" || e.key === "F") {
    mode = "auto"; follow = null; pickFollow(); renderFlights();
  }
});

// ---------- trails (SAMPLE BY) ----------
const trails = viewer.scene.primitives.add(new C.PolylineCollection());
async function pollTrails() {
  const t = clock.currentTime;
  const rows = await q("flight paths (every 2 s)",
    `SELECT ts, launch, stage, last(lat) lat, last(lon) lon, last(height) alt
FROM rocket_telemetry WHERE ${between(t, TRAIL_MIN * 60)}
SAMPLE BY 2s`);
  const paths = new Map();
  for (const [, launch, stage, lat, lon, alt] of rows) {
    const k = `${launch}|${stage}`;
    if (!paths.has(k)) paths.set(k, []);
    paths.get(k).push(lon, lat, alt * 1000);
  }
  trails.removeAll();
  for (const [k, pts] of paths) {
    if (pts.length < 6) continue;
    const booster = k.endsWith("|1");
    trails.add({
      id: k,
      positions: C.Cartesian3.fromDegreesArrayHeights(pts), width: booster ? 1.5 : 2.5,
      material: C.Material.fromType("Color", { color: booster ? C.Color.fromCssColorString("#9fd6ff").withAlpha(0.7) : C.Color.fromCssColorString("#ff9a3c").withAlpha(0.85) }),
    });
  }
}

// ---------- satellites (LATEST ON over ~16k symbols) ----------
const COLORS = { starlink: "#b14aff", oneweb: "#3ddc97", kuiper: "#ffd23f", iridium: "#4cc9f0", gps: "#ff5d8f",
  globalstar: "#f77f00", orbcomm: "#90be6d", planet: "#e9c46a", lemur: "#a8dadc", other: "#cfd8e6" };
const NAMES = { starlink: "Starlink", oneweb: "OneWeb", kuiper: "Kuiper", iridium: "Iridium", gps: "GPS",
  globalstar: "Globalstar", orbcomm: "Orbcomm", planet: "Planet", lemur: "Spire Lemur", other: "Other" };
async function pollLegend() {
  const rows = await q("constellations (every 5 s)",
    `SELECT constellation, count() n FROM (
  SELECT constellation FROM satellites WHERE ${between(clock.currentTime, 3)}
  LATEST ON ts PARTITION BY norad)
ORDER BY n DESC`);
  document.getElementById("legend-rows").innerHTML = rows.map(([g, n]) =>
    `<div><i style="background:${COLORS[g] || COLORS.other}"></i>${NAMES[g] || g}<b>${n.toLocaleString()}</b></div>`).join("");
}
const satPoints = viewer.scene.primitives.add(new C.PointPrimitiveCollection());
const sats = new Map();
const iss = viewer.entities.add({
  model: { uri: "models/iss.glb", minimumPixelSize: 48, maximumScale: 20000 },
  label: { text: "ISS", font: "12px monospace", pixelOffset: new C.Cartesian2(14, -14), fillColor: C.Color.YELLOW,
           outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE },
});
async function pollSats() {
  const t = clock.currentTime;
  const rows = await q("satellite positions (1 Hz)",
    `SELECT norad, constellation, x, y, z FROM satellites
WHERE ${between(t, 3)}
LATEST ON ts PARTITION BY norad`);
  for (const [norad, group, x, y, z] of rows) {
    const pos = new C.Cartesian3(x * 1000, y * 1000, z * 1000);
    let p = sats.get(norad);
    if (!p) {
      p = satPoints.add({ pixelSize: group === "other" ? 2 : 2.5, color: C.Color.fromCssColorString(COLORS[group] || COLORS.other).withAlpha(0.9) });
      sats.set(norad, p);
    }
    p.position = pos;
    if (norad === "25544") iss.position = pos;
  }
  document.getElementById("s-sats").textContent = rows.length.toLocaleString();
}

// ---------- stats ----------
async function pollStats() {
  const t = clock.currentTime;
  const [[rock], [sat]] = await q("ingest rate (1 Hz)",
    `SELECT count() FROM rocket_telemetry WHERE ${between(t, 5)}
UNION ALL
SELECT count() FROM satellites WHERE ${between(t, 5)}`);
  document.getElementById("s-rock").textContent = `${Math.round(rock / 5).toLocaleString()} rows/s`;
  document.getElementById("s-sat").textContent = `${Math.round(sat / 5).toLocaleString()} rows/s`;
  const [[a], [b]] = await fetch("/exec?query=" + encodeURIComponent(
    "SELECT count() FROM rocket_telemetry UNION ALL SELECT count() FROM satellites")).then((r) => r.json()).then((j) => j.dataset);
  document.getElementById("s-total").textContent = (a + b).toLocaleString();

  const lag = C.JulianDate.secondsDifference(liveNow(), t);
  const mode = document.getElementById("mode");
  if (lag > 5) {
    mode.className = "replay";
    mode.innerHTML = `⏪ REPLAY −${Math.floor(lag / 60)}:${String(Math.floor(lag % 60)).padStart(2, "0")}<button id="live">go live</button>`;
    document.getElementById("live").onclick = () => { clock.currentTime = liveNow(); clock.multiplier = 1; };
  } else {
    mode.className = "";
    mode.textContent = "● LIVE";
  }
}
// Never run the clock into the future: there's no data there yet.
clock.onTick.addEventListener((c) => {
  if (C.JulianDate.greaterThan(c.currentTime, liveNow())) c.currentTime = liveNow();
  if (C.JulianDate.greaterThan(liveNow(), c.stopTime)) {
    c.stopTime = C.JulianDate.addMinutes(liveNow(), 2, new C.JulianDate());
    c.startTime = C.JulianDate.addMinutes(liveNow(), -35, new C.JulianDate());
    viewer.timeline.zoomTo(c.startTime, c.stopTime);
  }
});

// ---------- chart (materialized view) ----------
const plot = document.getElementById("plot"), g = plot.getContext("2d");
async function pollChart() {
  const r = follow && rockets.get(follow);
  if (!r) return;
  const { launch, stage } = r.row;
  document.getElementById("chart-title").textContent = `${launch}${stage === "1" ? " booster" : ""}`;
  const rows = await q("followed flight (materialized view)",
    `SELECT ts, velocity, altitude FROM rocket_telemetry_1s
WHERE launch = '${launch.replace(/'/g, "''")}' AND stage = '${stage}'
AND ${between(clock.currentTime, 600)}`);
  const W = plot.width, H = plot.height;
  g.clearRect(0, 0, W, H);
  if (rows.length < 2) return;
  for (const [col, color] of [[1, "#b14aff"], [2, "#3ddc97"]]) {
    const max = Math.max(...rows.map((x) => x[col]), 1);
    g.strokeStyle = color; g.lineWidth = 3; g.beginPath();
    rows.forEach((x, i) => g[i ? "lineTo" : "moveTo"](i / (rows.length - 1) * W, H - 8 - x[col] / max * (H - 16)));
    g.stroke();
    g.fillStyle = color; g.font = "22px monospace";
    g.fillText(col === 1 ? `${(max / 1000).toFixed(2)} km/s` : `${max.toFixed(0)} km`, 8, col === 1 ? 26 : 54);
  }
}

loop(pollRockets, 100);
loop(pollTrails, 2000);
loop(pollSats, 1000);
loop(pollStats, 1000);
loop(pollChart, 1000);
loop(pollLegend, 5000);
