import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- FILE IO ----------------
function readFileData() {
  const filePath = path.join(__dirname, "2.txt");
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

// ---------- CONFIG ----------
const chosenCompound = "Medium";
// ----------------------------

function round(value) {
  return Number(value.toFixed(2));
}

// ---------------- TYRES ----------------
function getInitialTyreId(compound) {
  const set = availableSets.find((item) => item.compound === compound);
  if (!set) throw new Error(`No tyre set found for ${compound}`);
  return set.ids[0];
}

function getStartingWeather() {
  return weatherConditions.find(
    (w) => w.id === race.starting_weather_condition_id,
  );
}

function getTyreFriction(compound) {
  const tyre = tyreProperties[compound];
  const weather = getStartingWeather();

  const map = {
    dry: "dry_friction_multiplier",
    cold: "cold_friction_multiplier",
    light_rain: "light_rain_friction_multiplier",
    heavy_rain: "heavy_rain_friction_multiplier",
  };

  return tyre.life_span * tyre[map[weather.condition]];
}

// ---------------- PHYSICS ----------------
function getSafeCornerSpeed(radius) {
  const friction = getTyreFriction(chosenCompound);
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

  return Math.min(Math.sqrt(numerator / denominator), maxSpeed);
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
function getTrackLength() {
  return track.segments.reduce((sum, s) => sum + s.length_m, 0);
}

function getFuelPerLap() {
  return getTrackLength() * car["fuel_consumption_l/m"];
}

// ---------------- SEGMENTS ----------------
function generateLapSegments(segments, entrySpeed) {
  const output = [];
  let currentSpeed = entrySpeed;
  let fuelUsedLap = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (seg.type === "straight") {
      const nextCornerIndex = getNextCornerIndex(segments, i);
      const nextCorner = segments[nextCornerIndex];

      const safeCornerSpeed = getSafeCornerSpeed(nextCorner.radius_m);

      const targetSpeed = solveTargetSpeed({
        entrySpeed: currentSpeed,
        cornerSpeed: safeCornerSpeed,
        straightLength: seg.length_m,
        accel: car["accel_m/se2"],
        brake: car["brake_m/se2"],
        maxSpeed: car["max_speed_m/s"],
      });

      const brakeDistance = getBrakeDistance(
        targetSpeed,
        safeCornerSpeed,
        car["brake_m/se2"],
      );

      const fuelUsed = seg.length_m * car["fuel_consumption_l/m"];
      fuelUsedLap += fuelUsed;

      output.push({
        id: seg.id,
        type: "straight",
        "target_m/s": round(targetSpeed),
        brake_start_m_before_next: round(brakeDistance),
      });

      currentSpeed = safeCornerSpeed;
    } else {
      const fuelUsed = seg.length_m * car["fuel_consumption_l/m"];
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
    fuelUsedLap,
  };
}

// ---------------- RACE ----------------
function generateAllLaps() {
  const laps = [];

  let currentSpeed = 0;
  let fuelRemaining = car["initial_fuel_l"];

  for (let lap = 1; lap <= race.laps; lap++) {
    const lapResult = generateLapSegments(track.segments, currentSpeed);

    let pit = { enter: false };

    // Check if we can finish next lap
    if (fuelRemaining - lapResult.fuelUsedLap < getFuelPerLap()) {
      // Need to refuel

      const fuelNeededToFinish = getFuelPerLap() * (race.laps - lap + 1);

      let fuelToAdd = fuelNeededToFinish - fuelRemaining;

      // clamp to tank capacity
      fuelToAdd = Math.min(
        fuelToAdd,
        car["fuel_tank_capacity_l"] - fuelRemaining,
      );

      fuelToAdd = Math.max(0, fuelToAdd);

      if (fuelToAdd > 0) {
        pit = {
          enter: true,
          fuel_refuel_amount_l: round(fuelToAdd),
        };

        fuelRemaining += fuelToAdd;

        // reset speed after pit
        currentSpeed = race["pit_exit_speed_m/s"];
      }
    }

    // consume fuel AFTER pit decision
    fuelRemaining -= lapResult.fuelUsedLap;

    laps.push({
      lap,
      segments: lapResult.segments,
      pit,
    });

    if (!pit.enter) {
      currentSpeed = lapResult.exitSpeed;
    }
  }

  return laps;
}

// ---------------- OUTPUT ----------------
const output = {
  initial_tyre_id: getInitialTyreId(chosenCompound),
  laps: generateAllLaps(),
};

writeOutput(output);
console.log("Generated output.txt successfully");
