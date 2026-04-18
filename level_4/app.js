import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- FILE IO ----------------
function readFileData() {
  const filePath = path.join(__dirname, "4.txt");
  const data = fs.readFileSync(filePath, "utf8");
  return JSON.parse(data);
}

function writeOutput(data) {
  const filePath = path.join(__dirname, "output.txt");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function round(value) {
  return Number(value.toFixed(2));
}

// ---------------- LOAD DATA ----------------
const data = readFileData();

const car = data.car;
const race = data.race;
const track = data.track;
const tyreProperties = data.tyres.properties;
const availableSets = data.available_sets;
const weatherConditions = data.weather.conditions;

// ---------------- CONSTANTS ----------------
// Level 4 degradation constants from problem statement
const K_STRAIGHT = 0.0000166;
const K_BRAKING = 0.0398;
const K_CORNER = 0.000265;
const G = 9.8;

// Base friction coefficients from problem statement table
const BASE_FRICTION = {
  Soft: 1.8,
  Medium: 1.7,
  Hard: 1.6,
  Intermediate: 1.2,
  Wet: 1.1,
};

// Safety buffers so we do not drive right at the theoretical limit
const CORNER_SPEED_SAFETY_FACTOR = 0.97;
const MAX_ALLOWED_DEGRADATION_BEFORE_PIT = 0.92;

// ---------------- WEATHER ----------------
function getWeatherCycleDuration() {
  return weatherConditions.reduce((sum, weather) => sum + weather.duration_s, 0);
}

function getWeatherAtTime(timeSeconds) {
  const cycleDuration = getWeatherCycleDuration();
  const timeInCycle = timeSeconds % cycleDuration;

  let elapsed = 0;
  for (const weather of weatherConditions) {
    elapsed += weather.duration_s;
    if (timeInCycle < elapsed) {
      return weather;
    }
  }

  return weatherConditions[weatherConditions.length - 1];
}

function getFrictionMultiplierKey(condition) {
  const map = {
    dry: "dry_friction_multiplier",
    cold: "cold_friction_multiplier",
    light_rain: "light_rain_friction_multiplier",
    heavy_rain: "heavy_rain_friction_multiplier",
  };
  return map[condition];
}

function getDegradationRateKey(condition) {
  const map = {
    dry: "dry_degradation",
    cold: "cold_degradation",
    light_rain: "light_rain_degradation",
    heavy_rain: "heavy_rain_degradation",
  };
  return map[condition];
}

function getRecommendedCompound(condition) {
  if (condition === "heavy_rain") return "Wet";
  if (condition === "light_rain") return "Intermediate";
  if (condition === "cold") return "Medium";
  return "Soft";
}

// ---------------- TYRE SETS ----------------
function buildTyreInventory() {
  const inventory = {};

  for (const set of availableSets) {
    for (const id of set.ids) {
      inventory[id] = {
        id,
        compound: set.compound,
        degradation: 0,
        used: false,
      };
    }
  }

  return inventory;
}

function getTyreFriction(compound, degradation, weatherCondition) {
  const props = tyreProperties[compound];
  const frictionMultiplierKey = getFrictionMultiplierKey(weatherCondition);

  const base = BASE_FRICTION[compound];
  const effectiveBase = Math.max(0.05, base - degradation);
  return effectiveBase * props[frictionMultiplierKey];
}

function getTyreDegradationRate(compound, weatherCondition) {
  const props = tyreProperties[compound];
  const degradationKey = getDegradationRateKey(weatherCondition);
  return props[degradationKey];
}

function getRemainingTyreLife(tyreState) {
  return Math.max(0, 1 - tyreState.degradation);
}

function chooseInitialTyreId(inventory) {
  const startingWeather = getWeatherAtTime(0);
  const preferredCompound = getRecommendedCompound(startingWeather.condition);

  const preferred = Object.values(inventory).find(
    (t) => !t.used && t.compound === preferredCompound
  );
  if (preferred) return preferred.id;

  const fallback = Object.values(inventory).find((t) => !t.used);
  if (!fallback) {
    throw new Error("No tyre sets available");
  }

  return fallback.id;
}

function chooseBestPitTyre(inventory, raceTime, lapsRemaining) {
  const weatherNow = getWeatherAtTime(raceTime);
  const weatherSoon = getWeatherAtTime(raceTime + 1800);

  const preferredNow = getRecommendedCompound(weatherNow.condition);
  const preferredSoon = getRecommendedCompound(weatherSoon.condition);

  const unusedTyres = Object.values(inventory).filter((t) => !t.used);

  const exactNow = unusedTyres.find((t) => t.compound === preferredNow);
  if (exactNow) return exactNow.id;

  const exactSoon = unusedTyres.find((t) => t.compound === preferredSoon);
  if (exactSoon) return exactSoon.id;

  const medium = unusedTyres.find((t) => t.compound === "Medium");
  if (medium) return medium.id;

  const hard = unusedTyres.find((t) => t.compound === "Hard");
  if (hard) return hard.id;

  if (unusedTyres.length > 0) return unusedTyres[0].id;

  return null;
}

// ---------------- PHYSICS ----------------
function getSafeCornerSpeed(radius, tyreState, weatherCondition) {
  const friction = getTyreFriction(
    tyreState.compound,
    tyreState.degradation,
    weatherCondition
  );

  const theoretical = Math.sqrt(friction * G * radius) + car["crawl_constant_m/s"];
  return theoretical * CORNER_SPEED_SAFETY_FACTOR;
}

function solveTargetSpeed({
  entrySpeed,
  cornerSpeed,
  straightLength,
  accel,
  brake,
  maxSpeed,
}) {
  const numerator =
    straightLength +
    entrySpeed ** 2 / (2 * accel) +
    cornerSpeed ** 2 / (2 * brake);

  const denominator = 1 / (2 * accel) + 1 / (2 * brake);
  const solved = Math.sqrt(Math.max(0, numerator / denominator));

  return Math.min(solved, maxSpeed);
}

function getBrakeDistance(targetSpeed, cornerSpeed, brake) {
  return Math.max(0, (targetSpeed ** 2 - cornerSpeed ** 2) / (2 * brake));
}

function getStraightTime({
  entrySpeed,
  targetSpeed,
  cornerSpeed,
  straightLength,
  accel,
  brake,
}) {
  const accelDistance = Math.max(
    0,
    (targetSpeed ** 2 - entrySpeed ** 2) / (2 * accel)
  );

  const brakeDistance = Math.max(
    0,
    (targetSpeed ** 2 - cornerSpeed ** 2) / (2 * brake)
  );

  const cruiseDistance = Math.max(0, straightLength - accelDistance - brakeDistance);

  let time = 0;

  if (targetSpeed > entrySpeed) {
    time += (targetSpeed - entrySpeed) / accel;
  }

  if (cruiseDistance > 0) {
    time += cruiseDistance / Math.max(targetSpeed, 0.0001);
  }

  if (targetSpeed > cornerSpeed) {
    time += (targetSpeed - cornerSpeed) / brake;
  }

  return time;
}

function getFuelUsed(initialSpeed, finalSpeed, distance) {
  const Kbase = 0.0005;
  const Kdrag = 0.0000000015;
  const avgSpeed = (initialSpeed + finalSpeed) / 2;
  return (Kbase + Kdrag * avgSpeed ** 2) * distance;
}

function getNextCornerIndex(segments, startIndex) {
  for (let i = startIndex + 1; i < segments.length; i++) {
    if (segments[i].type === "corner") return i;
  }

  for (let i = 0; i < segments.length; i++) {
    if (segments[i].type === "corner") return i;
  }

  return -1;
}

// ---------------- TYRE DEGRADATION ----------------
function getStraightDegradation(compound, weatherCondition, length) {
  const rate = getTyreDegradationRate(compound, weatherCondition);
  return rate * length * K_STRAIGHT;
}

function getBrakingDegradation(compound, weatherCondition, initialSpeed, finalSpeed) {
  const rate = getTyreDegradationRate(compound, weatherCondition);
  const value =
    (initialSpeed / 100) ** 2 - (finalSpeed / 100) ** 2;

  return Math.max(0, value) * K_BRAKING * rate;
}

function getCornerDegradation(compound, weatherCondition, speed, radius) {
  const rate = getTyreDegradationRate(compound, weatherCondition);
  return K_CORNER * ((speed ** 2) / radius) * rate;
}

// ---------------- SIMULATION ----------------
function cloneTyreState(tyreState) {
  return {
    id: tyreState.id,
    compound: tyreState.compound,
    degradation: tyreState.degradation,
    used: tyreState.used,
  };
}

function simulateLap({
  entrySpeed,
  tyreState,
  lapStartTime,
}) {
  const output = [];
  let currentSpeed = entrySpeed;
  let lapTime = 0;
  let fuelUsedLap = 0;
  let workingTyre = cloneTyreState(tyreState);
  let blewOut = false;

  for (let i = 0; i < track.segments.length; i++) {
    const seg = track.segments[i];
    const currentWeather = getWeatherAtTime(lapStartTime + lapTime);

    const effectiveAccel =
      car["accel_m/se2"] * currentWeather.acceleration_multiplier;
    const effectiveBrake =
      car["brake_m/se2"] * currentWeather.deceleration_multiplier;

    if (seg.type === "straight") {
      const nextCornerIndex = getNextCornerIndex(track.segments, i);
      if (nextCornerIndex === -1) {
        throw new Error("Track must contain at least one corner");
      }

      const nextCorner = track.segments[nextCornerIndex];
      const safeCornerSpeed = getSafeCornerSpeed(
        nextCorner.radius_m,
        workingTyre,
        currentWeather.condition
      );

      const targetSpeed = solveTargetSpeed({
        entrySpeed: currentSpeed,
        cornerSpeed: safeCornerSpeed,
        straightLength: seg.length_m,
        accel: effectiveAccel,
        brake: effectiveBrake,
        maxSpeed: car["max_speed_m/s"],
      });

      const brakeDistance = getBrakeDistance(
        targetSpeed,
        safeCornerSpeed,
        effectiveBrake
      );

      const straightTime = getStraightTime({
        entrySpeed: currentSpeed,
        targetSpeed,
        cornerSpeed: safeCornerSpeed,
        straightLength: seg.length_m,
        accel: effectiveAccel,
        brake: effectiveBrake,
      });

      fuelUsedLap += getFuelUsed(currentSpeed, targetSpeed, seg.length_m);
      lapTime += straightTime;

      const straightDeg = getStraightDegradation(
        workingTyre.compound,
        currentWeather.condition,
        seg.length_m
      );

      const brakingDeg = getBrakingDegradation(
        workingTyre.compound,
        currentWeather.condition,
        targetSpeed,
        safeCornerSpeed
      );

      workingTyre.degradation += straightDeg + brakingDeg;

      if (workingTyre.degradation >= 1) {
        blewOut = true;
      }

      output.push({
        id: seg.id,
        type: "straight",
        "target_m/s": round(targetSpeed),
        brake_start_m_before_next: round(brakeDistance),
      });

      currentSpeed = safeCornerSpeed;
    } else {
      const currentWeatherForCorner = getWeatherAtTime(lapStartTime + lapTime);

      const cornerTime = seg.length_m / Math.max(currentSpeed, 0.0001);
      lapTime += cornerTime;
      fuelUsedLap += getFuelUsed(currentSpeed, currentSpeed, seg.length_m);

      const cornerDeg = getCornerDegradation(
        workingTyre.compound,
        currentWeatherForCorner.condition,
        currentSpeed,
        seg.radius_m
      );

      workingTyre.degradation += cornerDeg;

      if (workingTyre.degradation >= 1) {
        blewOut = true;
      }

      output.push({
        id: seg.id,
        type: "corner",
      });
    }
  }

  return {
    segments: output,
    exitSpeed: currentSpeed,
    lapTime,
    fuelUsedLap,
    tyreAfterLap: workingTyre,
    blewOut,
  };
}

// ---------------- PIT STRATEGY ----------------
function shouldPit({
  currentFuel,
  lapFuelEstimate,
  currentTyreState,
  tyreAfterLap,
  raceTime,
  lapTime,
  lapsRemaining,
  inventory,
}) {
  const weatherNow = getWeatherAtTime(raceTime);
  const weatherNext = getWeatherAtTime(raceTime + lapTime);

  const preferredNow = getRecommendedCompound(weatherNow.condition);
  const preferredNext = getRecommendedCompound(weatherNext.condition);

  const tyreNeedsChange =
    tyreAfterLap.degradation >= MAX_ALLOWED_DEGRADATION_BEFORE_PIT ||
    currentTyreState.compound !== preferredNow ||
    currentTyreState.compound !== preferredNext ||
    tyreAfterLap.blewOut === true;

  const fuelAfterLap = currentFuel - lapFuelEstimate;
  const lowFuel = fuelAfterLap < lapFuelEstimate * 1.3;

  return tyreNeedsChange || lowFuel;
}

function getRefuelAmount(currentFuel, targetFuel) {
  const capacityLeft = car["fuel_tank_capacity_l"] - currentFuel;
  return Math.max(0, Math.min(targetFuel - currentFuel, capacityLeft));
}

// ---------------- RACE ----------------
function generateRacePlan() {
  const inventory = buildTyreInventory();

  const initialTyreId = chooseInitialTyreId(inventory);
  inventory[initialTyreId].used = true;

  const laps = [];

  let currentSpeed = 0;
  let currentFuel = car["initial_fuel_l"];
  let raceTime = 0;
  let currentTyreId = initialTyreId;

  for (let lap = 1; lap <= race.laps; lap++) {
    const currentTyreState = inventory[currentTyreId];

    const lapResult = simulateLap({
      entrySpeed: currentSpeed,
      tyreState: currentTyreState,
      lapStartTime: raceTime,
    });

    // Tentatively apply tyre degradation from this lap
    inventory[currentTyreId].degradation = lapResult.tyreAfterLap.degradation;

    let pit = { enter: false };
    const lapsRemaining = race.laps - lap;

    const needPit =
      lapResult.blewOut ||
      shouldPit({
        currentFuel,
        lapFuelEstimate: lapResult.fuelUsedLap,
        currentTyreState,
        tyreAfterLap: lapResult.tyreAfterLap,
        raceTime,
        lapTime: lapResult.lapTime,
        lapsRemaining,
        inventory,
      });

    const fuelAfterLap = currentFuel - lapResult.fuelUsedLap;

    if (needPit && lap < race.laps) {
      pit.enter = true;

      const nextTyreId = chooseBestPitTyre(inventory, raceTime + lapResult.lapTime, lapsRemaining);

      if (nextTyreId && nextTyreId !== currentTyreId) {
        inventory[nextTyreId].used = true;
        pit.tyre_change_set_id = nextTyreId;
      }

      const desiredFuelAfterPit = Math.min(135, car["fuel_tank_capacity_l"]);
      const fuelRefuelAmount = getRefuelAmount(fuelAfterLap, desiredFuelAfterPit);

      if (fuelRefuelAmount > 0) {
        pit.fuel_refuel_amount_l = round(fuelRefuelAmount);
      }
    }

    laps.push({
      lap,
      segments: lapResult.segments,
      pit,
    });

    currentFuel = fuelAfterLap;
    raceTime += lapResult.lapTime;

    if (pit.enter) {
      const pitBase = race["base_pit_stop_time_s"];
      const tyreSwapTime = pit.tyre_change_set_id
        ? race["pit_tyre_swap_time_s"]
        : 0;
      const refuelTime = pit.fuel_refuel_amount_l
        ? pit.fuel_refuel_amount_l / race["pit_refuel_rate_l/s"]
        : 0;

      raceTime += pitBase + tyreSwapTime + refuelTime;

      if (pit.fuel_refuel_amount_l) {
        currentFuel += pit.fuel_refuel_amount_l;
      }

      if (pit.tyre_change_set_id) {
        currentTyreId = pit.tyre_change_set_id;
      }

      currentSpeed = race["pit_exit_speed_m/s"];
    } else {
      currentSpeed = lapResult.exitSpeed;
    }
  }

  return {
    initial_tyre_id: initialTyreId,
    laps,
  };
}

// ---------------- OUTPUT ----------------
const output = generateRacePlan();
writeOutput(output);

console.log("Generated Level 4 output.txt successfully");
