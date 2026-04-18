
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readFileData(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
}

function writeOutput(data, file = "output.txt") {
  fs.writeFileSync(path.join(__dirname, file), JSON.stringify(data, null, 2), "utf8");
}

const data = readFileData("1.txt");
const { car, race, track, available_sets, weather, tyres } = data;
const weatherConditions = weather.conditions;
const tyreProperties = tyres.properties;

function round2(v) { return Math.round(v * 100) / 100; }

const WEATHER_KEY_MAP = {
  dry:        "dry_friction_multiplier",
  cold:       "cold_friction_multiplier",
  light_rain: "light_rain_friction_multiplier",
  heavy_rain: "heavy_rain_friction_multiplier",
};

function getStartingWeather() {
  return weatherConditions.find(w => w.id === race.starting_weather_condition_id)
    ?? weatherConditions[0];
}


function pickBestCompound() {
  const weather = getStartingWeather();
  const key = WEATHER_KEY_MAP[weather.condition] ?? "dry_friction_multiplier";

  let best = null, bestFriction = -Infinity;
  for (const set of available_sets) {
    const props = tyreProperties[set.compound];
    // friction = life_span * weather_multiplier  (no degradation in L1)
    const friction = props.life_span * props[key];
    if (friction > bestFriction) { bestFriction = friction; best = set; }
  }
  return best;
}

function getTyreFriction(compound) {
  const props = tyreProperties[compound];
  const weather = getStartingWeather();
  const key = WEATHER_KEY_MAP[weather.condition] ?? "dry_friction_multiplier";
  return props.life_span * props[key];
}

function safeCornerSpeed(radius, compound) {
  const friction = getTyreFriction(compound);
  return Math.sqrt(friction * 9.8 * radius) + car["crawl_constant_m/s"];
}

/**
 * On a straight of `length` m, starting at `entrySpeed` and needing to
 * arrive at `cornerSpeed`:
 *   accel phase:  entry → target   (distance = (target²-entry²)/(2a))
 *   cruise phase: target           (distance = rest)
 *   brake phase:  target → corner  (distance = (target²-corner²)/(2b))
 *
 * Solving for target s.t. accelDist + brakeDist ≤ length:
 *   (t²-e²)/(2a) + (t²-c²)/(2b) ≤ L
 *   t² [ 1/(2a)+1/(2b) ] ≤ L + e²/(2a) + c²/(2b)
 */
function solveMaxPeakSpeed({ entrySpeed, cornerSpeed, length, accel, brake, maxSpeed }) {
  const num = length + entrySpeed ** 2 / (2 * accel) + cornerSpeed ** 2 / (2 * brake);
  const den = 1 / (2 * accel) + 1 / (2 * brake);
  const target = Math.sqrt(Math.max(0, num / den));
  return Math.min(target, maxSpeed);
}

function brakeDistance(targetSpeed, cornerSpeed, brake) {
  return Math.max(0, (targetSpeed ** 2 - cornerSpeed ** 2) / (2 * brake));
}

function getNextCornerIndex(segments, from) {
  for (let i = from + 1; i < segments.length; i++) {
    if (segments[i].type === "corner") return i;
  }
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].type === "corner") return i;
  }
  return -1;
}

// ── Lap generation ───────────────────────────────────────────────────────────
function generateLap(segments, entrySpeed, compound) {
  const out = [];
  let speed = entrySpeed;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (seg.type === "straight") {
      const ni = getNextCornerIndex(segments, i);
      if (ni === -1) throw new Error("No corner on track");
      const nextCorner = segments[ni];
      const cs = safeCornerSpeed(nextCorner.radius_m, compound);

      const target = solveMaxPeakSpeed({
        entrySpeed: speed,
        cornerSpeed: cs,
        length: seg.length_m,
        accel: car["accel_m/se2"],
        brake: car["brake_m/se2"],
        maxSpeed: car["max_speed_m/s"],
      });

      const bd = brakeDistance(target, cs, car["brake_m/se2"]);

      out.push({
        id: seg.id,
        type: "straight",
        "target_m/s": round2(target),
        brake_start_m_before_next: round2(bd),
      });

      speed = cs; // exit straight at corner speed
    } else {
      out.push({ id: seg.id, type: "corner" });
      // speed unchanged through corner
    }
  }

  return { segments: out, exitSpeed: speed };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const bestSet = pickBestCompound();
const compound = bestSet.compound;
const initialTyreId = bestSet.ids[0];

const laps = [];
let currentSpeed = 0;

for (let lap = 1; lap <= race.laps; lap++) {
  const result = generateLap(track.segments, currentSpeed, compound);
  laps.push({
    lap,
    segments: result.segments,
    pit: { enter: false },
  });
  currentSpeed = result.exitSpeed;
}

writeOutput({ initial_tyre_id: initialTyreId, laps });
console.log(`Level 1 done. Compound: ${compound} (id=${initialTyreId})`);
