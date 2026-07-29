import { findVehicle, searchVehicleDetails } from '../lib/laximo.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
const CAMERA_RE = /camera|видеокамер/i;
// "camera" ловит и сопутствующие детали (кожух/крышка камеры, разъём, кабель) — это не сама камера
const CAMERA_EXCLUDE_RE = /кожух|крышка|чехол|переходник|разъ[её]м|провод|кабель|жгут/i;
// Нужна камера ЗАДНЕГО вида — исключаем однозначно переднюю, если есть более подходящий вариант
const REAR_RE = /задн|rear/i;
const FRONT_RE = /передн|front/i;

export default async function handler(req, res) {
  const { vin } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  try {
    const vehicles = await findVehicle(vin);
    const vehicle = vehicles?.[0];

    if (!vehicle) {
      return res.json({ found: false, message: 'Автомобиль по этому VIN не найден в каталоге.' });
    }

    const results = await searchVehicleDetails(vehicle.catalog, vehicle.ssd, vehicle.vehicleId, 'camera');
    const candidates = results.filter(r => CAMERA_RE.test(r.name) && !CAMERA_EXCLUDE_RE.test(r.name));
    const rearPreferred = candidates.filter(r => REAR_RE.test(r.name) || !FRONT_RE.test(r.name));
    const camera = rearPreferred[0] ?? candidates[0] ?? results[0];

    if (!camera) {
      return res.json({
        found: false,
        car_name: `${vehicle.brand} ${vehicle.name}`,
        message: 'Камера заднего вида для этого автомобиля не найдена в каталоге производителя.'
      });
    }

    return res.json({
      found: true,
      oem: camera.oem,
      part_name: camera.name,
      car_name: `${vehicle.brand} ${vehicle.name}`,
      message: `OEM артикул камеры: ${camera.oem}. Деталь: ${camera.name}. Автомобиль: ${vehicle.brand} ${vehicle.name}.`
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
