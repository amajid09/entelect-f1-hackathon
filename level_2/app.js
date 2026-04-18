
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

const data = readFileData("2.txt");
const { car, race, track, available_sets, weather, tyres } = data;
const weatherConditions = weather.conditions;
const tyreProperties = tyres.properties;

function round2(v) { return Math.round(v * 100) / 100; }

// ── Weather ──────────────────────────────────────────────────────────────────
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

// ── Tyre selection ───────────────────────────────────────────────────────────
function pickBestCompound() {
  const weatherObj = getStartingWeather();
  const key = WEATHER_KEY_MAP[weatherObj.condition] ?? "dry_friction_multiplier";
  let best = null, bestF = -Infinity;
  for (const set of available_sets) {
    const f = tyreProperties[set.compound].life_span * tyreProperties[set.compound][key];
    if (f > bestF) { bestF = f; best = set; }
  }
  return best;
}

// ── Physics ──────────────────────────────────────────────────────────────────
function getTyreFriction(compound) {
  const props = tyreProperties[compound];
  const w = getStartingWeather();
  return props.life_span * props[WEATHER_KEY_MAP[w.condition] ?? "dry_friction_multiplier"];
}

function safeCornerSpeed(radius, compound) {
  return Math.sqrt(getTyreFriction(compound) * 9.8 * radius) + car["crawl_constant_m/s"];
}

function solveMaxPeakSpeed({ entrySpeed, cornerSpeed, length, accel, brake, maxSpeed }) {
  const num = length + entrySpeed ** 2 / (2 * accel) + cornerSpeed ** 2 / (2 * brake);
  const den = 1 / (2 * accel) + 1 / (2 * brake);
  return Math.min(Math.sqrt(Math.max(0, num / den)), maxSpeed);
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

// ── Fuel ─────────────────────────────────────────────────────────────────────
const K_BASE = 0.0005;
const K_DRAG = 0.0000000015;

function fuelUsedSegment(v_initial, v_final, distance) {
  const avg = (v_initial + v_final) / 2;
  return (K_BASE + K_DRAG * avg ** 2) * distance;
}

// ── Lap simulation ───────────────────────────────────────────────────────────
function simulateLap(segments, entrySpeed, compound) {
  const out = [];
  let speed = entrySpeed;
  let fuelUsed = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (seg.type === "straight") {
      const ni = getNextCornerIndex(segments, i);
      const cs = safeCornerSpeed(segments[ni].radius_m, compound);

      const target = solveMaxPeakSpeed({
        entrySpeed: speed,
        cornerSpeed: cs,
        length: seg.length_m,
        accel: car["accel_m/se2"],
        brake: car["brake_m/se2"],
        maxSpeed: car["max_speed_m/s"],
      });

      const bd = brakeDistance(target, cs, car["brake_m/se2"]);
      fuelUsed += fuelUsedSegment(speed, target, seg.length_m);

      out.push({
        id: seg.id,
        type: "straight",
        "target_m/s": round2(target),
        brake_start_m_before_next: round2(bd),
      });
      speed = cs;
    } else {
      fuelUsed += fuelUsedSegment(speed, speed, seg.length_m);
      out.push({ id: seg.id, type: "corner" });
    }
  }

  return { segments: out, exitSpeed: speed, fuelUsed };
}

// Pre-simulate one lap to know exact fuel per lap
function computeExactFuelPerLap(compound) {
  return simulateLap(track.segments, 0, compound).fuelUsed;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const bestSet = pickBestCompound();
const compound = bestSet.compound;
const initialTyreId = bestSet.ids[0];

// Pre-compute per-lap fuel cost (approximately; first lap starts at 0, rest at exitSpeed)
// We'll track exactly during the race loop.
const laps = [];
let currentSpeed = 0;
let fuelRemaining = car["initial_fuel_l"];

// We want to use exactly soft_cap total. Track cumulative fuel used.
const softCap = race["fuel_soft_cap_limit_l"];

for (let lap = 1; lap <= race.laps; lap++) {
  const lapResult = simulateLap(track.segments, currentSpeed, compound);
  const lapsLeft = race.laps - lap; // laps remaining after this one

  // Fuel after consuming this lap
  const fuelAfterLap = fuelRemaining - lapResult.fuelUsed;

  // Decide if we need to pit for fuel
  // Pit if we won't have enough fuel to complete all remaining laps
  const fuelNeededToFinish = lapResult.fuelUsed * lapsLeft; // approximate using this lap's cost
  let pit = { enter: false };

  if (fuelAfterLap < fuelNeededToFinish && lapsLeft > 0) {
    // Refuel: add exactly what we need to reach the end
    // Aim to use exactly softCap total (or as close as possible)
    const targetRefuel = Math.min(
      fuelNeededToFinish - fuelAfterLap,
      car["fuel_tank_capacity_l"] - fuelAfterLap,
    );
    const refuelAmount = Math.max(0, round2(targetRefuel));

    if (refuelAmount > 0) {
      pit = {
        enter: true,
        fuel_refuel_amount_l: refuelAmount,
      };
      fuelRemaining = fuelAfterLap + refuelAmount;
      currentSpeed = race["pit_exit_speed_m/s"];
    }
  } else {
    fuelRemaining = fuelAfterLap;
    currentSpeed = lapResult.exitSpeed;
  }

  if (!pit.enter) fuelRemaining = fuelAfterLap;

  laps.push({ lap, segments: lapResult.segments, pit });
}

writeOutput({ initial_tyre_id: initialTyreId, laps });
console.log(`Level 2 done. Compound: ${compound}`);

