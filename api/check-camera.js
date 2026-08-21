import { findVehicle, searchVehicleDetails } from '../lib/laximo.js';
import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { SHEETS } from '../lib/sheets.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
// В разных каталогах деталь называется то "видеокамера", то просто "камера" — ловим оба варианта
const CAMERA_RE = /camera|камер/i;
// "камера" ловит и сопутствующие детали (кожух/крышка, кронштейн, блок управления, аксессуары) — это не сама камера
// KaFAS — камера-ассистент на лобовом стекле (BMW), не камера обзора — легко спутать, т.к. в названии нет "передн"/"задн"
// "держатель" — крепление камеры, не сама камера (напр. BMW 750i "Держатель Камеры")
const CAMERA_EXCLUDE_RE = /кожух|крышка|чехол|переходник|разъ[её]м|провод|кабель|жгут|кронштейн|держатель|креплен|фиксатор|эбу|блок управлен|экшен|kafas/i;
// Нужна камера ЗАДНЕГО вида — исключаем однозначно переднюю, если есть более подходящий вариант
const REAR_RE = /задн|rear/i;
const FRONT_RE = /передн|front/i;

const AI_PART_DESC = 'камера заднего вида для штатной мультимедийной системы (не декоративная накладка/кожух/кронштейн — сама камера с видеосигналом)';

export default async function handler(req, res) {
  const { vin } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  try {
    let carName, camera, viaAI = false;

    const vehicles = await findVehicle(vin);
    const vehicle = vehicles?.[0];

    if (vehicle) {
      carName = `${vehicle.brand} ${vehicle.name}`;

      const results = await searchVehicleDetails(vehicle.catalog, vehicle.ssd, vehicle.vehicleId, 'camera');
      const candidates = results.filter(r => CAMERA_RE.test(r.name) && !CAMERA_EXCLUDE_RE.test(r.name));
      // Явно задние — приоритет. Если таких нет, берём безадресные ("Камера" без уточнения стороны).
      // НЕ откатываемся на однозначно переднюю деталь и не на нефильтрованный сырой результат —
      // так не подсовываем клиенту артикул не того элемента.
      const rearExplicit = candidates.filter(r => REAR_RE.test(r.name));
      const ambiguous = candidates.filter(r => !REAR_RE.test(r.name) && !FRONT_RE.test(r.name));
      const found = rearExplicit[0] ?? ambiguous[0] ?? null;
      if (found) camera = { oem: found.oem, name: found.name };
    } else {
      // Laximo не распознал VIN (не покрывает рынок/год) — пробуем через ИИ с веб-поиском
      const ai = await findVehiclePartsViaAI(vin, [{ key: 'camera', description: AI_PART_DESC }]);
      if (ai?.parts?.camera?.oem) {
        carName = ai.carName;
        camera = { oem: ai.parts.camera.oem, name: ai.parts.camera.part_name };
        viaAI = true;
      }
    }

    if (!camera) {
      return res.json({
        found: false,
        car_name: carName,
        message: carName
          ? 'Камера заднего вида для этого автомобиля не найдена в каталоге производителя.'
          : 'Автомобиль по этому VIN не найден в каталоге производителя, и определить его через ИИ тоже не удалось.'
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
      car_name: carName,
      source: viaAI ? 'ai_fallback' : 'laximo',
      availability,
      message: [
        viaAI ? 'Автомобиль не найден в официальном каталоге — деталь определена через ИИ приблизительно, точность ниже обычной.' : null,
        `OEM артикул камеры: ${camera.oem}. Деталь: ${camera.name}. Автомобиль: ${carName}.`,
        availability.message
      ].filter(Boolean).join(' ')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
