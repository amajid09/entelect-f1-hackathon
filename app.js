import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readFileData() {
  const filePath = path.join(__dirname, '1.txt');
  const data = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(data);
}

function writeOutput(data) {
  const filePath = path.join(__dirname, 'output.txt');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const data = readFileData();

const car = data.car;
const race = data.race;
const track = data.track;
const availableSets = data.available_sets;
const weatherConditions = data.weather.conditions;
const tyreProperties = data.tyres.properties;

// ---------- CONFIG ----------
const chosenCompound = 'Medium';
// ----------------------------

function getInitialTyreId(compound) {
  const set = availableSets.find((item) => item.compound === compound);
  if (!set) {
    throw new Error(`No tyre set found for compound: ${compound}`);
  }
  return set.ids[0];
}

function getStartingWeather() {
  const weather = weatherConditions.find(
    (item) => item.id === race.starting_weather_condition_id
  );

  if (!weather) {
    throw new Error('Starting weather condition not found');
  }

  return weather;
}

function getTyreFriction(compound) {
  const tyre = tyreProperties[compound];
  const weather = getStartingWeather();

  const weatherKeyMap = {
    dry: 'dry_friction_multiplier',
    cold: 'cold_friction_multiplier',
    light_rain: 'light_rain_friction_multiplier',
    heavy_rain: 'heavy_rain_friction_multiplier',
  };

  const multiplierKey = weatherKeyMap[weather.condition];
  if (!multiplierKey) {
    throw new Error(`Unsupported weather condition: ${weather.condition}`);
  }

  // Level 1: no degradation, so friction is just life_span * weather multiplier
  return tyre.life_span * tyre[multiplierKey];
}

function getSafeCornerSpeed(radius) {
  const tyreFriction = getTyreFriction(chosenCompound);
  const g = 9.8;
  return Math.sqrt(tyreFriction * g * radius) + car['crawl_constant_m/s'];
}

function getNextCornerIndex(segments, startIndex) {
  for (let i = startIndex + 1; i < segments.length; i++) {
    if (segments[i].type === 'corner') {
      return i;
    }
  }

  // if no corner later in current lap, wrap around to next lap
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].type === 'corner') {
      return i;
    }
  }

  return -1;
}

function solveTargetSpeed({
  entrySpeed,
  cornerSpeed,
  straightLength,
  accel,
  brake,
  maxSpeed,
}) {
  // Solve:
  // (target² - entry²)/(2a) + (target² - corner²)/(2b) <= straightLength

  const numerator =
    straightLength +
    (entrySpeed ** 2) / (2 * accel) +
    (cornerSpeed ** 2) / (2 * brake);

  const denominator = (1 / (2 * accel)) + (1 / (2 * brake));

  const targetSquared = numerator / denominator;
  const solvedTarget = Math.sqrt(Math.max(0, targetSquared));

  return Math.min(solvedTarget, maxSpeed);
}

function getBrakeDistance(targetSpeed, cornerSpeed, brake) {
  return Math.max(0, (targetSpeed ** 2 - cornerSpeed ** 2) / (2 * brake));
}

function round(value) {
  return Number(value.toFixed(2));
}

function generateLapSegments(segments, entrySpeedAtLapStart) {
  const outputSegments = [];
  let currentSpeed = entrySpeedAtLapStart;

  for (let i = 0; i < segments.length; i++) {
    const currentSegment = segments[i];

    if (currentSegment.type === 'straight') {
      const nextCornerIndex = getNextCornerIndex(segments, i);

      if (nextCornerIndex === -1) {
        throw new Error('Track must contain at least one corner');
      }

      const nextCorner = segments[nextCornerIndex];
      const safeCornerSpeed = getSafeCornerSpeed(nextCorner.radius_m);

      const targetSpeed = solveTargetSpeed({
        entrySpeed: currentSpeed,
        cornerSpeed: safeCornerSpeed,
        straightLength: currentSegment.length_m,
        accel: car['accel_m/se2'],
        brake: car['brake_m/se2'],
        maxSpeed: car['max_speed_m/s'],
      });

      const brakeDistance = getBrakeDistance(
        targetSpeed,
        safeCornerSpeed,
        car['brake_m/se2']
      );

      outputSegments.push({
        id: currentSegment.id,
        type: 'straight',
        'target_m/s': round(targetSpeed),
        brake_start_m_before_next: round(brakeDistance),
      });

      // After this straight, the car should enter the next corner at safeCornerSpeed
      currentSpeed = safeCornerSpeed;
    } else {
      outputSegments.push({
        id: currentSegment.id,
        type: 'corner',
      });

      // In Level 1, speed stays constant through the whole corner
      // so currentSpeed remains unchanged
    }
  }

  return {
    segments: outputSegments,
    exitSpeed: currentSpeed,
  };
}

function generateAllLaps() {
  const laps = [];
  let currentSpeed = 0; // race starts at 0 m/s

  for (let lapNumber = 1; lapNumber <= race.laps; lapNumber++) {
    const lapResult = generateLapSegments(track.segments, currentSpeed);

    laps.push({
      lap: lapNumber,
      segments: lapResult.segments,
      pit: {
        enter: false,
      },
    });

    currentSpeed = lapResult.exitSpeed;
  }

  return laps;
}

const output = {
  initial_tyre_id: getInitialTyreId(chosenCompound),
  laps: generateAllLaps(),
};

writeOutput(output);
console.log('Generated output.txt successfully');