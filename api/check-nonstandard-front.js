import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { SHEETS } from '../lib/sheets.js';

// BMW/Mercedes, нештатная (Android) магнитола: клиенту нужна ПЕРЕДНЯЯ камера + OE-номер
// штатной магнитолы (чтобы позже свериться с таблицей совместимости — логика таблицы отдельно).

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

  try {
    const ai = await findVehiclePartsViaAI(vin, [
      { key: 'camera', description: AI_CAMERA_DESC },
      { key: 'headunit', description: AI_HEADUNIT_DESC }
    ]);
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

    const decoder = headunit
      ? await matchOemAgainstSheets({
          oe: headunit.oem,
          sheetNames: [SHEETS.BMW_MERCEDES_DECODER],
          resultKind: 'decoder'
        })
      : null;

    return res.json({
      found: true,
      car_name: carName,
      camera: camera ? { oem: camera.oem, part_name: camera.name } : null,
      headunit: headunit ? { oem: headunit.oem, part_name: headunit.name } : null,
      decoder,
      source: 'ai',
      message: [
        camera ? `Камера переднего вида: ${camera.oem} — ${camera.name}` : 'Камера переднего вида не определена.',
        headunit ? `Штатная магнитола: ${headunit.oem} — ${headunit.name}` : 'Штатная магнитола не определена.',
        decoder ? decoder.message : null,
        `Автомобиль: ${carName}`
      ].filter(Boolean).join('\n')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
