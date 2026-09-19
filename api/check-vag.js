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

// ИСПРАВЛЕНО 19.09.2026: раньше код отдавал все 3 готовых варианта камеры (android/static/dynamic)
// и просил ИИ в Savvy выбрать самостоятельно. Пользователь поправил: выбор статика/динамика
// заказчик прописал прямо в таблице (лист «РУЧКИ VAG», заметка в нижних строках) — определяется
// платформой САМОЙ МАГНИТОЛЫ (MQB → динамика, PQ → статика), а не текстом ИИ. Платформа магнитолы
// уже вычислялась кодом (detectPlatform(radio.oem)) и раньше просто выводилась в message как
// справочная строка, реально не влияя на выбор — теперь используется для выбора напрямую.
// android-вариант выбирается по headunit_type (штатная/нештатная), который передаёт клиент/Savvy.
function resolveCameraVariant(variants, { platform, headunitType }) {
  if (!variants) return null;
  const type = (headunitType || '').toLowerCase();
  const isNonstandard = /нештат|android|андроид/.test(type);
  const isStandardStated = !isNonstandard && /штатн/.test(type);

  if (isNonstandard) {
    return variants.android
      ? { kind: 'android', links: variants.android, cameraModel: variants.cameraModel }
      : { kind: 'not_available', cameraModel: variants.cameraModel };
  }

  // Тип магнитолы явно не уточнён клиентом — исторически check-vag по умолчанию отвечал
  // за штатный сценарий, тем же путём идём и здесь, но платформа всё равно решает код, не ИИ.
  if (isStandardStated || !headunitType) {
    if (platform === 'MQB') {
      return variants.dynamic
        ? { kind: 'dynamic', links: variants.dynamic, cameraModel: variants.cameraModel }
        : { kind: 'not_available', cameraModel: variants.cameraModel };
    }
    if (platform === 'PQ') {
      return variants.static
        ? { kind: 'static', links: variants.static, cameraModel: variants.cameraModel }
        : { kind: 'not_available', cameraModel: variants.cameraModel };
    }
    // OEM магнитолы не попал ни в один известный список префиксов PQ/MQB (см. известное неполное
    // покрытие эвристики) — честно говорим, что не смогли определить, а не гадаем/отдаём LLM решать.
    return { kind: 'platform_unknown', cameraModel: variants.cameraModel };
  }

  return { kind: 'headunit_type_unclear', cameraModel: variants.cameraModel };
}

function formatCameraVariant(resolved) {
  if (!resolved) return null;
  const modelLine = resolved.cameraModel ? `Модель камеры для этой ручки: ${resolved.cameraModel}.` : null;
  switch (resolved.kind) {
    case 'android':
      return [modelLine, `Камера для Android/нештатной магнитолы: ${resolved.links.join(', ')}`].filter(Boolean).join('\n');
    case 'static':
      return [modelLine, `Камера для штатной магнитолы (платформа PQ, статические парковочные линии): ${resolved.links.join(', ')}`].filter(Boolean).join('\n');
    case 'dynamic':
      return [modelLine, `Камера для штатной магнитолы (платформа MQB, динамические следящие линии): ${resolved.links.join(', ')}`].filter(Boolean).join('\n');
    case 'not_available':
      return [modelLine, 'Для этого сочетания магнитолы и автомобиля готового варианта камеры в таблице нет — сообщите клиенту честно, без предположений.'].filter(Boolean).join('\n');
    case 'platform_unknown':
      return [modelLine, 'Не удалось определить платформу магнитолы (PQ/MQB) по её OEM-номеру — нужна ручная проверка, прежде чем предлагать статический или динамический вариант камеры.'].filter(Boolean).join('\n');
    case 'headunit_type_unclear':
      return [modelLine, 'Уточните у клиента, штатная магнитола или нештатная (Android) — без этого нельзя подобрать точный вариант камеры.'].filter(Boolean).join('\n');
    default:
      return modelLine;
  }
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

    const cameraVariant = resolveCameraVariant(cameraVariants, { platform, headunitType: headunit_type });

    return res.json({
      found: true,
      car_name: carName,
      radio: { oem: radio.oem, part_name: radio.name },
      platform,
      trunk_handle_variants: trunkHandles.map(h => ({ oem: h.oem, part_name: h.name })),
      camera_variant: cameraVariant,
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
        formatCameraVariant(cameraVariant),
        headunit_type ? `Тип магнитолы клиента (со слов клиента): ${headunit_type}.` : null
      ].filter(Boolean).join('\n')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
