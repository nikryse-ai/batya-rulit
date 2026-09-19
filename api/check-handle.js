import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { ALL_AVAILABILITY_SHEETS } from '../lib/sheets.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

const AI_PART_DESC = 'ручка/кнопка открывания двери багажника (не ручка двери салона и не ручка сиденья)';

export default async function handler(req, res) {
  const { vin } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  // Сквозной тайм-бюджет на весь запрос (55с из 60с maxDuration в vercel.json — 5с про запас
  // на чтение таблиц/сериализацию; было 50с/10с, но живые Vercel-логи 19.09.2026 показали, что
  // реальный запас гораздо больше — см. api/check-camera.js за подробностями) — делится между
  // всеми вызовами Gemini ниже по остатку времени, а не фиксированными кусками, см. lib/gemini.js.
  const deadline = Date.now() + 55000;

  try {
    const ai = await findVehiclePartsViaAI(vin, [{ key: 'handle', description: AI_PART_DESC }], { deadline });
    const carName = ai?.carName;
    const handles = ai?.parts?.handle?.oem
      ? [{ oem: ai.parts.handle.oem, name: ai.parts.handle.part_name }]
      : [];

    if (!handles.length) {
      return res.json({
        found: false,
        car_name: carName,
        message: carName
          ? 'У этого автомобиля ручка/кнопка багажника не определена.'
          : 'Не удалось определить автомобиль по этому VIN.'
      });
    }

    const availability = await matchOemAgainstSheets({
      oe: handles[0].oem,
      sheetNames: ALL_AVAILABILITY_SHEETS,
      deadline
    });

    return res.json({
      found: true,
      car_name: carName,
      handles: handles.map(h => ({ oem: h.oem, part_name: h.name })),
      source: 'ai',
      availability,
      message: [
        handles.map(h => h.name).join('\n'),
        availability.message
      ].filter(Boolean).join('\n')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
