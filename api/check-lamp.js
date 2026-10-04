import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { ALL_AVAILABILITY_SHEETS } from '../lib/sheets.js';
import { isVagBrand, resolveVagScenario } from '../lib/vag-scenario.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

const AI_PART_DESC = 'плафон подсветки заднего номерного знака (не плафон освещения салона)';

// ИСПРАВЛЕНО 04.10.2026: 2 реальных прод-случая — (1) Savvy вызвала generic-вебхук для
// машины концерна ВАГ вместо check_vag; (2) found:false не содержал plate_lamp/source/
// availability — Savvy падала с "Путь до переменной (JSONPath) не найден". См. комментарий
// в check-camera.js, тот же фикс.
const EMPTY_FIELDS = { plate_lamp: null, source: null, availability: null };

export default async function handler(req, res) {
  const { vin } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      car_name: null,
      ...EMPTY_FIELDS,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  // Сквозной тайм-бюджет на весь запрос (55с из 60с maxDuration в vercel.json — 5с про запас
  // на чтение таблиц/сериализацию; было 50с/10с, но живые Vercel-логи 19.09.2026 показали, что
  // реальный запас гораздо больше — см. api/check-camera.js за подробностями) — делится между
  // всеми вызовами Gemini ниже по остатку времени, а не фиксированными кусками, см. lib/gemini.js.
  const deadline = Date.now() + 55000;

  try {
    const ai = await findVehiclePartsViaAI(vin, [{ key: 'plate_lamp', description: AI_PART_DESC }], { deadline });
    const carName = ai?.carName;

    if (carName && isVagBrand(carName)) {
      const vagResult = await resolveVagScenario(vin, { headunit_type: undefined, deadline });
      return res.json({ ...EMPTY_FIELDS, ...vagResult });
    }

    const plate = ai?.parts?.plate_lamp?.oem
      ? { oem: ai.parts.plate_lamp.oem, name: ai.parts.plate_lamp.part_name }
      : null;

    if (!plate) {
      return res.json({
        found: false,
        car_name: carName,
        ...EMPTY_FIELDS,
        message: carName
          ? 'Плафон подсветки номера для этого автомобиля не найден.'
          : 'Не удалось определить автомобиль по этому VIN.'
      });
    }

    const availability = await matchOemAgainstSheets({
      oe: plate.oem,
      crossReferences: ai.parts.plate_lamp.cross_references,
      sheetNames: ALL_AVAILABILITY_SHEETS,
      deadline
    });

    return res.json({
      found: true,
      car_name: carName,
      plate_lamp: { oem: plate.oem, part_name: plate.name },
      source: 'ai',
      availability,
      message: [
        `Подсветка номера: ${plate.name}`,
        availability.message
      ].filter(Boolean).join(' ')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, car_name: null, ...EMPTY_FIELDS, message: 'Технический сбой. Попробуйте позже.' });
  }
}
