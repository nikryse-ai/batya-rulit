import { findVehicle, searchVehicleDetails } from '../lib/laximo.js';
import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { SHEETS } from '../lib/sheets.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
// В разных каталогах деталь называется то "видеокамера", то просто "камера" — ловим оба варианта
const CAMERA_RE = /camera|камер/i;
// "камера" ловит и сопутствующие детали (кожух/крышка, кронштейн, блок управления, аксессуары) — это не сама камера
// KaFAS — камера-ассистент на лобовом стекле (BMW), не камера обзора — легко спутать, т.к. в названии нет "передн"/"задн"
// "держатель" — крепление камеры, не сама камера (напр. BMW 750i "Держатель Камеры")
const CAMERA_EXCLUDE_RE = /кожух|крышка|чехол|переходник|разъ[её]м|провод|кабель|жгут|кронштейн|держатель|креплен|фиксатор|эбу|блок управлен|экшен|kafas/i;
// Нужна камера ПЕРЕДНЕГО вида — исключаем однозначно заднюю, если есть более подходящий вариант
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
    // Явно передние — приоритет. Если таких нет, берём безадресные ("Камера" без уточнения стороны).
    // НЕ откатываемся на однозначно заднюю деталь и не на нефильтрованный сырой результат —
    // так не подсовываем клиенту артикул задней камеры под видом передней (напр. Solaris — только задняя в каталоге).
    const frontExplicit = candidates.filter(r => FRONT_RE.test(r.name));
    const ambiguous = candidates.filter(r => !REAR_RE.test(r.name) && !FRONT_RE.test(r.name));
    const camera = frontExplicit[0] ?? ambiguous[0] ?? null;

    if (!camera) {
      return res.json({
        found: false,
        car_name: `${vehicle.brand} ${vehicle.name}`,
        message: 'Камера переднего вида для этого автомобиля не найдена в каталоге производителя.'
      });
    }

    const availability = await matchOemAgainstSheets({
      oe: camera.oem,
      sheetNames: [SHEETS.STANDARD, SHEETS.ALL_PRODUCTS, SHEETS.STANDARD_FALLBACK],
      resultKind: 'availability'
    });

    return res.json({
      found: true,
      oem: camera.oem,
      part_name: camera.name,
      car_name: `${vehicle.brand} ${vehicle.name}`,
      availability,
      message: [
        `OEM артикул камеры: ${camera.oem}. Деталь: ${camera.name}. Автомобиль: ${vehicle.brand} ${vehicle.name}.`,
        availability.message
      ].join(' ')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
