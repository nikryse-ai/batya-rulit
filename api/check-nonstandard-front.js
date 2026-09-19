import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { ALL_AVAILABILITY_SHEETS } from '../lib/sheets.js';

// BMW/Mercedes, нештатная (Android) магнитола: клиенту нужна ПЕРЕДНЯЯ камера + OE-номер
// штатной магнитолы. Совместимость магнитолы с видеосигналом камеры по решению заказчика
// (13.09.2026) не сверяется по таблице — лист "декодеры BMWMERCEDES" не машиночитаем
// (нет колонок, свободные заметки), поэтому это отдано на откуп ИИ в промпте Savvy.

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

const AI_CAMERA_DESC = 'камера переднего вида (сам модуль камеры, не крепление/кожух)';
const AI_HEADUNIT_DESC = 'штатное головное устройство/магнитола BMW или Mercedes (сам блок электроники, не пульт/панель управления)';

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
    const ai = await findVehiclePartsViaAI(vin, [
      { key: 'camera', description: AI_CAMERA_DESC },
      { key: 'headunit', description: AI_HEADUNIT_DESC }
    ], { deadline });
    const carName = ai?.carName;
    const camera = ai?.parts?.camera?.oem
      ? { oem: ai.parts.camera.oem, name: ai.parts.camera.part_name }
      : null;
    const headunit = ai?.parts?.headunit?.oem
      ? { oem: ai.parts.headunit.oem, name: ai.parts.headunit.part_name }
      : null;

    if (!camera && !headunit) {
      return res.json({
        found: false,
        car_name: carName,
        message: carName
          ? 'Ни камера, ни штатная магнитола для этого автомобиля не определены.'
          : 'Не удалось определить автомобиль по этому VIN.'
      });
    }

    // ИСПРАВЛЕНО 19.09.2026: сверка наличия здесь отсутствовала вообще (не только для декодера,
    // который осознанно убран 13.09 — камера тоже никогда не проверялась с момента добавления
    // этого вебхука 18.08, см. git-историю). Камера — обычная деталь, которая может быть в той же
    // "Товары с ссылками", что и для штатного сценария check-camera-front — сверяем её так же.
    const availability = camera
      ? await matchOemAgainstSheets({ oe: camera.oem, sheetNames: ALL_AVAILABILITY_SHEETS, deadline })
      : null;

    return res.json({
      found: true,
      car_name: carName,
      camera: camera ? { oem: camera.oem, part_name: camera.name } : null,
      headunit: headunit ? { oem: headunit.oem, part_name: headunit.name } : null,
      source: 'ai',
      availability,
      message: [
        camera ? `Камера переднего вида: ${camera.name}` : 'Камера переднего вида не определена.',
        availability?.message,
        headunit ? `Штатная магнитола: ${headunit.name}` : 'Штатная магнитола не определена.',
        headunit
          ? 'По своим знаниям определи, поддерживает ли эта модель магнитолы приём видеосигнала камеры и какой декодер/переходник для неё нужен — точных данных по этой модели у нас нет.'
          : null,
        `Автомобиль: ${carName}`
      ].filter(Boolean).join('\n')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
