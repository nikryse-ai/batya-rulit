import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { SHEETS } from '../lib/sheets.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

const AI_PART_DESC = 'плафон подсветки заднего номерного знака (не плафон освещения салона)';

export default async function handler(req, res) {
  const vin = req.body?.vin ?? req.query?.vin;

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  try {
    const ai = await findVehiclePartsViaAI(vin, [{ key: 'plate_lamp', description: AI_PART_DESC }]);
    const carName = ai?.carName;
    const plate = ai?.parts?.plate_lamp?.oem
      ? { oem: ai.parts.plate_lamp.oem, name: ai.parts.plate_lamp.part_name }
      : null;

    if (!plate) {
      return res.json({
        found: false,
        car_name: carName,
        message: carName
          ? 'Плафон подсветки номера для этого автомобиля не найден.'
          : 'Не удалось определить автомобиль по этому VIN.'
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
      source: 'ai',
      availability,
      message: [
        `Подсветка номера: ${plate.oem} — ${plate.name}`,
        availability.message
      ].filter(Boolean).join(' ')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
