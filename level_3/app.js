import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- FILE IO ----------------
function readFileData() {
  const filePath = path.join(__dirname, "3.txt");
  const data = fs.readFileSync(filePath, "utf8");
  return JSON.parse(data);
}

function writeOutput(data) {
  const filePath = path.join(__dirname, "output.txt");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ---------------- LOAD DATA ----------------
const data = readFileData();

const car = data.car;
const race = data.race;
const track = data.track;
const availableSets = data.available_sets;
const weatherConditions = data.weather.conditions;
const tyreProperties = data.tyres.properties;

function round(value) {
  return Number(value.toFixed(2));
}

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

function getWeatherMultiplierKey(condition) {
  const map = {
    dry: "dry_friction_multiplier",
    cold: "cold_friction_multiplier",
    light_rain: "light_rain_friction_multiplier",
    heavy_rain: "heavy_rain_friction_multiplier",
  };

  return map[condition];
}

function getRecommendedCompound(condition) {
  if (condition === "heavy_rain") return "Wet";
  if (condition === "light_rain") return "Intermediate";
  if (condition === "cold") return "Medium";
  return "Medium";
}

// ---------------- TYRES ----------------
function getInitialTyreId(compound) {
  const set = availableSets.find((item) => item.compound === compound);
  if (!set) {
    throw new Error(`No tyre set found for compound: ${compound}`);
  }
  return set.ids[0];
}

function getTyreIdForCompound(compound) {
  const set = availableSets.find((item) => item.compound === compound);
  if (!set) {
    throw new Error(`No tyre set found for compound: ${compound}`);
  }
  return set.ids[0];
}

function getTyreFriction(compound, weatherCondition) {
  const tyre = tyreProperties[compound];
  const multiplierKey = getWeatherMultiplierKey(weatherCondition);
  if (!multiplierKey) {
    throw new Error(`Unsupported weather condition: ${weatherCondition}`);
  }

  // Level 3: weather matters, but tyre degradation is not yet the main focus.
  // Using life_span * friction multiplier as the working friction model.
  return tyre.life_span * tyre[multiplierKey];
}

// ---------------- PHYSICS ----------------
function getSafeCornerSpeed(radius, compound, weatherCondition) {
  const friction = getTyreFriction(compound, weatherCondition);
  const g = 9.8;
  return Math.sqrt(friction * g * radius) + car["crawl_constant_m/s"];
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

function getNextCornerIndex(segments, startIndex) {
  for (let i = startIndex + 1; i < segments.length; i++) {
    if (segments[i].type === "corner") return i;
  }

  for (let i = 0; i < segments.length; i++) {
    if (segments[i].type === "corner") return i;
  }

  return -1;
}

// ---------------- FUEL ----------------
function getFuelUsed(initialSpeed, finalSpeed, distance) {
  const Kbase = 0.0005;
  const Kdrag = 0.0000000015;
  const avgSpeed = (initialSpeed + finalSpeed) / 2;

  return (Kbase + Kdrag * avgSpeed ** 2) * distance;
}

// ---------------- TIME ----------------
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

// ---------------- LAP GENERATION ----------------
function generateLapSegments({
  segments,
  entrySpeed,
  tyreCompound,
  lapStartTime,
}) {
  const output = [];
  let currentSpeed = entrySpeed;
  let lapTime = 0;
  let fuelUsedLap = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const currentWeather = getWeatherAtTime(lapStartTime + lapTime);

    const effectiveAccel =
      car["accel_m/se2"] * currentWeather.acceleration_multiplier;

    const effectiveBrake =
      car["brake_m/se2"] * currentWeather.deceleration_multiplier;

    if (seg.type === "straight") {
      const nextCornerIndex = getNextCornerIndex(segments, i);
      if (nextCornerIndex === -1) {
        throw new Error("Track must contain at least one corner");
      }

      const nextCorner = segments[nextCornerIndex];

      const safeCornerSpeed = getSafeCornerSpeed(
        nextCorner.radius_m,
        tyreCompound,
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

      const fuelUsed = getFuelUsed(currentSpeed, targetSpeed, seg.length_m);

      lapTime += straightTime;
      fuelUsedLap += fuelUsed;

      output.push({
        id: seg.id,
        type: "straight",
        "target_m/s": round(targetSpeed),
        brake_start_m_before_next: round(brakeDistance),
      });

      currentSpeed = safeCornerSpeed;
    } else {
      const cornerTime = seg.length_m / Math.max(currentSpeed, 0.0001);
      const fuelUsed = getFuelUsed(currentSpeed, currentSpeed, seg.length_m);

      lapTime += cornerTime;
      fuelUsedLap += fuelUsed;

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
  };
}

// ---------------- PIT STRATEGY ----------------
function shouldChangeTyres(currentCompound, weatherNow, weatherNextLapStart) {
  const idealNow = getRecommendedCompound(weatherNow.condition);
  const idealNext = getRecommendedCompound(weatherNextLapStart.condition);

  if (currentCompound !== idealNow) {
    return idealNow;
  }

  if (currentCompound !== idealNext) {
    return idealNext;
  }

  return null;
}

function getRefuelAmount(currentFuel, targetFuel) {
  const capacityLeft = car["fuel_tank_capacity_l"] - currentFuel;
  return Math.max(0, Math.min(targetFuel - currentFuel, capacityLeft));
}

// ---------------- RACE ----------------
function generateAllLaps() {
  const laps = [];

  let raceTime = 0;
  let currentSpeed = 0;
  let currentFuel = car["initial_fuel_l"];

  let currentCompound = getRecommendedCompound(
    getWeatherAtTime(0).condition
  );

  const initialTyreId = getInitialTyreId(currentCompound);

  for (let lap = 1; lap <= race.laps; lap++) {
    const lapResult = generateLapSegments({
      segments: track.segments,
      entrySpeed: currentSpeed,
      tyreCompound: currentCompound,
      lapStartTime: raceTime,
    });

    const weatherNow = getWeatherAtTime(raceTime);
    const weatherNextLapStart = getWeatherAtTime(raceTime + lapResult.lapTime);

    const fuelAfterLap = currentFuel - lapResult.fuelUsedLap;

    let pit = { enter: false };
    let nextCompound = currentCompound;

    const tyreChangeCompound = shouldChangeTyres(
      currentCompound,
      weatherNow,
      weatherNextLapStart
    );

    let fuelRefuelAmount = 0;

    // Basic fuel strategy:
    // If fuel after this lap is less than roughly 1.2x this lap's fuel usage, top up.
    if (fuelAfterLap < lapResult.fuelUsedLap * 1.2) {
      fuelRefuelAmount = getRefuelAmount(fuelAfterLap, 120);
    }

    if (tyreChangeCompound || fuelRefuelAmount > 0) {
      pit.enter = true;

      if (tyreChangeCompound) {
        pit.tyre_change_set_id = getTyreIdForCompound(tyreChangeCompound);
        nextCompound = tyreChangeCompound;
      }

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

      currentCompound = nextCompound;
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
const output = generateAllLaps();
writeOutput(output);

console.log("Generated output.txt successfully");
