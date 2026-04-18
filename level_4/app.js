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

function round2(v) {
  return Math.round(v * 100) / 100;
}

const data = readFileData("4.txt");
const { car, race, track, available_sets, weather, tyres } = data;
const weatherConditions = weather.conditions;
const tyreProperties = tyres.properties;

// ── Constants ────────────────────────────────────────────────────────────────
const G = 9.8;
const K_STRAIGHT = 0.0000166;
const K_BRAKING = 0.0398;
const K_CORNER = 0.000265;
const K_BASE_FUEL = 0.0005;
const K_DRAG_FUEL = 0.0000000015;

const BASE_FRICTION = {
  Soft: 1.8,
  Medium: 1.7,
  Hard: 1.6,
  Intermediate: 1.2,
  Wet: 1.1,
};

// safer than flirting with 1.0 and blowing up
const PIT_DEGRADATION_THRESHOLD = 0.94;
const CORNER_SAFETY_FACTOR = 0.985;

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

const WEATHER_DEG_KEY = {
  dry: "dry_degradation",
  cold: "cold_degradation",
  light_rain: "light_rain_degradation",
  heavy_rain: "heavy_rain_degradation",
};

// ── Tyre inventory ───────────────────────────────────────────────────────────
const inventory = {};

for (const set of available_sets) {
  for (const id of set.ids) {
    inventory[id] = {
      id,
      compound: set.compound,
      degradation: 0,
      used: false,
    };
  }
}

function unusedTyres() {
  return Object.values(inventory).filter((t) => !t.used);
}

// ── Tyre physics ─────────────────────────────────────────────────────────────
function getTyreFriction(compound, degradation, condition) {
  const props = tyreProperties[compound];
  const baseFriction = BASE_FRICTION[compound];
  const effectiveBase = Math.max(0.05, baseFriction - degradation);
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
  return Math.max(0, (vHigh / 100) ** 2 - (vLow / 100) ** 2) * K_BRAKING * rate;
}

function cornerDeg(compound, condition, speed, radius) {
  return K_CORNER * ((speed ** 2) / radius) * getDegRate(compound, condition);
}

// ── Physics ──────────────────────────────────────────────────────────────────
function safeCornerSpeed(radius, compound, degradation, condition) {
  const friction = getTyreFriction(compound, degradation, condition);
  const speed = Math.sqrt(Math.max(0, friction * G * radius)) + car["crawl_constant_m/s"];
  return speed * CORNER_SAFETY_FACTOR;
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

  let time = 0;

  if (targetSpeed > entrySpeed) {
    time += (targetSpeed - entrySpeed) / accel;
  }

  if (cruiseDist > 0) {
    time += cruiseDist / Math.max(targetSpeed, 1e-4);
  }

  if (targetSpeed > cornerSpeed) {
    time += (targetSpeed - cornerSpeed) / brake;
  }

  return time;
}

function fuelUsed(vInitial, vFinal, distance) {
  const avg = (vInitial + vFinal) / 2;
  return (K_BASE_FUEL + K_DRAG_FUEL * avg ** 2) * distance;
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

function getCornerChainLimitSpeed(segments, firstCornerIndex, tyreState, condition) {
  let minSpeed = Infinity;
  let i = firstCornerIndex;

  while (i < segments.length && segments[i].type === "corner") {
    const s = safeCornerSpeed(
      segments[i].radius_m,
      tyreState.compound,
      tyreState.degradation,
      condition
    );
    minSpeed = Math.min(minSpeed, s);
    i += 1;
  }

  return minSpeed;
}

// ── Weather-aware compound scoring ───────────────────────────────────────────
function bestCompoundForWeather(condition) {
  const key = WEATHER_FRICTION_KEY[condition];
  let bestCompound = null;
  let bestScore = -Infinity;

  for (const set of available_sets) {
    const compound = set.compound;
    const score = BASE_FRICTION[compound] * tyreProperties[compound][key];
    if (score > bestScore) {
      bestScore = score;
      bestCompound = compound;
    }
  }

  return bestCompound;
}

function scoreCompoundForWindow(compound, raceTime) {
  // small lookahead window instead of only "right now"
  const checkpoints = [0, 1200, 2500, 4000];
  let score = 0;

  for (const offset of checkpoints) {
    const weatherNow = getWeatherAtTime(raceTime + offset);
    const friction =
      BASE_FRICTION[compound] *
      tyreProperties[compound][WEATHER_FRICTION_KEY[weatherNow.condition]];
    const degPenalty = tyreProperties[compound][WEATHER_DEG_KEY[weatherNow.condition]] * 0.35;
    score += friction - degPenalty;
  }

  return score;
}

function choosePitTyre(raceTime) {
  const unused = unusedTyres();
  if (unused.length === 0) return null;

  let bestId = null;
  let bestScore = -Infinity;

  for (const tyre of unused) {
    const score = scoreCompoundForWindow(tyre.compound, raceTime);
    if (score > bestScore) {
      bestScore = score;
      bestId = tyre.id;
    }
  }

  return bestId;
}

function chooseInitialTyre() {
  const unused = unusedTyres();
  const preferredCompound = bestCompoundForWeather(getWeatherAtTime(0).condition);

  const exact = unused.find((t) => t.compound === preferredCompound);
  if (exact) return exact.id;

  return unused[0].id;
}

// ── Lap simulation ───────────────────────────────────────────────────────────
function simulateLap({ entrySpeed, tyreId, lapStartTime }) {
  const tyreState = { ...inventory[tyreId] };
  const output = [];
  let currentSpeed = entrySpeed;
  let lapTime = 0;
  let lapFuel = 0;
  let blewOut = false;

  for (let i = 0; i < track.segments.length; i++) {
    const segment = track.segments[i];
    const currentWeather = getWeatherAtTime(lapStartTime + lapTime);

    const effectiveAccel =
      car["accel_m/se2"] * currentWeather.acceleration_multiplier;
    const effectiveBrake =
      car["brake_m/se2"] * currentWeather.deceleration_multiplier;

    if (segment.type === "straight") {
      const firstCornerIndex = getNextCornerIndex(track.segments, i);
      const limitingCornerSpeed = getCornerChainLimitSpeed(
        track.segments,
        firstCornerIndex,
        tyreState,
        currentWeather.condition
      );

      const targetSpeed = solveMaxPeakSpeed({
        entrySpeed: currentSpeed,
        cornerSpeed: limitingCornerSpeed,
        length: segment.length_m,
        accel: effectiveAccel,
        brake: effectiveBrake,
        maxSpeed: car["max_speed_m/s"],
      });

      const brakingDistance = brakeDistance(
        targetSpeed,
        limitingCornerSpeed,
        effectiveBrake
      );

      const dt = segmentTime({
        entrySpeed: currentSpeed,
        targetSpeed,
        cornerSpeed: limitingCornerSpeed,
        length: segment.length_m,
        accel: effectiveAccel,
        brake: effectiveBrake,
      });

      lapTime += dt;
      lapFuel += fuelUsed(currentSpeed, targetSpeed, segment.length_m);

      tyreState.degradation += straightDeg(
        tyreState.compound,
        currentWeather.condition,
        segment.length_m
      );

      tyreState.degradation += brakingDeg(
        tyreState.compound,
        currentWeather.condition,
        targetSpeed,
        limitingCornerSpeed
      );

      if (tyreState.degradation >= 1) {
        blewOut = true;
      }

      output.push({
        id: segment.id,
        type: "straight",
        "target_m/s": round2(targetSpeed),
        brake_start_m_before_next: round2(brakingDistance),
      });

      currentSpeed = limitingCornerSpeed;
    } else {
      const cornerTime = segment.length_m / Math.max(currentSpeed, 1e-4);
      lapTime += cornerTime;
      lapFuel += fuelUsed(currentSpeed, currentSpeed, segment.length_m);

      tyreState.degradation += cornerDeg(
        tyreState.compound,
        currentWeather.condition,
        currentSpeed,
        segment.radius_m
      );

      if (tyreState.degradation >= 1) {
        blewOut = true;
      }

      output.push({
        id: segment.id,
        type: "corner",
      });
    }
  }

  return {
    segments: output,
    exitSpeed: currentSpeed,
    lapTime,
    lapFuel,
    tyreAfterLap: tyreState,
    blewOut,
  };
}

// ── Pit logic ────────────────────────────────────────────────────────────────
function getRefuelAmount({
  fuelAfterLap,
  estimatedFuelPerLap,
  lapsLeft,
}) {
  if (lapsLeft <= 0) return 0;

  // keep a short reserve, not full-tank spam
  const lapsToCover = Math.min(3, lapsLeft);
  const targetFuel = Math.min(
    car["fuel_tank_capacity_l"],
    fuelAfterLap + estimatedFuelPerLap * lapsToCover * 1.05
  );

  const maxCanAdd = car["fuel_tank_capacity_l"] - fuelAfterLap;
  return Math.max(0, Math.min(targetFuel - fuelAfterLap, maxCanAdd));
}

// ── Race ─────────────────────────────────────────────────────────────────────
const initialTyreId = chooseInitialTyre();
inventory[initialTyreId].used = true;

const laps = [];
let raceTime = 0;
let currentSpeed = 0;
let fuelRemaining = car["initial_fuel_l"];
let currentTyreId = initialTyreId;

for (let lap = 1; lap <= race.laps; lap++) {
  const lapResult = simulateLap({
    entrySpeed: currentSpeed,
    tyreId: currentTyreId,
    lapStartTime: raceTime,
  });

  inventory[currentTyreId].degradation = lapResult.tyreAfterLap.degradation;

  const lapsLeft = race.laps - lap;
  const fuelAfterLap = fuelRemaining - lapResult.lapFuel;
  const currentCompound = inventory[currentTyreId].compound;

  const weatherNext = getWeatherAtTime(raceTime + lapResult.lapTime);
  const idealNextCompound = bestCompoundForWeather(weatherNext.condition);

  const needTyreForDegradation =
    lapResult.tyreAfterLap.degradation >= PIT_DEGRADATION_THRESHOLD ||
    lapResult.blewOut;

  const needTyreForWeather =
    lapsLeft > 0 &&
    idealNextCompound !== currentCompound &&
    unusedTyres().some((t) => t.compound === idealNextCompound);

  const estimatedFuelPerLap = lapResult.lapFuel;
  const minimumSafeFuel = estimatedFuelPerLap * 1.15;
  const needFuel = lapsLeft > 0 && fuelAfterLap < minimumSafeFuel;

  const needPit =
    lapsLeft > 0 && (needTyreForDegradation || needTyreForWeather || needFuel);

  let pit = { enter: false };

  if (needPit) {
    pit.enter = true;

    const newTyreId = choosePitTyre(raceTime + lapResult.lapTime);
    if (newTyreId && newTyreId !== currentTyreId) {
      inventory[newTyreId].used = true;
      pit.tyre_change_set_id = newTyreId;
    }

    const refuelAmount = round2(
      getRefuelAmount({
        fuelAfterLap,
        estimatedFuelPerLap,
        lapsLeft,
      })
    );

    if (refuelAmount > 0) {
      pit.fuel_refuel_amount_l = refuelAmount;
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
      currentTyreId = pit.tyre_change_set_id;
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

console.log(
  `Level 4 optimized. Initial tyre: ${initialTyreId} (${inventory[initialTyreId].compound})`
);
