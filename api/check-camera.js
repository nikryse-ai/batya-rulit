import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { SHEETS } from '../lib/sheets.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

const AI_PART_DESC = 'камера заднего вида для штатной мультимедийной системы (не декоративная накладка/кожух/кронштейн — сама камера с видеосигналом)';

export default async function handler(req, res) {
  const { vin } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  // Сквозной тайм-бюджет на весь запрос (50с из 60с maxDuration в vercel.json — 10с про запас
  // на чтение таблиц/сериализацию) — делится между всеми вызовами Gemini ниже по остатку
  // времени, а не фиксированными кусками, см. lib/gemini.js.
  const deadline = Date.now() + 50000;

  try {
    const ai = await findVehiclePartsViaAI(vin, [{ key: 'camera', description: AI_PART_DESC }], { deadline });
    const carName = ai?.carName;
    const camera = ai?.parts?.camera?.oem
      ? { oem: ai.parts.camera.oem, name: ai.parts.camera.part_name }
      : null;

    if (!camera) {
      return res.json({
        found: false,
        car_name: carName,
        message: carName
          ? 'Камера заднего вида для этого автомобиля не найдена.'
          : 'Не удалось определить автомобиль по этому VIN.'
      });
    }

    const availability = await matchOemAgainstSheets({
      oe: camera.oem,
      sheetNames: [SHEETS.STANDARD, SHEETS.ALL_PRODUCTS, SHEETS.STANDARD_FALLBACK],
      resultKind: 'availability',
      deadline
    });

    return res.json({
      found: true,
      oem: camera.oem,
      part_name: camera.name,
      car_name: carName,
      source: 'ai',
      availability,
      message: [
        `OEM артикул камеры: ${camera.oem}. Деталь: ${camera.name}. Автомобиль: ${carName}.`,
        availability.message
      ].filter(Boolean).join(' ')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
