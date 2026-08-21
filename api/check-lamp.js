import { findVehicle, searchWithFallback } from '../lib/laximo.js';
import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { SHEETS } from '../lib/sheets.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
const PLATE_RE = /номер/i;
// "lamp" находит правильную деталь у Toyota/Ford, "light" — у VW/Audi. Один и тот же
// термин на разных марках может попасть на совсем другую лампу (проверено эмпирически).
const PLATE_QUERIES = ['license plate lamp', 'license plate light'];

const AI_PART_DESC = 'плафон подсветки заднего номерного знака (не плафон освещения салона)';

export default async function handler(req, res) {
  const { vin } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  try {
    let carName, plate, viaAI = false;

    const vehicles = await findVehicle(vin);
    const vehicle = vehicles?.[0];

    if (vehicle) {
      carName = `${vehicle.brand} ${vehicle.name}`;
      const found = await searchWithFallback(vehicle.catalog, vehicle.ssd, vehicle.vehicleId, PLATE_QUERIES, PLATE_RE);
      if (found) plate = { oem: found.oem, name: found.name };
    } else {
      // Laximo не распознал VIN (не покрывает рынок/год) — пробуем через ИИ с веб-поиском
      const ai = await findVehiclePartsViaAI(vin, [{ key: 'plate_lamp', description: AI_PART_DESC }]);
      if (ai?.parts?.plate_lamp?.oem) {
        carName = ai.carName;
        plate = { oem: ai.parts.plate_lamp.oem, name: ai.parts.plate_lamp.part_name };
        viaAI = true;
      }
    }

    if (!plate) {
      return res.json({
        found: false,
        car_name: carName,
        message: carName
          ? 'Плафон подсветки номера для этого автомобиля не найден в каталоге производителя.'
          : 'Автомобиль по этому VIN не найден в каталоге производителя, и определить его через ИИ тоже не удалось.'
      });
    }

    const availability = await matchOemAgainstSheets({
      oe: plate.oem,
      sheetNames: [SHEETS.HS_LAMP, SHEETS.ALL_PRODUCTS],
      resultKind: 'availability'
    });

    return res.json({
      found: true,
      car_name: carName,
      plate_lamp: { oem: plate.oem, part_name: plate.name },
      source: viaAI ? 'ai_fallback' : 'laximo',
      availability,
      message: [
        viaAI ? 'Автомобиль не найден в официальном каталоге — деталь определена через ИИ приблизительно, точность ниже обычной.' : null,
        `Подсветка номера: ${plate.oem} — ${plate.name}`,
        availability.message
      ].filter(Boolean).join(' ')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
