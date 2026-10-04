import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { ALL_AVAILABILITY_SHEETS } from '../lib/sheets.js';
import { isVagBrand, resolveVagScenario } from '../lib/vag-scenario.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

const AI_PART_DESC = 'камера заднего вида для штатной мультимедийной системы (не декоративная накладка/кожух/кронштейн — сама камера с видеосигналом)';

// ИСПРАВЛЕНО 04.10.2026: 2 реальных прод-случая в один день — (1) Savvy вызвала этот generic
// вебхук для машины концерна ВАГ вместо check_vag, клиент получил неполный/не тот ответ;
// (2) found:false не содержал oem/part_name/source/availability — Savvy упала с "Путь до
// переменной (JSONPath) не найден" вместо честного сообщения о ненайденной детали. Оба
// случая исправлены здесь: пустые поля всегда присутствуют (null), а если по car_name виден
// концерн ВАГ — весь сценарий досчитывается через resolveVagScenario, независимо от того,
// какой вебхук реально вызвала Savvy.
const EMPTY_FIELDS = { oem: null, part_name: null, source: null, availability: null };

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
  // реальный запас гораздо больше — "Response finished" укладывался в 50.3с при бюджете 50с,
  // а уровень 2 сверки почти всегда обрывался именно об эту границу) — делится между всеми
  // вызовами Gemini ниже по остатку времени, а не фиксированными кусками, см. lib/gemini.js.
  const deadline = Date.now() + 55000;

  try {
    const ai = await findVehiclePartsViaAI(vin, [{ key: 'camera', description: AI_PART_DESC }], { deadline });
    const carName = ai?.carName;

    if (carName && isVagBrand(carName)) {
      const vagResult = await resolveVagScenario(vin, { headunit_type: undefined, deadline });
      return res.json({ ...EMPTY_FIELDS, ...vagResult });
    }

    const camera = ai?.parts?.camera?.oem
      ? { oem: ai.parts.camera.oem, name: ai.parts.camera.part_name }
      : null;

    if (!camera) {
      return res.json({
        found: false,
        car_name: carName,
        ...EMPTY_FIELDS,
        message: carName
          ? 'Камера заднего вида для этого автомобиля не найдена.'
          : 'Не удалось определить автомобиль по этому VIN.'
      });
    }

    const availability = await matchOemAgainstSheets({
      oe: camera.oem,
      crossReferences: ai.parts.camera.cross_references,
      sheetNames: ALL_AVAILABILITY_SHEETS,
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
        `Деталь: ${camera.name}. Автомобиль: ${carName}.`,
        availability.message
      ].filter(Boolean).join(' ')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, car_name: null, ...EMPTY_FIELDS, message: 'Технический сбой. Попробуйте позже.' });
  }
}
