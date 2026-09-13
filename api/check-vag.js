import { matchOemAgainstSheets, findVagCameraVariants } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { ALL_AVAILABILITY_SHEETS } from '../lib/sheets.js';

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

function formatVariantLine(label, links) {
  return links ? `— ${label}: ${links.join(', ')}` : null;
}

// По решению заказчика (13.09.2026) какой из 3 готовых вариантов камеры под ручку предложить
// клиенту — определяет ИИ в Savvy по точной модели магнитолы клиента, не жёсткое правило в коде
// (не все штатные магнитолы вообще принимают видеосигнал камеры, а среди тех, что принимают,
// не все поддерживают динамические линии — этого справочника у нас нет, только у ИИ есть шанс
// знать конкретную модель). Код лишь достаёт все 3 варианта как есть и просит ИИ выбрать.
function formatCameraVariants(variants) {
  if (!variants) return null;
  return [
    variants.cameraModel ? `Модель камеры для этой ручки: ${variants.cameraModel}.` : null,
    'Готовые варианты камеры под эту ручку (выбери подходящий по точной модели магнитолы клиента выше — не предлагай сразу все):',
    formatVariantLine('для Android/нештатной магнитолы', variants.android),
    formatVariantLine('для штатной магнитолы со статическими парковочными линиями', variants.static),
    formatVariantLine('для штатной магнитолы с динамическими (следящими за рулём) линиями', variants.dynamic),
    'Если по своим знаниям определишь, что эта конкретная модель штатной магнитолы вообще не принимает видеосигнал с камеры — прямо скажи клиенту, что для его магнитолы решения нет, и не предлагай ни один из вариантов выше.'
  ].filter(Boolean).join('\n');
}

export default async function handler(req, res) {
  const { vin, headunit_type } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  // Сквозной тайм-бюджет на весь запрос (50с из 60с maxDuration в vercel.json — 10с про запас
  // на чтение таблиц/сериализацию). Здесь особенно важен, т.к. ниже возможны ДО ТРЁХ
  // последовательных вызовов Gemini (VIN-lookup + сверка магнитолы + сверка ручки) —
  // с фиксированными бюджетами это гарантированно упиралось бы в 60с без запаса.
  const deadline = Date.now() + 50000;

  try {
    const ai = await findVehiclePartsViaAI(vin, [
      { key: 'radio', description: AI_RADIO_DESC },
      { key: 'handle', description: AI_HANDLE_DESC }
    ], { deadline });
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
      sheetNames: ALL_AVAILABILITY_SHEETS,
      deadline
    });

    const cameraVariants = trunkHandles.length
      ? await findVagCameraVariants({ handleOe: trunkHandles[0].oem, deadline })
      : null;

    return res.json({
      found: true,
      car_name: carName,
      radio: { oem: radio.oem, part_name: radio.name },
      platform,
      trunk_handle_variants: trunkHandles.map(h => ({ oem: h.oem, part_name: h.name })),
      camera_variants: cameraVariants,
      headunit_type: headunit_type ?? null,
      source: 'ai',
      availability,
      message: [
        `Магнитола: ${radio.name}`,
        availability.message,
        platform ? `Платформа: ${platform}` : null,
        trunkHandles.length
          ? `Ручка/кнопка багажника: ${trunkHandles[0].name}`
          : 'Ручка/кнопка багажника не определена.',
        formatCameraVariants(cameraVariants),
        headunit_type ? `Тип магнитолы клиента (со слов клиента): ${headunit_type}.` : null
      ].filter(Boolean).join('\n')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
