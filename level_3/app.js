
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readFileData(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
}
function writeOutput(data) {
  fs.writeFileSync(path.join(__dirname, "output.txt"), JSON.stringify(data, null, 2), "utf8");
}

const data = readFileData("3.txt");
const { car, race, track, available_sets, weather, tyres } = data;
const weatherConditions = weather.conditions;
const tyreProperties = tyres.properties;

function round2(v) { return Math.round(v * 100) / 100; }

// ── Weather cycling ──────────────────────────────────────────────────────────
const CYCLE_DURATION = weatherConditions.reduce((s, w) => s + w.duration_s, 0);

function getWeatherAtTime(t) {
  const tInCycle = t % CYCLE_DURATION;
  let elapsed = 0;
  for (const w of weatherConditions) {
    elapsed += w.duration_s;
    if (tInCycle < elapsed) return w;
  }
  return weatherConditions[weatherConditions.length - 1];
}

const WEATHER_FRICTION_KEY = {
  dry:        "dry_friction_multiplier",
  cold:       "cold_friction_multiplier",
  light_rain: "light_rain_friction_multiplier",
  heavy_rain: "heavy_rain_friction_multiplier",
};

// ── Tyre selection ───────────────────────────────────────────────────────────
/**
 * Best compound = highest effective friction in the given weather.
 * tyre_friction = life_span * weather_multiplier (no degradation in L3)
 * But we also want a tyre that won't be penalised in the next weather window.
 * Simple heuristic: pick best friction for current weather.
 */
function bestCompoundForWeather(condition) {
  const key = WEATHER_FRICTION_KEY[condition];
  let best = null, bestF = -Infinity;
  for (const set of available_sets) {
    const props = tyreProperties[set.compound];
    const f = props.life_span * props[key];
    if (f > bestF) { bestF = f; best = set.compound; }
  }
  return best;
}

function getAvailableId(compound) {
  const set = available_sets.find(s => s.compound === compound);
  if (!set) throw new Error(`No set for ${compound}`);
  return set.ids[0];
}

// ── Physics ──────────────────────────────────────────────────────────────────
const G = 9.8;
const K_BASE = 0.0005;
const K_DRAG = 0.0000000015;

function getTyreFriction(compound, condition) {
  const props = tyreProperties[compound];
  return props.life_span * props[WEATHER_FRICTION_KEY[condition]];
}

function safeCornerSpeed(radius, compound, condition) {
  return Math.sqrt(getTyreFriction(compound, condition) * G * radius) + car["crawl_constant_m/s"];
}

function solveMaxPeakSpeed({ entrySpeed, cornerSpeed, length, accel, brake, maxSpeed }) {
  const num = length + entrySpeed ** 2 / (2 * accel) + cornerSpeed ** 2 / (2 * brake);
  const den = 1 / (2 * accel) + 1 / (2 * brake);
  return Math.min(Math.sqrt(Math.max(0, num / den)), maxSpeed);
}

function brakeDistance(target, cs, brake) {
  return Math.max(0, (target ** 2 - cs ** 2) / (2 * brake));
}

function segTime({ entrySpeed, targetSpeed, cornerSpeed, length, accel, brake }) {
  const accelDist = Math.max(0, (targetSpeed ** 2 - entrySpeed ** 2) / (2 * accel));
  const brakeDist = Math.max(0, (targetSpeed ** 2 - cornerSpeed ** 2) / (2 * brake));
  const cruiseDist = Math.max(0, length - accelDist - brakeDist);
  let t = 0;
  if (targetSpeed > entrySpeed) t += (targetSpeed - entrySpeed) / accel;
  if (cruiseDist > 0) t += cruiseDist / Math.max(targetSpeed, 1e-4);
  if (targetSpeed > cornerSpeed) t += (targetSpeed - cornerSpeed) / brake;
  return t;
}

function fuelUsed(vi, vf, dist) {
  const avg = (vi + vf) / 2;
  return (K_BASE + K_DRAG * avg ** 2) * dist;
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

// ── Lap simulation ───────────────────────────────────────────────────────────
function simulateLap({ segments, entrySpeed, compound, lapStartTime }) {
  const out = [];
  let speed = entrySpeed;
  let lapTime = 0;
  let lapFuel = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const w = getWeatherAtTime(lapStartTime + lapTime);
    const effAccel = car["accel_m/se2"] * w.acceleration_multiplier;
    const effBrake = car["brake_m/se2"] * w.deceleration_multiplier;

    if (seg.type === "straight") {
      const ni = getNextCornerIndex(segments, i);
      const cs = safeCornerSpeed(segments[ni].radius_m, compound, w.condition);
      const target = solveMaxPeakSpeed({
        entrySpeed: speed, cornerSpeed: cs, length: seg.length_m,
        accel: effAccel, brake: effBrake, maxSpeed: car["max_speed_m/s"],
      });
      const bd = brakeDistance(target, cs, effBrake);
      const dt = segTime({
        entrySpeed: speed, targetSpeed: target, cornerSpeed: cs,
        length: seg.length_m, accel: effAccel, brake: effBrake,
      });
      lapTime += dt;
      lapFuel += fuelUsed(speed, target, seg.length_m);
      out.push({ id: seg.id, type: "straight", "target_m/s": round2(target), brake_start_m_before_next: round2(bd) });
      speed = cs;
    } else {
      const cornerTime = seg.length_m / Math.max(speed, 1e-4);
      lapTime += cornerTime;
      lapFuel += fuelUsed(speed, speed, seg.length_m);
      out.push({ id: seg.id, type: "corner" });
    }
  }

  return { segments: out, exitSpeed: speed, lapTime, lapFuel };
}

// ── Race ─────────────────────────────────────────────────────────────────────
const softCap = race["fuel_soft_cap_limit_l"];

// Choose initial compound based on starting weather
const startWeather = getWeatherAtTime(0);
let currentCompound = bestCompoundForWeather(startWeather.condition);
const initialTyreId = getAvailableId(currentCompound);

const laps = [];
let raceTime = 0;
let currentSpeed = 0;
let fuelRemaining = car["initial_fuel_l"];

for (let lap = 1; lap <= race.laps; lap++) {
  const lapResult = simulateLap({
    segments: track.segments,
    entrySpeed: currentSpeed,
    compound: currentCompound,
    lapStartTime: raceTime,
  });

  const fuelAfterLap = fuelRemaining - lapResult.lapFuel;
  const lapsLeft = race.laps - lap;

  // Weather at start of next lap
  const weatherNextLap = getWeatherAtTime(raceTime + lapResult.lapTime);
  const idealNextCompound = bestCompoundForWeather(weatherNextLap.condition);

  // Decide pit
  const needTyreChange = idealNextCompound !== currentCompound && lapsLeft > 0;
  const estimatedFuelNeeded = lapResult.lapFuel * lapsLeft;
  const needFuel = fuelAfterLap < estimatedFuelNeeded && lapsLeft > 0;

  let pit = { enter: false };

  if ((needTyreChange || needFuel) && lapsLeft > 0) {
    pit.enter = true;

    if (needTyreChange) {
      pit.tyre_change_set_id = getAvailableId(idealNextCompound);
    }

    if (needFuel || needTyreChange) {
      // Refuel just enough to finish — aim near soft cap
      const fuelToEnd = estimatedFuelNeeded - fuelAfterLap;
      const maxCanAdd = car["fuel_tank_capacity_l"] - fuelAfterLap;
      const refuelAmt = round2(Math.min(Math.max(0, fuelToEnd), maxCanAdd));
      if (refuelAmt > 0) pit.fuel_refuel_amount_l = refuelAmt;
    }
  }

  laps.push({ lap, segments: lapResult.segments, pit });

  fuelRemaining = fuelAfterLap;
  raceTime += lapResult.lapTime;

  if (pit.enter) {
    const pitBase = race["base_pit_stop_time_s"];
    const swapTime = pit.tyre_change_set_id ? race["pit_tyre_swap_time_s"] : 0;
    const refTime = pit.fuel_refuel_amount_l ? pit.fuel_refuel_amount_l / race["pit_refuel_rate_l/s"] : 0;
    raceTime += pitBase + swapTime + refTime;
    if (pit.fuel_refuel_amount_l) fuelRemaining += pit.fuel_refuel_amount_l;
    if (pit.tyre_change_set_id) currentCompound = idealNextCompound;
    currentSpeed = race["pit_exit_speed_m/s"];
  } else {
    currentSpeed = lapResult.exitSpeed;
  }
}

writeOutput({ initial_tyre_id: initialTyreId, laps });
console.log(`Level 3 done. Initial compound: ${currentCompound}`);

