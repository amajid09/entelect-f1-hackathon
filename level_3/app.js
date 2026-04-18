import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readFileData(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
}

function writeOutput(data) {
  fs.writeFileSync(
    path.join(__dirname, "output.txt"),
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

const data = readFileData("3.txt");
const { car, race, track, available_sets, weather, tyres } = data;
const weatherConditions = weather.conditions;
const tyreProperties = tyres.properties;

function round2(v) {
  return Math.round(v * 100) / 100;
}

// ── Weather cycling ──────────────────────────────────────────────────────────
const CYCLE_DURATION = weatherConditions.reduce((sum, w) => sum + w.duration_s, 0);

function getWeatherAtTime(timeSeconds) {
  const timeInCycle = timeSeconds % CYCLE_DURATION;
  let elapsed = 0;

  for (const w of weatherConditions) {
    elapsed += w.duration_s;
    if (timeInCycle < elapsed) return w;
  }

  return weatherConditions[weatherConditions.length - 1];
}

const WEATHER_FRICTION_KEY = {
  dry: "dry_friction_multiplier",
  cold: "cold_friction_multiplier",
  light_rain: "light_rain_friction_multiplier",
  heavy_rain: "heavy_rain_friction_multiplier",
};

// ── Tyre selection ───────────────────────────────────────────────────────────
function compoundScoreForWeather(compound, condition) {
  const key = WEATHER_FRICTION_KEY[condition];
  const props = tyreProperties[compound];
  return props.life_span * props[key];
}

function bestCompoundForWeather(condition) {
  let bestCompound = null;
  let bestScore = -Infinity;

  for (const set of available_sets) {
    const score = compoundScoreForWeather(set.compound, condition);
    if (score > bestScore) {
      bestScore = score;
      bestCompound = set.compound;
    }
  }

  return bestCompound;
}

function getTyreIdForCompound(compound) {
  const set = available_sets.find((item) => item.compound === compound);
  if (!set) {
    throw new Error(`No tyre set found for compound: ${compound}`);
  }
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

  return Math.min(Math.sqrt(Math.max(0, numerator / denominator)), maxSpeed);
}

function brakeDistance(targetSpeed, cornerSpeed, brake) {
  return Math.max(0, (targetSpeed ** 2 - cornerSpeed ** 2) / (2 * brake));
}

function segmentTime({
  entrySpeed,
  targetSpeed,
  cornerSpeed,
  length,
  accel,
  brake,
}) {
  const accelDist = Math.max(
    0,
    (targetSpeed ** 2 - entrySpeed ** 2) / (2 * accel)
  );

  const brakeDist = Math.max(
    0,
    (targetSpeed ** 2 - cornerSpeed ** 2) / (2 * brake)
  );

  const cruiseDist = Math.max(0, length - accelDist - brakeDist);

  let t = 0;

  if (targetSpeed > entrySpeed) {
    t += (targetSpeed - entrySpeed) / accel;
  }

  if (cruiseDist > 0) {
    t += cruiseDist / Math.max(targetSpeed, 1e-4);
  }

  if (targetSpeed > cornerSpeed) {
    t += (targetSpeed - cornerSpeed) / brake;
  }

  return t;
}

function fuelUsed(vInitial, vFinal, distance) {
  const avg = (vInitial + vFinal) / 2;
  return (K_BASE + K_DRAG * avg ** 2) * distance;
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

function buildCornerSpeedMapForWeather(condition, compound) {
  const map = new Map();

  for (const segment of track.segments) {
    if (segment.type === "corner") {
      map.set(segment.id, safeCornerSpeed(segment.radius_m, compound, condition));
    }
  }

  return map;
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

// ── Lap simulation ───────────────────────────────────────────────────────────
function simulateLap({ segments, entrySpeed, compound, lapStartTime }) {
  const output = [];
  let speed = entrySpeed;
  let lapTime = 0;
  let lapFuel = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const currentWeather = getWeatherAtTime(lapStartTime + lapTime);
    const effAccel = car["accel_m/se2"] * currentWeather.acceleration_multiplier;
    const effBrake = car["brake_m/se2"] * currentWeather.deceleration_multiplier;

    if (segment.type === "straight") {
      const firstCornerIndex = getNextCornerIndex(segments, i);
      if (firstCornerIndex === -1) {
        throw new Error("Track must contain at least one corner");
      }

      const cornerSpeedMap = buildCornerSpeedMapForWeather(
        currentWeather.condition,
        compound
      );

      const limitingCornerSpeed = getCornerChainLimitSpeed(
        segments,
        firstCornerIndex,
        cornerSpeedMap
      );

      const targetSpeed = solveMaxPeakSpeed({
        entrySpeed: speed,
        cornerSpeed: limitingCornerSpeed,
        length: segment.length_m,
        accel: effAccel,
        brake: effBrake,
        maxSpeed: car["max_speed_m/s"],
      });

      const brakingDistance = brakeDistance(
        targetSpeed,
        limitingCornerSpeed,
        effBrake
      );

      const dt = segmentTime({
        entrySpeed: speed,
        targetSpeed,
        cornerSpeed: limitingCornerSpeed,
        length: segment.length_m,
        accel: effAccel,
        brake: effBrake,
      });

      lapTime += dt;
      lapFuel += fuelUsed(speed, targetSpeed, segment.length_m);

      output.push({
        id: segment.id,
        type: "straight",
        "target_m/s": round2(targetSpeed),
        brake_start_m_before_next: round2(brakingDistance),
      });

      speed = limitingCornerSpeed;
    } else {
      const cornerTime = segment.length_m / Math.max(speed, 1e-4);
      lapTime += cornerTime;
      lapFuel += fuelUsed(speed, speed, segment.length_m);

      output.push({
        id: segment.id,
        type: "corner",
      });
    }
  }

  return {
    segments: output,
    exitSpeed: speed,
    lapTime,
    lapFuel,
  };
}

// ── Pit heuristics ───────────────────────────────────────────────────────────
function getTargetFuelReserve(nextLapFuelEstimate, lapsLeft) {
  if (lapsLeft <= 0) return 0;

  const lapsToCover = Math.min(3, lapsLeft);
  return Math.min(
    car["fuel_tank_capacity_l"],
    nextLapFuelEstimate * lapsToCover * 1.1
  );
}

function getRefuelAmount(fuelAfterLap, targetReserve) {
  const maxCanAdd = car["fuel_tank_capacity_l"] - fuelAfterLap;
  return Math.max(0, Math.min(targetReserve - fuelAfterLap, maxCanAdd));
}

function shouldPitForTyres(currentCompound, nextWeatherCondition) {
  const idealNext = bestCompoundForWeather(nextWeatherCondition);
  return idealNext !== currentCompound;
}

// ── Race ─────────────────────────────────────────────────────────────────────
const startWeather = getWeatherAtTime(0);
let currentCompound = bestCompoundForWeather(startWeather.condition);
const initialTyreId = getTyreIdForCompound(currentCompound);

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

  const nextLapWeather = getWeatherAtTime(raceTime + lapResult.lapTime);
  const nextLapCompound = bestCompoundForWeather(nextLapWeather.condition);

  let pit = { enter: false };

  if (lapsLeft > 0) {
    const nextLapEstimate = simulateLap({
      segments: track.segments,
      entrySpeed: lapResult.exitSpeed,
      compound: currentCompound,
      lapStartTime: raceTime + lapResult.lapTime,
    });

    const minimumSafeFuel = nextLapEstimate.lapFuel * 1.15;
    const needFuel = fuelAfterLap < minimumSafeFuel;
    const needTyreChange = shouldPitForTyres(
      currentCompound,
      nextLapWeather.condition
    );

    if (needFuel || needTyreChange) {
      pit.enter = true;

      if (needTyreChange) {
        pit.tyre_change_set_id = getTyreIdForCompound(nextLapCompound);
      }

      const targetReserve = getTargetFuelReserve(nextLapEstimate.lapFuel, lapsLeft);
      const refuelAmount = round2(getRefuelAmount(fuelAfterLap, targetReserve));

      if (refuelAmount > 0) {
        pit.fuel_refuel_amount_l = refuelAmount;
      }
    }
  }

  laps.push({
    lap,
    segments: lapResult.segments,
    pit,
  });

  fuelRemaining = fuelAfterLap;
  raceTime += lapResult.lapTime;

  if (pit.enter) {
    const pitBase = race["base_pit_stop_time_s"];
    const swapTime = pit.tyre_change_set_id
      ? race["pit_tyre_swap_time_s"]
      : 0;
    const refuelTime = pit.fuel_refuel_amount_l
      ? pit.fuel_refuel_amount_l / race["pit_refuel_rate_l/s"]
      : 0;

    raceTime += pitBase + swapTime + refuelTime;

    if (pit.fuel_refuel_amount_l) {
      fuelRemaining += pit.fuel_refuel_amount_l;
    }

    if (pit.tyre_change_set_id) {
      currentCompound = nextLapCompound;
    }

    currentSpeed = race["pit_exit_speed_m/s"];
  } else {
    currentSpeed = lapResult.exitSpeed;
  }
}

writeOutput({
  initial_tyre_id: initialTyreId,
  laps,
});

console.log(`Level 3 fixed. Initial compound: ${currentCompound}`);
