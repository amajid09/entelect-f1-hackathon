import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readFileData(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
}

function writeOutput(data, file = "output.txt") {
  fs.writeFileSync(
    path.join(__dirname, file),
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

const data = readFileData("2.txt");
const { car, race, track, available_sets, weather, tyres } = data;
const weatherConditions = weather.conditions;
const tyreProperties = tyres.properties;

function round2(v) {
  return Math.round(v * 100) / 100;
}

// ── Weather ──────────────────────────────────────────────────────────────────
const WEATHER_KEY_MAP = {
  dry: "dry_friction_multiplier",
  cold: "cold_friction_multiplier",
  light_rain: "light_rain_friction_multiplier",
  heavy_rain: "heavy_rain_friction_multiplier",
};

function getStartingWeather() {
  return (
    weatherConditions.find((w) => w.id === race.starting_weather_condition_id) ??
    weatherConditions[0]
  );
}

// ── Tyre selection ───────────────────────────────────────────────────────────
function pickBestCompound() {
  const weatherObj = getStartingWeather();
  const key =
    WEATHER_KEY_MAP[weatherObj.condition] ?? "dry_friction_multiplier";

  let best = null;
  let bestFriction = -Infinity;

  for (const set of available_sets) {
    const props = tyreProperties[set.compound];
    const friction = props.life_span * props[key];

    if (friction > bestFriction) {
      bestFriction = friction;
      best = set;
    }
  }

  return best;
}

// ── Physics ──────────────────────────────────────────────────────────────────
function getTyreFriction(compound) {
  const props = tyreProperties[compound];
  const w = getStartingWeather();
  const key = WEATHER_KEY_MAP[w.condition] ?? "dry_friction_multiplier";
  return props.life_span * props[key];
}

function safeCornerSpeed(radius, tyreFriction) {
  return Math.sqrt(tyreFriction * 9.8 * radius) + car["crawl_constant_m/s"];
}

function solveMaxPeakSpeed({
  entrySpeed,
  cornerSpeed,
  length,
  accel,
  brake,
  maxSpeed,
}) {
  const numerator =
    length +
    entrySpeed ** 2 / (2 * accel) +
    cornerSpeed ** 2 / (2 * brake);

  const denominator = 1 / (2 * accel) + 1 / (2 * brake);

  const target = Math.sqrt(Math.max(0, numerator / denominator));
  return Math.min(target, maxSpeed);
}

function brakeDistance(targetSpeed, cornerSpeed, brake) {
  return Math.max(0, (targetSpeed ** 2 - cornerSpeed ** 2) / (2 * brake));
}

function getNextCornerIndex(segments, fromIndex) {
  for (let i = fromIndex + 1; i < segments.length; i++) {
    if (segments[i].type === "corner") return i;
  }

  for (let i = 0; i < segments.length; i++) {
    if (segments[i].type === "corner") return i;
  }

  return -1;
}

function getCornerChainLimitSpeed(segments, firstCornerIndex, cornerSpeedMap) {
  let minSpeed = Infinity;
  let i = firstCornerIndex;

  while (i < segments.length && segments[i].type === "corner") {
    minSpeed = Math.min(minSpeed, cornerSpeedMap.get(segments[i].id));
    i += 1;
  }

  return minSpeed;
}

// ── Fuel ─────────────────────────────────────────────────────────────────────
const K_BASE = 0.0005;
const K_DRAG = 0.0000000015;

function fuelUsedSegment(vInitial, vFinal, distance) {
  const avg = (vInitial + vFinal) / 2;
  return (K_BASE + K_DRAG * avg ** 2) * distance;
}

// ── Precompute static corner speeds for Level 2 ─────────────────────────────
const bestSet = pickBestCompound();
const compound = bestSet.compound;
const initialTyreId = bestSet.ids[0];
const tyreFriction = getTyreFriction(compound);

const cornerSpeedMap = new Map();
for (const segment of track.segments) {
  if (segment.type === "corner") {
    cornerSpeedMap.set(
      segment.id,
      safeCornerSpeed(segment.radius_m, tyreFriction)
    );
  }
}

// ── Lap simulation ───────────────────────────────────────────────────────────
function simulateLap(segments, entrySpeed) {
  const outputSegments = [];
  let currentSpeed = entrySpeed;
  let fuelUsed = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (segment.type === "straight") {
      const firstCornerIndex = getNextCornerIndex(segments, i);
      if (firstCornerIndex === -1) {
        throw new Error("Track must contain at least one corner");
      }

      const limitingCornerSpeed = getCornerChainLimitSpeed(
        segments,
        firstCornerIndex,
        cornerSpeedMap
      );

      const targetSpeed = solveMaxPeakSpeed({
        entrySpeed: currentSpeed,
        cornerSpeed: limitingCornerSpeed,
        length: segment.length_m,
        accel: car["accel_m/se2"],
        brake: car["brake_m/se2"],
        maxSpeed: car["max_speed_m/s"],
      });

      const brakingDistance = brakeDistance(
        targetSpeed,
        limitingCornerSpeed,
        car["brake_m/se2"]
      );

      fuelUsed += fuelUsedSegment(currentSpeed, targetSpeed, segment.length_m);

      outputSegments.push({
        id: segment.id,
        type: "straight",
        "target_m/s": round2(targetSpeed),
        brake_start_m_before_next: round2(brakingDistance),
      });

      currentSpeed = limitingCornerSpeed;
    } else {
      fuelUsed += fuelUsedSegment(currentSpeed, currentSpeed, segment.length_m);

      outputSegments.push({
        id: segment.id,
        type: "corner",
      });
    }
  }

  return {
    segments: outputSegments,
    exitSpeed: currentSpeed,
    fuelUsed,
  };
}

// Precompute approximate lap costs for both common entry states
const lapFromZero = simulateLap(track.segments, 0);
const lapFromRolling = simulateLap(track.segments, lapFromZero.exitSpeed);

function getEstimatedLapFuel(entrySpeed) {
  if (entrySpeed < 1) return lapFromZero.fuelUsed;
  return lapFromRolling.fuelUsed;
}

// ── Fuel strategy ────────────────────────────────────────────────────────────
function getTargetRefuelAmount({
  fuelAfterLap,
  currentSpeed,
  lapsLeft,
}) {
  if (lapsLeft <= 0) return 0;

  const estimatedNextLapFuel = getEstimatedLapFuel(currentSpeed);

  // Keep enough for a few laps, but do not blindly top up to full tank.
  const targetReserve = Math.min(
    car["fuel_tank_capacity_l"],
    estimatedNextLapFuel * Math.min(3, lapsLeft)
  );

  const amountNeeded = targetReserve - fuelAfterLap;
  const capacityLeft = car["fuel_tank_capacity_l"] - fuelAfterLap;

  return Math.max(0, Math.min(amountNeeded, capacityLeft));
}

// ── Main race loop ───────────────────────────────────────────────────────────
const laps = [];
let currentSpeed = 0;
let fuelRemaining = car["initial_fuel_l"];

for (let lap = 1; lap <= race.laps; lap++) {
  const lapResult = simulateLap(track.segments, currentSpeed);
  const lapsLeft = race.laps - lap;
  const fuelAfterLap = fuelRemaining - lapResult.fuelUsed;

  let pit = { enter: false };

  if (lapsLeft > 0) {
    const estimatedNextLapFuel = getEstimatedLapFuel(lapResult.exitSpeed);

    // Pit when you can't safely cover the next lap with a small reserve.
    const minimumSafeFuel = estimatedNextLapFuel * 1.15;

    if (fuelAfterLap < minimumSafeFuel) {
      const refuelAmount = round2(
        getTargetRefuelAmount({
          fuelAfterLap,
          currentSpeed: lapResult.exitSpeed,
          lapsLeft,
        })
      );

      if (refuelAmount > 0) {
        pit = {
          enter: true,
          fuel_refuel_amount_l: refuelAmount,
        };

        fuelRemaining = fuelAfterLap + refuelAmount;
        currentSpeed = race["pit_exit_speed_m/s"];
      } else {
        fuelRemaining = fuelAfterLap;
        currentSpeed = lapResult.exitSpeed;
      }
    } else {
      fuelRemaining = fuelAfterLap;
      currentSpeed = lapResult.exitSpeed;
    }
  } else {
    fuelRemaining = fuelAfterLap;
    currentSpeed = lapResult.exitSpeed;
  }

  laps.push({
    lap,
    segments: lapResult.segments,
    pit,
  });
}

writeOutput({
  initial_tyre_id: initialTyreId,
  laps,
});

console.log(`Level 2 optimized. Compound: ${compound} (id=${initialTyreId})`);
