import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { SHEETS } from '../lib/sheets.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

const MQB_PREFIXES = ['5G0', '3G0', '5Q0', '5NA', '3QB', '5WA', '5WB', '3QF', '5LA', '5LB', '5TA', '5TB'];
const PQ_PREFIXES = ['1K0', '3C0', '5N0', '1Z0', '1T0', '7N0', '6R0', '6C0', '7L0', '7L6', '1P0'];

const AI_RADIO_DESC = 'штатное головное устройство/магнитола (аудиосистема) концерна VAG (VW/Skoda/Audi/Seat/Cupra)';
const AI_HANDLE_DESC = 'ручка/кнопка открывания двери багажника (не ручка двери салона и не ручка сиденья)';

function detectPlatform(oem) {
  const prefix = oem.slice(0, 3).toUpperCase();
  if (MQB_PREFIXES.includes(prefix)) return 'MQB';
  if (PQ_PREFIXES.includes(prefix)) return 'PQ';
  return null;
}

export default async function handler(req, res) {
  const { vin, headunit_type } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  try {
    const ai = await findVehiclePartsViaAI(vin, [
      { key: 'radio', description: AI_RADIO_DESC },
      { key: 'handle', description: AI_HANDLE_DESC }
    ]);
    const carName = ai?.carName;
    const radio = ai?.parts?.radio?.oem
      ? { oem: ai.parts.radio.oem, name: ai.parts.radio.part_name }
      : null;
    const trunkHandles = ai?.parts?.handle?.oem
      ? [{ oem: ai.parts.handle.oem, name: ai.parts.handle.part_name }]
      : [];

    if (!radio) {
      return res.json({
        found: false,
        car_name: carName,
        message: carName
          ? 'Магнитола не определена для этого автомобиля.'
          : 'Не удалось определить автомобиль по этому VIN.'
      });
    }

    const platform = detectPlatform(radio.oem);

    const availability = await matchOemAgainstSheets({
      oe: radio.oem,
      sheetNames: [SHEETS.ALL_PRODUCTS],
      resultKind: 'availability'
    });

    const handleAvailability = trunkHandles.length
      ? await matchOemAgainstSheets({
          oe: trunkHandles[0].oem,
          sheetNames: [SHEETS.VAG, SHEETS.ALL_PRODUCTS],
          resultKind: 'availability'
        })
      : null;

    return res.json({
      found: true,
      car_name: carName,
      radio: { oem: radio.oem, part_name: radio.name },
      platform,
      trunk_handle_variants: trunkHandles.map(h => ({ oem: h.oem, part_name: h.name })),
      handle_availability: handleAvailability,
      headunit_type: headunit_type ?? null,
      source: 'ai',
      availability,
      message: [
        `Магнитола: ${radio.oem} — ${radio.name}`,
        availability.message,
        platform ? `Платформа: ${platform}` : null,
        trunkHandles.length
          ? `Ручка/кнопка багажника: ${trunkHandles[0].oem} — ${trunkHandles[0].name}`
          : 'Ручка/кнопка багажника не определена.',
        handleAvailability ? handleAvailability.message : null,
        headunit_type
          ? `Тип магнитолы клиента: ${headunit_type}. Учти это при подборе совместимого варианта камеры в ручке (модель камеры и применяемость — в данных по ручке выше) и предупреди клиента, если для его типа магнитолы нужен отдельный переходник/декодер видеосигнала.`
          : null
      ].filter(Boolean).join('\n')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
