/**
 * ENTELECT GRAND PRIX - LEVEL 4 (OPTIMIZED)
 *
 * Score = base_score + tyre_bonus + fuel_bonus
 *   base_score  = 500000 * (time_ref / race_time)^3  → minimize time
 *   tyre_bonus  = 100000 * Σ(degradation per tyre used) - 50000 * blowouts
 *               → maximize degradation used WITHOUT blowing out
 *   fuel_bonus  = -500000*(1 - fuel_used/soft_cap)^2 + 500000
 *               → use as close to soft_cap fuel as possible
 *
 * Key insight on tyre_bonus:
 *   Every tyre used at degradation 0.99 scores 99 000 points.
 *   A blowout at degradation 1.0 scores 100 000 - 50 000 = 50 000 points.
 *   So NEVER blow out — pit just before 1.0 degradation.
 *
 * Strategy:
 * 1. Each lap, simulate with current tyre state.
 * 2. If projected degradation after next lap >= PIT_THRESHOLD → pit.
 * 3. On pit: choose a new tyre compound appropriate for current weather.
 *    Prefer compounds that won't blow out before their stint ends.
 * 4. Fuel: refuel the minimum amount needed to reach end (or next pit stop).
 * 5. Weather: always use the best compound for current weather to maximize
 *    corner speeds (reduces race time = better base_score).
 */

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

const data = readFileData("4.txt");
const { car, race, track, available_sets, weather, tyres } = data;
const weatherConditions = weather.conditions;
const tyreProperties = tyres.properties;

function round2(v) { return Math.round(v * 100) / 100; }

// ── Constants ────────────────────────────────────────────────────────────────
const G = 9.8;
const K_STRAIGHT = 0.0000166;
const K_BRAKING  = 0.0398;
const K_CORNER   = 0.000265;
const K_BASE_FUEL = 0.0005;
const K_DRAG_FUEL = 0.0000000015;

// Base friction coefficients (from problem statement)
const BASE_FRICTION = { Soft: 1.8, Medium: 1.7, Hard: 1.6, Intermediate: 1.2, Wet: 1.1 };

// Pit just before blowout — leave a tiny buffer so we never blow out
const PIT_DEGRADATION_THRESHOLD = 0.93;

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
const WEATHER_DEG_KEY = {
  dry:        "dry_degradation",
  cold:       "cold_degradation",
  light_rain: "light_rain_degradation",
  heavy_rain: "heavy_rain_degradation",
};

// ── Tyre inventory ───────────────────────────────────────────────────────────
const inventory = {};
for (const set of available_sets) {
  for (const id of set.ids) {
    inventory[id] = { id, compound: set.compound, degradation: 0, used: false };
  }
}

function unusedTyres() { return Object.values(inventory).filter(t => !t.used); }

// ── Tyre physics ─────────────────────────────────────────────────────────────
function getTyreFriction(compound, degradation, condition) {
  const props = tyreProperties[compound];
  const baseFric = BASE_FRICTION[compound];
  const effectiveBase = Math.max(0.05, baseFric - degradation);
  return effectiveBase * props[WEATHER_FRICTION_KEY[condition]];
}

function getDegRate(compound, condition) {
  return tyreProperties[compound][WEATHER_DEG_KEY[condition]];
}

function straightDeg(compound, condition, length) {
  return getDegRate(compound, condition) * length * K_STRAIGHT;
}

function brakingDeg(compound, condition, vHigh, vLow) {
  const rate = getDegRate(compound, condition);
  return Math.max(0, ((vHigh / 100) ** 2 - (vLow / 100) ** 2)) * K_BRAKING * rate;
}

function cornerDeg(compound, condition, speed, radius) {
  return K_CORNER * (speed ** 2 / radius) * getDegRate(compound, condition);
}

// ── Physics ──────────────────────────────────────────────────────────────────
function safeCornerSpeed(radius, compound, degradation, condition) {
  const friction = getTyreFriction(compound, degradation, condition);
  return Math.sqrt(Math.max(0, friction * G * radius)) + car["crawl_constant_m/s"];
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
  return (K_BASE_FUEL + K_DRAG_FUEL * avg ** 2) * dist;
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
function simulateLap({ entrySpeed, tyreId, lapStartTime }) {
  const tyreState = { ...inventory[tyreId] }; // working copy
  const out = [];
  let speed = entrySpeed;
  let lapTime = 0;
  let lapFuel = 0;
  let blewOut = false;

  for (let i = 0; i < track.segments.length; i++) {
    const seg = track.segments[i];
    const w = getWeatherAtTime(lapStartTime + lapTime);
    const effAccel = car["accel_m/se2"] * w.acceleration_multiplier;
    const effBrake = car["brake_m/se2"] * w.deceleration_multiplier;

    if (seg.type === "straight") {
      const ni = getNextCornerIndex(track.segments, i);
      const cs = safeCornerSpeed(track.segments[ni].radius_m, tyreState.compound, tyreState.degradation, w.condition);
      const target = solveMaxPeakSpeed({
        entrySpeed: speed, cornerSpeed: cs, length: seg.length_m,
        accel: effAccel, brake: effBrake, maxSpeed: car["max_speed_m/s"],
      });
      const bd = brakeDistance(target, cs, effBrake);
      const dt = segTime({ entrySpeed: speed, targetSpeed: target, cornerSpeed: cs, length: seg.length_m, accel: effAccel, brake: effBrake });

      lapTime += dt;
      lapFuel += fuelUsed(speed, target, seg.length_m);

      // Degradation: straight + braking
      tyreState.degradation += straightDeg(tyreState.compound, w.condition, seg.length_m);
      tyreState.degradation += brakingDeg(tyreState.compound, w.condition, target, cs);
      if (tyreState.degradation >= 1) blewOut = true;

      out.push({ id: seg.id, type: "straight", "target_m/s": round2(target), brake_start_m_before_next: round2(bd) });
      speed = cs;
    } else {
      const cornerTime = seg.length_m / Math.max(speed, 1e-4);
      lapTime += cornerTime;
      lapFuel += fuelUsed(speed, speed, seg.length_m);

      tyreState.degradation += cornerDeg(tyreState.compound, w.condition, speed, seg.radius_m);
      if (tyreState.degradation >= 1) blewOut = true;

      out.push({ id: seg.id, type: "corner" });
    }
  }

  return { segments: out, exitSpeed: speed, lapTime, lapFuel, tyreAfterLap: tyreState, blewOut };
}

// ── Pit tyre selection ───────────────────────────────────────────────────────
function bestCompoundForWeather(condition) {
  const key = WEATHER_FRICTION_KEY[condition];
  let best = null, bestF = -Infinity;
  for (const set of available_sets) {
    const props = tyreProperties[set.compound];
    // Use base friction * multiplier (at degradation=0, fresh tyre)
    const f = BASE_FRICTION[set.compound] * props[key];
    if (f > bestF) { bestF = f; best = set.compound; }
  }
  return best;
}

/**
 * Choose the best unused tyre to mount next.
 * Priority:
 *  1. Weather-appropriate compound (best friction for current/upcoming weather)
 *  2. Among weather-appropriate, prefer the one that can run longest (lowest deg rate)
 *  3. Fallback to any unused tyre
 */
function choosePitTyre(raceTime, lapTime) {
  const weatherNow = getWeatherAtTime(raceTime + lapTime);
  const ideal = bestCompoundForWeather(weatherNow.condition);

  const unused = unusedTyres();
  // First try: exact match to ideal compound
  const match = unused.find(t => t.compound === ideal);
  if (match) return match.id;

  // Fallback: pick the compound with best friction in current weather
  let bestId = null, bestF = -Infinity;
  for (const t of unused) {
    const f = BASE_FRICTION[t.compound] * tyreProperties[t.compound][WEATHER_FRICTION_KEY[weatherNow.condition]];
    if (f > bestF) { bestF = f; bestId = t.id; }
  }
  return bestId;
}

// ── Initial tyre ─────────────────────────────────────────────────────────────
function chooseInitialTyre() {
  const w = getWeatherAtTime(0);
  const ideal = bestCompoundForWeather(w.condition);
  const match = unusedTyres().find(t => t.compound === ideal);
  return match ? match.id : unusedTyres()[0].id;
}

// ── Race ─────────────────────────────────────────────────────────────────────
const softCap = race["fuel_soft_cap_limit_l"];
const initialTyreId = chooseInitialTyre();
inventory[initialTyreId].used = true;

const laps = [];
let raceTime = 0;
let currentSpeed = 0;
let fuelRemaining = car["initial_fuel_l"];
let currentTyreId = initialTyreId;

for (let lap = 1; lap <= race.laps; lap++) {
  const lapResult = simulateLap({ entrySpeed: currentSpeed, tyreId: currentTyreId, lapStartTime: raceTime });

  // Apply degradation tentatively
  inventory[currentTyreId].degradation = lapResult.tyreAfterLap.degradation;

  const lapsLeft = race.laps - lap;
  const fuelAfterLap = fuelRemaining - lapResult.lapFuel;

  // ── Pit decision ─────────────────────────────────────────────────────────
  const degradationAfterLap = lapResult.tyreAfterLap.degradation;

  // Pit if tyre has crossed the safety threshold (prevents blowouts)
  const willBlowNextLap = degradationAfterLap >= PIT_DEGRADATION_THRESHOLD;

  // Weather-driven tyre change
  const weatherNext = getWeatherAtTime(raceTime + lapResult.lapTime);
  const idealNext = bestCompoundForWeather(weatherNext.condition);
  const weatherTyreChange = idealNext !== inventory[currentTyreId].compound && lapsLeft > 0;

  // Fuel check
  const estimatedFuelPerLap = lapResult.lapFuel;
  const fuelNeededToFinish = estimatedFuelPerLap * lapsLeft;
  const needFuel = fuelAfterLap < fuelNeededToFinish && lapsLeft > 0;

  const needPit = (willBlowNextLap || lapResult.blewOut || weatherTyreChange || needFuel) && lapsLeft > 0;

  let pit = { enter: false };

  if (needPit) {
    pit.enter = true;

    // Tyre change?
    const newTyreId = choosePitTyre(raceTime, lapResult.lapTime);
    if (newTyreId && newTyreId !== currentTyreId) {
      inventory[newTyreId].used = true;
      pit.tyre_change_set_id = newTyreId;
    }

    // Fuel: refuel just enough to reach end (minimize pitstop time = minimize race time)
    if (needFuel || fuelAfterLap < estimatedFuelPerLap * 1.1) {
      const fuelTarget = Math.min(
        car["fuel_tank_capacity_l"],
        fuelAfterLap + fuelNeededToFinish + estimatedFuelPerLap * 0.05 // tiny buffer
      );
      const refuelAmt = round2(Math.max(0, Math.min(fuelTarget - fuelAfterLap, car["fuel_tank_capacity_l"] - fuelAfterLap)));
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
    if (pit.tyre_change_set_id) currentTyreId = pit.tyre_change_set_id;
    currentSpeed = race["pit_exit_speed_m/s"];
  } else {
    currentSpeed = lapResult.exitSpeed;
  }
}

writeOutput({ initial_tyre_id: initialTyreId, laps });
console.log(`Level 4 done. Initial tyre: ${initialTyreId} (${inventory[initialTyreId].compound})`);

