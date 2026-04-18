// import fs from 'fs';
// import path from 'path';
// import { fileURLToPath } from 'url';

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
// function readfile() {
//     const filePath = path.join(__dirname, '1.txt');
//     const data = fs.readFileSync(filePath, 'utf8');
//     return JSON.parse(data);
// }


// function getTyreFriction(data, chosenCompound = 'Medium') {
//   const tyreProps = data.tyres.properties[chosenCompound];
//   const startingWeatherId = data.race.starting_weather_condition_id;
//   const weather = data.weather.conditions.find((w) => w.id === startingWeatherId);

//   const weatherToMultiplierKey = {
//     dry: 'dry_friction_multiplier',
//     cold: 'cold_friction_multiplier',
//     light_rain: 'light_rain_friction_multiplier',
//     heavy_rain: 'heavy_rain_friction_multiplier',
//   };

//   const multiplierKey = weatherToMultiplierKey[weather.condition];
//   return tyreProps.life_span * tyreProps[multiplierKey];
// }

// function getSafeCornerSpeed(radius, tyreFriction, crawlConstant) {
//   const g = 9.8;
//   return Math.sqrt(tyreFriction * g * radius) + crawlConstant;
// }

// function solveTargetSpeed({
//   entrySpeed,
//   cornerSpeed,
//   straightLength,
//   accel,
//   brake,
//   maxSpeed,
// }) {
//   // From:
//   // (target² - entry²)/(2a) + (target² - corner²)/(2b) <= straightLength

//   const numerator =
//     straightLength + (entrySpeed ** 2) / (2 * accel) + (cornerSpeed ** 2) / (2 * brake);

//   const denominator = (1 / (2 * accel)) + (1 / (2 * brake));

//   const targetSquared = numerator / denominator;
//   const target = Math.sqrt(Math.max(0, targetSquared));

//   return Math.min(target, maxSpeed);
// }

// function getBrakeDistance(targetSpeed, cornerSpeed, brake) {
//   return Math.max(0, (targetSpeed ** 2 - cornerSpeed ** 2) / (2 * brake));
// }
// function buildLevel1Segments(data, chosenCompound = 'Medium', entrySpeed = 0) {
//   const segments = data.track.segments;
//   const car = data.car;

//   const tyreFriction = getTyreFriction(data, chosenCompound);
//   const result = [];

//   let currentSpeed = entrySpeed;

//   for (let i = 0; i < segments.length; i++) {
//     const segment = segments[i];

//     if (segment.type === 'straight') {
//       const nextSegment = segments[i + 1];

//       if (!nextSegment || nextSegment.type !== 'corner') {
//         // Fallback: no immediate corner after straight
//         result.push({
//           id: segment.id,
//           type: 'straight',
//           'target_m/s': car['max_speed_m/s'],
//           brake_start_m_before_next: 0,
//         });

//         currentSpeed = car['max_speed_m/s'];
//         continue;
//       }

//       const safeCornerSpeed = getSafeCornerSpeed(
//         nextSegment.radius_m,
//         tyreFriction,
//         car['crawl_constant_m/s']
//       );

//       const targetSpeed = solveTargetSpeed({
//         entrySpeed: currentSpeed,
//         cornerSpeed: safeCornerSpeed,
//         straightLength: segment.length_m,
//         accel: car['accel_m/se2'],
//         brake: car['brake_m/se2'],
//         maxSpeed: car['max_speed_m/s'],
//       });

//       const brakeDistance = getBrakeDistance(
//         targetSpeed,
//         safeCornerSpeed,
//         car['brake_m/se2']
//       );

//       result.push({
//         id: segment.id,
//         type: 'straight',
//         'target_m/s': Number(targetSpeed.toFixed(2)),
//         'brake_start_m_before_next': Number(brakeDistance.toFixed(2)),
//       });

//       // You should enter the next corner at this speed
//       currentSpeed = safeCornerSpeed;
//     } else {
//       result.push({
//         id: segment.id,
//         type: 'corner',
//         'target_m/s': Number(currentSpeed.toFixed(2)),
//       });

//       // In Level 1, speed stays constant through the corner
//       // so currentSpeed remains unchanged
//     }
//   }

//   return result;
// }
// const data = readfile();
// // console.log('data', data);
// const car = data['car']
// const race = data['race']
// const track = data['track']
// const tyres = data['tyres']
// const mediumTyre = data['available_sets'][1]['ids'];
// const lap1Segments = buildLevel1Segments(data, 'Medium', 0);
// const maximumLaps = race['laps'];
// console.log(lap1Segments);

// // console.log('availableTyres', availableTyres);
// // console.log('car', car);
// // console.log('race', race);
// // console.log('track', track);
// // console.log('tyres', tyres);
// // const segments = track['segments']
// // function getTrack() {
// //     const laps = []
// //     for (let i = 0; i < maximumLaps; i++) {
// //         const lap = {
// //             'lap': i + 1,
// //             'segments': goThroughSegments()
// //         }
// //         laps.push(lap)
// //     }
// //     return laps
// // }

// function output(data) {
//     fs.writeFile('output.txt', JSON.stringify(data, null, 2), (err) => {
//         console.error('failed to upload file', err)
//     });
// }
// // output(trackData)`


// //length of track determines


// // function goThroughSegments() {
// //     const segmentsArr = []
// //     for (let i = 0; i < segments.length; i++) {
// //         //if straight
// //         if (segments[i].type === 'straight') {
// //             const straightSegment = {
// //                 "id": segments[i].id,
// //                 "type": "straight",
// //                 "target_m/s": 70,
// //                 "brake_start_m_before_next": 0
// //             }
// //             segmentsArr.push(straightSegment)

// //         } else {
// //             const cornerSegment = {
// //                 "id": segments[i].id,
// //                 "type": "corner"

// //             }
// //             segmentsArr.push(cornerSegment)
// //         }
    

// //     }
// //     return segmentsArr

// // }





