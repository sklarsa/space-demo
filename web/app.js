// Booth build. An auto-director cycles camera shots while a "live query" card shows which QuestDB
// query drives what's on screen. Any mouse/keyboard input hands control to the visitor (flight list
// and timeline appear); the director resumes after a minute idle. Everything on screen comes from
// QuestDB SQL keyed off the Cesium clock, so live and replay (timeline) share one code path.
const C = Cesium;
const TRAIL_MIN = 10;
const RENDER_DELAY = 1.0; // seconds behind the clock; rows land up to ~0.5 s late (WAL apply), so there's always a sample ahead
const IDLE_MS = 60000;
const FLY = 4.5; // seconds per camera transition
const px = (n) => n * Math.max(1, innerHeight / 1080); // pixel sizes that scale with the TV
const deg = C.Math.toRadians;

const geo = new C.GeographicTilingScheme();
const tiles = (name, maximumLevel) =>
  new C.UrlTemplateImageryProvider({ url: `tiles/${name}/{z}/{x}/{y}.jpg`, tilingScheme: geo, maximumLevel });
// Default: FXAA and the globe rendered at most ~1080p (cheap); ?hq = 4x MSAA, up to 1440p.
// ?fps=30 caps the frame rate for a weak laptop (a cap judders on a 60 Hz screen, so it's opt-in).
const params = new URLSearchParams(location.search);
const HQ = params.has("hq");
const viewer = new C.Viewer("globe", {
  baseLayer: new C.ImageryLayer(tiles("day", 5)), // NASA Blue Marble, served locally (no internet at the venue)
  baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
  navigationHelpButton: false, animation: false, fullscreenButton: false, infoBox: false,
  selectionIndicator: false, timeline: true, shouldAnimate: true, msaaSamples: HQ ? 4 : 1,
  targetFrameRate: +params.get("fps") || undefined,
});
const night = viewer.imageryLayers.addImageryProvider(tiles("night", 4)); // NASA Black Marble city lights
night.dayAlpha = 0;
night.nightAlpha = 1;
night.brightness = 1.6;
const scene = viewer.scene;
// A laptop GPU driving a 4K TV: render the globe smaller and let it upscale. The HTML overlay stays
// at full resolution, so text is still sharp.
viewer.resolutionScale = Math.min(1, (HQ ? 2560 : 1920) / (innerWidth * devicePixelRatio));
scene.postProcessStages.fxaa.enabled = !HQ;

// Adaptive quality for an unknown booth GPU. Uneven pacing (frames flipping between 16 and 33 ms) is
// what reads as jitter, and rendering the globe at half resolution reads as pixelated. So: if 60 fps
// isn't held (median frame over 2 s above budget), first trim resolution down to 75% of full; if that's
// still not enough, switch to a steady 30 fps at full resolution and only trim from there. Recover in
// 5% steps after 10 s with 90% of frames on time. The HTML overlay is always full resolution.
const MAX_SCALE = viewer.resolutionScale, FLOOR = MAX_SCALE * 0.75, MIN_SCALE = MAX_SCALE * 0.5;
let frameT = 0, dts = [], lastAdjust = 0, goodWindows = 0, capped = !!viewer.targetFrameRate;
scene.postRender.addEventListener(() => {
  const now = performance.now();
  if (frameT) dts.push(now - frameT);
  frameT = now;
  if (now - lastAdjust < 2000 || dts.length < 20) return;
  lastAdjust = now;
  dts.sort((a, b) => a - b);
  const median = dts[dts.length >> 1], p90 = dts[Math.floor(dts.length * 0.9)], budget = capped ? 36 : 18;
  dts = [];
  if (median > budget) {
    goodWindows = 0;
    if (!capped && viewer.resolutionScale <= FLOOR) {
      capped = true; // can't hold 60 without going soft: steady 30 at full resolution instead
      viewer.targetFrameRate = 30;
      viewer.resolutionScale = MAX_SCALE;
    } else {
      viewer.resolutionScale = Math.max(capped ? MIN_SCALE : FLOOR, viewer.resolutionScale * 0.9);
    }
  } else if (p90 < budget && ++goodWindows >= 5 && viewer.resolutionScale < MAX_SCALE) {
    viewer.resolutionScale = Math.min(MAX_SCALE, viewer.resolutionScale * 1.05);
    goodWindows = 0;
  } else if (p90 >= budget) {
    goodWindows = 0;
  }
});
document.addEventListener("visibilitychange", () => { frameT = 0; }); // a hidden tab isn't a slow GPU
scene.globe.enableLighting = true;
scene.globe.dynamicAtmosphereLighting = true;
// The director revisits the same places every loop: keep their tiles on the GPU instead of re-uploading
// them (uploads during fly-overs were the remaining frame hitches).
scene.globe.tileCacheSize = 600;
const camera = viewer.camera;
const clock = viewer.clock;
const liveNow = () => C.JulianDate.now();
clock.startTime = C.JulianDate.addMinutes(liveNow(), -35, new C.JulianDate());
clock.stopTime = C.JulianDate.addMinutes(liveNow(), 2, new C.JulianDate());
clock.currentTime = liveNow();
clock.clockRange = C.ClockRange.UNBOUNDED;
clock.clockStep = C.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
viewer.timeline.zoomTo(clock.startTime, clock.stopTime);
camera.setView({ destination: C.Cartesian3.fromDegrees(-100, 18, 2.4e7) });
const $ = (id) => document.getElementById(id);

// ---------- QuestDB ----------
const lastQ = {}; // label -> {sql, ms, rows}: what the live-query card shows
async function q(label, sql) {
  const r = await fetch("/exec?timings=true&query=" + encodeURIComponent(sql));
  const j = await r.json();
  if (j.error) throw new Error(`${label}: ${j.error}`);
  lastQ[label] = { sql, ms: j.timings.execute / 1e6, rows: j.count };
  return j.dataset;
}
const iso = (jd, dSec = 0) => C.JulianDate.toIso8601(C.JulianDate.addSeconds(jd, dSec, new C.JulianDate()), 6);
const isLive = () => C.JulianDate.secondsDifference(liveNow(), clock.currentTime) < 2;
// Live: now()-relative SQL, which reads well on the query card. Replay: absolute timestamps.
function since(back, lag = 0) {
  if (isLive()) {
    return lag ? `ts BETWEEN dateadd('s', -${back}, now()) AND dateadd('s', -${lag}, now())` : `ts > dateadd('s', -${back}, now())`;
  }
  return `ts BETWEEN '${iso(clock.currentTime, -back)}' AND '${iso(clock.currentTime, -lag)}'`;
}
function loop(fn, ms) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error(e); } finally { busy = false; }
  };
  run();
  setInterval(run, ms);
}

// ---------- rockets ----------
const rockets = new Map(); // key -> {entity, samples, row, seen, q}
let lastPollT = null, lastPollWall = 0;
const scratchT = new C.JulianDate();
const PHASES = { liftoff: "LIFTOFF", maxq: "MAX-Q", throttle_down_start: "THROTTLE DOWN", throttle_down_end: "THROTTLE UP",
  meco: "MAIN ENGINE CUTOFF", ses1: "2ND STAGE BURN", seco1: "ENGINE CUTOFF · COAST", ses2: "2ND STAGE RE-LIGHT", seco2: "ORBIT",
  boostback_start: "BOOSTBACK BURN", boostback_end: "BOOSTBACK DONE", apogee: "BOOSTER APOGEE", entry_start: "ENTRY BURN",
  entry_end: "ENTRY DONE", landing_start: "LANDING BURN", landing_end: "LANDED" };
const phase = (e) => PHASES[e] || (e || "").toUpperCase();
const PRE_SEP = new Set(["liftoff", "maxq", "throttle_down_start", "throttle_down_end"]);

function orientation(pos, headingDeg, pitchDeg) {
  // Model nose is +Z; point it along (heading, flight-path angle) in the local ENU frame.
  const h = deg(headingDeg), p = deg(pitchDeg);
  const d = new C.Cartesian3(Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p));
  const axis = C.Cartesian3.cross(C.Cartesian3.UNIT_Z, d, new C.Cartesian3());
  const local = C.Cartesian3.magnitude(axis) < 1e-6 ? C.Quaternion.IDENTITY
    : C.Quaternion.fromAxisAngle(C.Cartesian3.normalize(axis, axis), Math.acos(C.Math.clamp(d.z, -1, 1)));
  const enu = C.Matrix4.getMatrix3(C.Transforms.eastNorthUpToFixedFrame(pos), new C.Matrix3());
  return C.Quaternion.multiply(C.Quaternion.fromRotationMatrix(enu), local, new C.Quaternion());
}

const glow = (() => { // engine glow so rockets read as bright points from orbit distance
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d"), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.22, "rgba(255,214,150,.95)");
  r.addColorStop(1, "rgba(255,120,40,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return c;
})();
const BOOSTER = C.Color.fromCssColorString("#9fd6ff");

function rocket(key, launch, stage) {
  let r = rockets.get(key);
  if (r) return r;
  const samples = new C.SampledPositionProperty();
  samples.forwardExtrapolationType = samples.backwardExtrapolationType = C.ExtrapolationType.HOLD;
  r = { samples, q: C.Quaternion.IDENTITY };
  r.entity = viewer.entities.add({
    viewFrom: new C.Cartesian3(3000, -5000, 1500),
    position: new C.CallbackProperty((t, res) =>
      samples.getValue(C.JulianDate.addSeconds(t, -RENDER_DELAY, scratchT), res), false),
    orientation: new C.CallbackProperty(() => r.q, false),
    model: {
      uri: "models/rocket.glb", minimumPixelSize: px(stage === "1" ? 44 : 64), maximumScale: 5000,
      color: stage === "1" ? BOOSTER : C.Color.WHITE,
      colorBlendMode: C.ColorBlendMode.MIX, colorBlendAmount: stage === "1" ? 0.5 : 0,
    },
    billboard: {
      image: glow, width: px(stage === "1" ? 26 : 36), height: px(stage === "1" ? 26 : 36),
      color: stage === "1" ? BOOSTER : C.Color.WHITE,
      translucencyByDistance: new C.NearFarScalar(2e4, 0, 1.5e5, 1), // close up you see the model, far away the glow
    },
    label: {
      text: stage === "1" ? `${launch} booster` : launch, font: `600 ${Math.round(px(16))}px sans-serif`,
      fillColor: stage === "1" ? BOOSTER : C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 4,
      style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(px(20), -px(16)),
      horizontalOrigin: C.HorizontalOrigin.LEFT, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 1.5e6),
    },
  });
  r.entity.rocketKey = key;
  rockets.set(key, r);
  return r;
}

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
  const rows = await q("rockets",
    `SELECT t.ts, t.launch, t.stage, t.met, t.velocity, t.altitude, t.height,
       t.lat, t.lon, t.heading, t.pitch, e.event
FROM (SELECT * FROM rocket_telemetry WHERE ${since(3)}
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
    r.row = { launch, stage, met, vel, alt, heading, event, liftoff: C.JulianDate.toDate(when).getTime() - met * 1000 };
    r.seen = pollN;
  }
  for (const [key, r] of rockets) {
    if (pollN - r.seen > 15) {
      viewer.entities.remove(r.entity);
      rockets.delete(key);
    }
  }
  if (follow && !rockets.has(follow)) {
    follow = null;
    viewer.trackedEntity = undefined;
  }
  if (pollN % 3 === 0) renderFlights();
}
const rocketAt = (r, dSec = 0) =>
  r.samples.getValue(C.JulianDate.addSeconds(clock.currentTime, dSec - RENDER_DELAY, new C.JulianDate()));

// ---------- trails (SAMPLE BY), fading with age ----------
const trails = scene.primitives.add(new C.PolylineCollection());
// Trails refresh every 2 s, so on their own they'd end behind the rocket and jump to catch up. A
// two-point "tip" per rocket joins the trail's last point to the rocket every frame.
const tips = scene.primitives.add(new C.PolylineCollection());
const tipStart = new Map(); // rocket key -> last trail point
const tipLines = new Map(); // rocket key -> polyline
const TRAIL = { "1": C.Color.fromCssColorString("#9fd6ff"), "2": C.Color.fromCssColorString("#ff9a3c") };
async function pollTrails() {
  const rows = await q("trails",
    `SELECT ts, launch, stage, last(lat) lat, last(lon) lon, last(height) alt
FROM rocket_telemetry
WHERE ${since(TRAIL_MIN * 60, RENDER_DELAY)}
SAMPLE BY 2s`);
  const paths = new Map();
  for (const [, launch, stage, lat, lon, alt] of rows) {
    const k = `${launch}|${stage}`;
    if (!paths.has(k)) paths.set(k, []);
    paths.get(k).push(lon, lat, alt * 1000);
  }
  trails.removeAll();
  tipStart.clear();
  for (const [k, flat] of paths) {
    const pts = C.Cartesian3.fromDegreesArrayHeights(flat);
    tipStart.set(k, pts[pts.length - 1]);
    if (pts.length < 3) continue;
    const stage = k.slice(-1), N = 6;
    for (let i = 0; i < N; i++) { // oldest chunk faintest; chunks share endpoints so the line is continuous
      const a = Math.floor(pts.length * i / N), b = Math.min(pts.length, Math.floor(pts.length * (i + 1) / N) + 1);
      if (b - a < 2) continue;
      trails.add({
        id: k, positions: pts.slice(a, b), width: px(stage === "1" ? 2 : 3),
        material: C.Material.fromType("Color", { color: TRAIL[stage].withAlpha(0.12 + 0.78 * (i + 1) / N) }),
      });
    }
  }
}

const tipTime = new C.JulianDate();
scene.preRender.addEventListener((sc, time) => {
  C.JulianDate.addSeconds(time, -RENDER_DELAY, tipTime);
  for (const [k, line] of tipLines) {
    if (!rockets.has(k) || !tipStart.has(k)) { tips.remove(line); tipLines.delete(k); }
  }
  for (const [k, start] of tipStart) {
    const r = rockets.get(k);
    const end = r && r.entity.show && r.samples.getValue(tipTime);
    let line = tipLines.get(k);
    if (!end) { if (line) line.show = false; continue; }
    if (!line) {
      const stage = k.slice(-1);
      line = tips.add({ id: k, width: px(stage === "1" ? 2 : 3), material: C.Material.fromType("Color", { color: TRAIL[stage].withAlpha(0.9) }) });
      tipLines.set(k, line);
    }
    line.show = true;
    line.positions = [start, end]; // same length every frame: updated in place, no rebuild
  }
});

// ---------- satellites (LATEST ON over ~16k symbols), interpolated every frame ----------
const COLORS = { starlink: "#b56cff", oneweb: "#3ddc97", kuiper: "#ffd23f", iridium: "#4cc9f0", gps: "#ff5d8f",
  globalstar: "#f77f00", orbcomm: "#90be6d", planet: "#e9c46a", lemur: "#a8dadc", other: "#d5dde9" };
const NAMES = { starlink: "Starlink", oneweb: "OneWeb", kuiper: "Kuiper", iridium: "Iridium", gps: "GPS",
  globalstar: "Globalstar", orbcomm: "Orbcomm", planet: "Planet", lemur: "Spire Lemur", other: "Other" };
const satPoints = scene.primitives.add(new C.PointPrimitiveCollection());
const sats = new Map(); // norad -> {p, a, b, ta, tb}: two latest samples, extrapolated per frame
const counts = {};
const iss = viewer.entities.add({
  position: new C.CallbackProperty((t, res) => issAt(t, res), false),
  model: { uri: "models/iss.glb", minimumPixelSize: px(64), maximumScale: 20000 },
  label: { text: "ISS", font: `600 ${Math.round(px(16))}px sans-serif`, pixelOffset: new C.Cartesian2(px(20), -px(16)),
           fillColor: C.Color.YELLOW, outlineColor: C.Color.BLACK, outlineWidth: 4, style: C.LabelStyle.FILL_AND_OUTLINE },
});
async function pollSats() {
  const rows = await q("satellites",
    `SELECT ts, norad, constellation, x, y, z FROM satellites
WHERE ${since(3)}
LATEST ON ts PARTITION BY norad`);
  let tsStr = null, tsMs = 0;
  for (const [ts, norad, group, x, y, z] of rows) {
    if (ts !== tsStr) { tsStr = ts; tsMs = Date.parse(ts); }
    let s = sats.get(norad);
    if (!s) {
      s = { p: satPoints.add({ pixelSize: px(group === "other" ? 2 : 2.4), color: C.Color.fromCssColorString(COLORS[group] || COLORS.other),
                               scaleByDistance: new C.NearFarScalar(4e5, 2.6, 2e7, 1) }), group };
      sats.set(norad, s);
    }
    if (tsMs === s.tb) continue;
    s.a = s.b; s.ta = s.tb;
    s.b = new C.Cartesian3(x * 1000, y * 1000, z * 1000); s.tb = tsMs;
    if (!s.a) s.p.position = s.b;
  }
  satsFresh = true;
  $("k-sats").textContent = rows.length.toLocaleString();
}
function satAt(s, ms, result) { // linear over ~1 s of orbit: metres of error
  const f = Math.min((ms - s.tb) / (s.tb - s.ta), 3);
  result.x = s.b.x + (s.b.x - s.a.x) * f;
  result.y = s.b.y + (s.b.y - s.a.y) * f;
  result.z = s.b.z + (s.b.z - s.a.z) * f;
  return result;
}
const satScratch = new C.Cartesian3();
let satsFresh = false; // a new sample arrived since the last far-away update
scene.preRender.addEventListener((sc, time) => {
  // From far away a satellite moves < 1 px/s, so smoothing it every frame is wasted CPU (the biggest
  // per-frame cost here); just place the newest sample. Close up (LEO / ISS shots) interpolate.
  const far = C.Cartographic.fromCartesian(camera.positionWC).height > 5e6;
  if (far && !satsFresh) return;
  satsFresh = false;
  const now = C.JulianDate.toDate(time).getTime();
  for (const s of sats.values()) if (s.a) s.p.position = far ? s.b : satAt(s, now, satScratch);
});
// The ISS model and the camera both evaluate at the render time; updating it in preRender would draw
// the model a frame behind the camera (≈100 m at 7.7 km/s), which shows up as jitter in the ISS shot.
function issAt(time, result = new C.Cartesian3()) {
  const s = sats.get("25544");
  return s && s.a ? satAt(s, C.JulianDate.toDate(time).getTime(), result) : undefined;
}
const issVelocity = () => { // m/s from the last two samples
  const s = sats.get("25544");
  if (!s || !s.a) return null;
  return C.Cartesian3.multiplyByScalar(C.Cartesian3.subtract(s.b, s.a, new C.Cartesian3()), 1000 / (s.tb - s.ta), new C.Cartesian3());
};

async function pollLegend() {
  const rows = await q("constellations",
    `SELECT constellation, count() n FROM (
  SELECT constellation FROM satellites
  WHERE ${since(3)}
  LATEST ON ts PARTITION BY norad)
ORDER BY n DESC`);
  for (const [g, n] of rows) counts[g] = n;
  $("legend-rows").innerHTML = rows.map(([g, n]) =>
    `<div><i style="background:${COLORS[g] || COLORS.other}"></i>${NAMES[g] || g} <b class="num">${n.toLocaleString()}</b></div>`).join("");
}
async function pollIss() {
  await q("iss",
    `SELECT ts, avg(alt) altitude_km FROM satellites
WHERE norad = '25544' AND ${since(3600)}
SAMPLE BY 1m`);
}
async function pollRollup() {
  await q("rollup",
    `SELECT launch, max(velocity) top_speed, max(altitude) top_alt
FROM rocket_telemetry_1s
WHERE ${since(600)}
ORDER BY top_alt DESC LIMIT 5`);
}

// ---------- KPIs ----------
async function pollStats() {
  // Whole seconds only: satellites land in one batch per second, so a sliding window flickers.
  const w = isLive() ? "ts >= dateadd('s', -6, timestamp_floor('s', now())) AND ts < dateadd('s', -1, timestamp_floor('s', now()))"
    : `ts BETWEEN '${iso(clock.currentTime, -6)}' AND '${iso(clock.currentTime, -1)}'`;
  const [[rock], [sat]] = await q("rate",
    `SELECT count() FROM rocket_telemetry WHERE ${w}
UNION ALL
SELECT count() FROM satellites WHERE ${w}`);
  $("k-rate").innerHTML = `${Math.round((rock + sat) / 5).toLocaleString()}<small>rows/s</small>`;
  const [[a], [b]] = await q("total", "SELECT count() FROM rocket_telemetry UNION ALL SELECT count() FROM satellites");
  $("k-total").innerHTML = `${((a + b) / 1e6).toFixed(1)}<small>M</small>`;
  $("k-rockets").textContent = [...rockets.values()].filter((r) => r.entity.show).length;

  const lag = C.JulianDate.secondsDifference(liveNow(), clock.currentTime);
  const live = $("live");
  if (lag > 5) {
    live.className = "replay";
    live.innerHTML = `REPLAY −${Math.floor(lag / 60)}:${String(Math.floor(lag % 60)).padStart(2, "0")}<button id="golive">go live</button>`;
    $("golive").onclick = () => { clock.currentTime = liveNow(); clock.multiplier = 1; };
  } else {
    live.className = "";
    live.textContent = "LIVE";
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

// ---------- launch dates (the replay re-times flights to now) ----------
const launchDates = {};
const launchDate = (l) => launchDates[l] || "";
async function loadLaunchDates() {
  const rows = await q("dates", "SELECT launch, ts FROM launches");
  for (const [l, ts] of rows) {
    launchDates[l] = new Date(ts).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  }
  if (!rows.length) setTimeout(loadLaunchDates, 2000); // feeder not up yet
}
loadLaunchDates().catch(() => setTimeout(loadLaunchDates, 2000));

// ---------- director ----------
// Shots: fly to a pose (predicted for moving targets), then drive the camera every frame.
const FEATURES = {
  satellites: ["LATEST ON", "Newest position of every satellite: one row per symbol, out of ~16k symbols updating every second"],
  rockets: ["ASOF JOIN", "Each rocket's latest telemetry, joined to the flight event in effect at that instant"],
  trails: ["SAMPLE BY", "10 minutes of 30 Hz telemetry per flight, downsampled to 2-second points to draw every path"],
  constellations: ["GROUP BY over LATEST ON", "Live satellite count per constellation, straight from the latest positions"],
  iss: ["SAMPLE BY on one symbol", "The ISS's altitude over the last hour: one satellite picked out of millions of rows"],
  rollup: ["Materialized view", "Per-second rollups QuestDB keeps up to date incrementally as rows arrive"],
};
function hprPose(target, h, p, range) { // camera pose looking at target with heading/pitch in target's ENU frame
  const enu = C.Transforms.eastNorthUpToFixedFrame(target);
  const dir = C.Matrix4.multiplyByPointAsVector(enu,
    new C.Cartesian3(Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)), new C.Cartesian3());
  const destination = C.Cartesian3.subtract(target, C.Cartesian3.multiplyByScalar(dir, range, new C.Cartesian3()), new C.Cartesian3());
  const n = C.Ellipsoid.WGS84.geodeticSurfaceNormal(target, new C.Cartesian3());
  const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, n, new C.Cartesian3()), new C.Cartesian3());
  return { destination, orientation: { direction: dir, up: C.Cartesian3.cross(right, dir, new C.Cartesian3()) } };
}
const ahead = (pos, vel, s) => C.Cartesian3.add(pos, C.Cartesian3.multiplyByScalar(vel, s, new C.Cartesian3()), new C.Cartesian3());
const velOf = (r) => C.Cartesian3.subtract(rocketAt(r), rocketAt(r, -1), new C.Cartesian3());
const alive = (r) => r && rockets.has(r.entity.rocketKey) && r.entity.show;
const counted = (g) => (counts[g] || 0).toLocaleString();

const SHOTS = {
  globe() {
    const lon0 = -118;
    const at = (s) => ({ destination: C.Cartesian3.fromDegrees(lon0 + 1.4 * s, 18, 1.75e7), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
    return { secs: 26, feature: "satellites", tag: "EARTH", text: `${(sats.size).toLocaleString()} satellites, ${rockets.size} rocket stages in flight`,
      pose: () => at(0), frame: (s) => camera.setView(at(s)) };
  },
  ascent(exclude) {
    // Youngest upper stage that's clear of the pad and still climbing: the arc against Earth's curve.
    // Above ~60 km: lower down the camera looks across the ground, and Blue Marble (~2 km/px) smears.
    const r = [...rockets.values()].filter((r) => alive(r) && r.row.stage === "2" && r.row.alt > 60 && r.row.alt < 300 && r !== exclude)
      .sort((a, b) => a.row.met - b.row.met)[0];
    if (!r) return null;
    const h0 = deg(r.row.heading + 125), p = deg(-6), range = 70e3;
    return { secs: 22, feature: "rockets", subject: r, tag: "ASCENT",
      text: `${r.row.launch} · flew ${launchDate(r.row.launch)}`, valid: () => alive(r),
      pose: () => hprPose(ahead(rocketAt(r), velOf(r), FLY), h0, p, range),
      frame: (s) => camera.lookAt(rocketAt(r), new C.HeadingPitchRange(h0 + deg(2.5) * s, p, range)) };
  },
  staging() {
    // A launch with both stages flying separately: booster heading home, upper stage to orbit.
    const pairs = [...rockets.values()].filter((b) => alive(b) && b.row.stage === "1")
      .map((b) => [b, rockets.get(`${b.row.launch}|2`)])
      .filter(([b, u]) => alive(u) && C.Cartesian3.distance(rocketAt(b), rocketAt(u)) < 4e5); // still in one frame
    if (!pairs.length) return SHOTS.ascent(shot?.subject);
    const [b, u] = pairs.sort((x, y) => x[0].row.met - y[0].row.met)[0];
    const mid = () => C.Cartesian3.midpoint(rocketAt(b), rocketAt(u), new C.Cartesian3());
    const range = () => C.Math.clamp(C.Cartesian3.distance(rocketAt(b), rocketAt(u)) * 1.7, 6e4, 6e5);
    const h0 = deg(u.row.heading + 90), p = deg(-24);
    return { secs: 20, feature: "trails", subject: u, tag: "STAGING",
      text: `${u.row.launch}: booster heading home, upper stage to orbit`, valid: () => alive(b) && alive(u),
      pose: () => hprPose(ahead(mid(), velOf(u), FLY / 2), h0, p, range()),
      frame: (s) => camera.lookAt(mid(), new C.HeadingPitchRange(h0 + deg(1.5) * s, p, range())) };
  },
  starlink() {
    const at = (s) => ({ destination: C.Cartesian3.fromDegrees(-105 + 0.25 * s, 24, 1.1e6),
                         orientation: { heading: deg(35), pitch: deg(-24), roll: 0 } });
    return { secs: 18, feature: "constellations", tag: "LOW EARTH ORBIT",
      text: `${counted("starlink")} Starlink satellites, each position computed every second`,
      pose: () => at(0), frame: (s) => camera.setView(at(s)) };
  },
  iss() {
    const v = issVelocity(), pos = issAt(clock.currentTime);
    if (!v || !pos) return null;
    const enu = C.Matrix4.inverse(C.Transforms.eastNorthUpToFixedFrame(pos), new C.Matrix4());
    const ve = C.Matrix4.multiplyByPointAsVector(enu, v, new C.Cartesian3());
    const h0 = Math.atan2(ve.x, ve.y) + deg(160), p = deg(-12), range = 260;
    return { secs: 18, feature: "iss", tag: "ISS", text: "International Space Station · real position, right now",
      pose: () => hprPose(ahead(issAt(clock.currentTime), v, FLY), h0, p, range),
      frame: (s) => camera.lookAt(issAt(clock.currentTime), new C.HeadingPitchRange(h0 + deg(3) * s, p, range)) };
  },
  cape() {
    const cape = C.Cartesian3.fromDegrees(-79.2, 28.4, 0), p = deg(-34), range = 1.3e6;
    return { secs: 20, feature: "rollup", tag: "CAPE CANAVERAL", text: "Every flight path from the last 10 minutes",
      pose: () => hprPose(cape, deg(-15), p, range),
      frame: (s) => camera.lookAt(cape, new C.HeadingPitchRange(deg(-15 + 1.2 * s), p, range)) };
  },
};
const PLAN = ["globe", "ascent", "starlink", "staging", "iss", "cape"];
let directorOn = true, shot = null, planIdx = -1, lastInput = 0, follow = null;

function nextShot() {
  camera.cancelFlight();
  camera.lookAtTransform(C.Matrix4.IDENTITY);
  viewer.trackedEntity = undefined;
  let s = null;
  for (let i = 0; i < PLAN.length && !s; i++) {
    planIdx = (planIdx + 1) % PLAN.length;
    s = SHOTS[PLAN[planIdx]]();
  }
  shot = s;
  s.arrived = false;
  s.ends = Date.now() + (FLY + s.secs) * 1000;
  camera.flyTo({ ...s.pose(), duration: FLY, complete: () => { s.arrived = true; s.t0 = performance.now(); } });
  showCards();
}
scene.preRender.addEventListener(() => {
  if (directorOn && shot && shot.arrived) shot.frame((performance.now() - shot.t0) / 1000);
});
setInterval(() => {
  if (!directorOn && !follow && Date.now() - lastInput > IDLE_MS) resumeDirector();
  if (directorOn && shot && (Date.now() > shot.ends || (shot.valid && !shot.valid()))) nextShot();
}, 500);

function takeControl() { // a visitor touched something: stop driving, show the details
  lastInput = Date.now();
  if (!directorOn) return;
  directorOn = false;
  shot = null;
  camera.cancelFlight();
  camera.lookAtTransform(C.Matrix4.IDENTITY);
  document.body.classList.add("details");
  viewer.timeline.resize(); // it was display:none, so it never measured itself
  viewer.timeline.zoomTo(clock.startTime, clock.stopTime);
  showCards();
  renderFlights();
}
function resumeDirector() {
  directorOn = true;
  follow = null;
  document.body.classList.remove("details");
  nextShot();
}
for (const ev of ["pointerdown", "wheel", "touchstart"]) viewer.canvas.addEventListener(ev, takeControl, { passive: true });
document.addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") return resumeDirector();
  takeControl();
  if (e.key === "Escape") {
    follow = null;
    viewer.trackedEntity = undefined;
    camera.flyTo({ destination: C.Cartesian3.fromDegrees(-95, 20, 2.2e7) });
  }
});

// ---------- cards ----------
const KW = /\b(SELECT|FROM|WHERE|BETWEEN|AND|LATEST ON|PARTITION BY|ASOF JOIN|ON|SAMPLE BY|UNION ALL|ORDER BY|DESC|LIMIT|dateadd|now|last|count|max|avg)\b/g;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function showCards() {
  const s = directorOn ? shot : null;
  $("scene").classList.toggle("hide", !s);
  $("query").classList.toggle("hide", !s);
  if (s) {
    $("scene-tag").textContent = s.tag;
    $("scene-text").textContent = s.text;
  }
  renderCards();
}
// Every query the page runs, with how often, its QuestDB execution time and row count.
const QUERIES = [ // label, name, feature, runs per second
  ["rockets", "Rocket state", "LATEST ON + ASOF JOIN", 10], ["satellites", "Satellite positions", "LATEST ON", 1],
  ["rate", "Ingest rate", "count() per whole second", 1], ["total", "Rows stored", "count()", 1],
  ["flight", "Featured flight", "materialized view", 1], ["trails", "Flight paths", "SAMPLE BY", 0.5],
  ["constellations", "Constellations", "GROUP BY over LATEST ON", 0.2], ["rollup", "Top speeds", "materialized view", 0.2],
  ["iss", "ISS altitude", "SAMPLE BY, one symbol", 0.1],
];
$("q-rate").textContent = `${Math.round(QUERIES.reduce((n, x) => n + x[3], 0))} queries/s`;
function renderQueries() {
  const featured = directorOn && shot && shot.feature, details = document.body.classList.contains("details");
  $("q-rows").innerHTML = QUERIES.map(([label, name, feature, hz]) => {
    const lq = lastQ[label];
    if (!lq) return "";
    const ms = lq.ms < 10 ? lq.ms.toFixed(1) : Math.round(lq.ms);
    return `<div class="qr${label === featured ? " on" : ""}"><span>${name}<i>${feature}</i></span>` +
      `<span class="num">${hz >= 1 ? `${hz}/s` : `every ${Math.round(1 / hz)} s`}</span><span class="num ms">${ms} ms</span>` +
      `<span class="num">${lq.rows.toLocaleString()} rows</span>` +
      (details ? `<pre class="mono">${esc(lq.sql).replace(KW, '<span class="kw">$1</span>')}</pre>` : "") + "</div>";
  }).join("");
}
function renderCards() {
  renderQueries();
  const s = directorOn ? shot : null;
  if (s) {
    const [feature, what] = FEATURES[s.feature], lq = lastQ[s.feature];
    $("q-feature").textContent = feature;
    $("q-what").textContent = what;
    if (lq) {
      $("q-ms").innerHTML = `${lq.ms < 10 ? lq.ms.toFixed(1) : Math.round(lq.ms)}<small>ms · ${lq.rows.toLocaleString()} rows</small>`;
      $("q-sql").innerHTML = esc(lq.sql).replace(KW, '<span class="kw">$1</span>');
    }
  }
  const subject = follow ? rockets.get(follow) : s && s.subject;
  $("flight").classList.toggle("hide", !subject || !rockets.has(subject.entity.rocketKey));
  if (subject && subject.row) {
    const r = subject.row;
    $("f-name").textContent = r.stage === "1" ? `${r.launch} booster` : r.launch;
    $("f-flew").textContent = launchDate(r.launch) && `flew ${launchDate(r.launch)}`;
    $("f-phase").textContent = phase(r.event);
    $("f-met").textContent = `${Math.floor(r.met / 60)}:${String(Math.floor(r.met % 60)).padStart(2, "0")}`;
    $("f-vel").innerHTML = `${(r.vel / 1000).toFixed(2)}<small>km/s</small>`;
    $("f-alt").innerHTML = `${r.alt.toFixed(0)}<small>km</small>`;
  }
}

// ---------- flight chart (materialized view) ----------
const plot = $("plot"), g = plot.getContext("2d");
async function pollChart() {
  const subject = follow ? rockets.get(follow) : directorOn && shot && shot.subject;
  if (!subject || !subject.row) return;
  const { launch, stage } = subject.row;
  const rows = await q("flight",
    `SELECT ts, velocity, altitude FROM rocket_telemetry_1s
WHERE launch = '${launch.replace(/'/g, "''")}' AND stage = '${stage}' AND ${since(600)}`);
  const W = (plot.width = plot.clientWidth * devicePixelRatio), H = (plot.height = plot.clientHeight * devicePixelRatio);
  g.clearRect(0, 0, W, H);
  if (rows.length < 2) return;
  const t0 = Date.parse(rows[0][0]), span = Math.max(Date.parse(rows[rows.length - 1][0]) - t0, 1);
  for (const [col, color] of [[2, "#3ddc97"], [1, "#c45cff"]]) {
    const max = Math.max(...rows.map((x) => x[col]), 1);
    g.strokeStyle = color;
    g.lineWidth = 2.5 * devicePixelRatio * Math.max(1, innerHeight / 1080);
    g.lineJoin = "round";
    g.beginPath();
    rows.forEach((x, i) => g[i ? "lineTo" : "moveTo"]((Date.parse(x[0]) - t0) / span * W, H - 4 - x[col] / max * (H - 8)));
    g.stroke();
  }
}

// ---------- flight list (details mode) ----------
const flightRows = $("flight-rows");
const newestFirst = (a, b) => b.row.liftoff - a.row.liftoff || b.row.stage.localeCompare(a.row.stage);
function renderFlights() {
  if (!document.body.classList.contains("details")) return;
  // Update rows in place (keyed by flight) so clicks aren't lost to a re-render.
  const list = [...rockets.values()].filter((r) => r.row).sort(newestFirst);
  const keep = new Set(list.map((r) => r.entity.rocketKey));
  for (const tr of [...flightRows.children]) if (!keep.has(tr.dataset.k)) tr.remove();
  list.forEach((r, i) => {
    const key = r.entity.rocketKey, row = r.row;
    let tr = flightRows.querySelector(`tr[data-k="${CSS.escape(key)}"]`);
    if (!tr) {
      tr = document.createElement("tr");
      tr.dataset.k = key;
      tr.innerHTML = `<td>${row.launch.slice(0, 16)}${row.stage === "1" ? " ⇣" : ""}</td><td class="d"></td><td class="n"></td><td class="p"></td><td class="n"></td><td class="n"></td>`;
    }
    if (flightRows.children[i] !== tr) flightRows.insertBefore(tr, flightRows.children[i] || null);
    tr.className = key === follow ? "on" : "";
    const c = tr.children;
    c[1].textContent = launchDate(row.launch);
    c[2].textContent = `T+${Math.floor(row.met / 60)}:${String(Math.floor(row.met % 60)).padStart(2, "0")}`;
    c[3].textContent = phase(row.event);
    c[4].textContent = `${(row.vel / 1000).toFixed(2)} km/s`;
    c[5].textContent = `${row.alt.toFixed(0)} km`;
  });
}
function followUser(key) {
  if (!rockets.has(key)) return;
  takeControl();
  follow = key;
  viewer.trackedEntity = rockets.get(key).entity;
  renderFlights();
  renderCards();
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
  for (const o of scene.drillPick(position, 6)) {
    const key = o.id?.rocketKey ?? (typeof o.id === "string" ? o.id : null);
    if (key && rockets.has(key)) return followUser(key);
  }
}, C.ScreenSpaceEventType.LEFT_CLICK);

loop(pollRockets, 100);
loop(pollTrails, 2000);
loop(pollSats, 1000);
loop(pollStats, 1000);
loop(pollChart, 1000);
loop(pollLegend, 5000);
loop(pollIss, 10000);
loop(pollRollup, 5000);
setInterval(renderCards, 500);
// Let the first satellite and rocket polls land before the first camera move.
setTimeout(() => directorOn && nextShot(), 2500);
