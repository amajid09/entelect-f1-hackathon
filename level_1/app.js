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

const data = readFileData("1.txt");
const { car, race, track, available_sets, weather, tyres } = data;
const weatherConditions = weather.conditions;
const tyreProperties = tyres.properties;

function round2(v) {
  return Math.round(v * 100) / 100;
}

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

function pickBestCompound() {
  const startingWeather = getStartingWeather();
  const key =
    WEATHER_KEY_MAP[startingWeather.condition] ?? "dry_friction_multiplier";

  let bestSet = null;
  let bestFriction = -Infinity;

  for (const set of available_sets) {
    const props = tyreProperties[set.compound];
    const friction = props.life_span * props[key];

    if (friction > bestFriction) {
      bestFriction = friction;
      bestSet = set;
    }
  }

  return bestSet;
}

function getTyreFriction(compound) {
  const props = tyreProperties[compound];
  const startingWeather = getStartingWeather();
  const key =
    WEATHER_KEY_MAP[startingWeather.condition] ?? "dry_friction_multiplier";

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

function generateLap(segments, entrySpeed, cornerSpeedMap) {
  const outputSegments = [];
  let currentSpeed = entrySpeed;

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

      outputSegments.push({
        id: segment.id,
        type: "straight",
        "target_m/s": round2(targetSpeed),
        brake_start_m_before_next: round2(brakingDistance),
      });

      currentSpeed = limitingCornerSpeed;
    } else {
      outputSegments.push({
        id: segment.id,
        type: "corner",
      });
    }
  }

  return {
    segments: outputSegments,
    exitSpeed: currentSpeed,
  };
}

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

const laps = [];
let currentSpeed = 0;

for (let lap = 1; lap <= race.laps; lap++) {
  const result = generateLap(track.segments, currentSpeed, cornerSpeedMap);

  laps.push({
    lap,
    segments: result.segments,
    pit: {
      enter: false,
    },
  });

  currentSpeed = result.exitSpeed;
}

const output = {
  initial_tyre_id: initialTyreId,
  laps,
};

writeOutput(output);

console.log(`Level 1 optimized. Compound: ${compound} (id=${initialTyreId})`);
