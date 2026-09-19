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

// Разбирает текст колонки «Платформа» строки ручки в листе РУЧКИ VAG (её заполняет заказчик
// сам). Там встречаются как однозначные значения ("PQ35", "MQB", "MQB A0"), так и осознанно
// неоднозначные ("PQ35/MQB" — сама таблица говорит "смотри по конкретной машине").
function classifyRowPlatform(rawPlatform) {
  if (!rawPlatform) return null;
  const text = rawPlatform.toUpperCase();
  const hasMqb = text.includes('MQB');
  const hasPq = text.includes('PQ');
  if (hasMqb && hasPq) return 'ambiguous';
  if (hasMqb) return 'MQB';
  if (hasPq) return 'PQ';
  return null; // текст не распознан (опечатка/другой формат) — не гадаем
}

// ИСПРАВЛЕНО 19.09.2026 (дважды): раньше код отдавал все 3 готовых варианта камеры
// (android/static/dynamic) и просил ИИ в Savvy выбрать самостоятельно — пользователь поправил,
// что выбор должен делать код. Первая версия фикса определяла платформу магнитолы ТОЛЬКО по
// её OEM-префиксу (detectPlatform, свой захардкоженный список PQ/MQB) — при построчной сверке
// с реальной таблицей нашлись прямые противоречия (напр. префикс "1T0" в нашем списке = PQ,
// но в таблице строка с этим же префиксом прямо помечена "MQB"; префикс "5N0" в нашем списке
// строго PQ, а в таблице есть его же MQB-строки). Решение пользователя 19.09.2026: таблицу ведёт
// заказчик, ей и доверять в первую очередь — если он где-то ошибётся, это его зона ответственности,
// не наша задача её самостоятельно "исправлять" отдельным списком, который может с ней разойтись.
//
// Приоритет теперь такой:
//   1) Колонка «Платформа» у найденной строки ручки (variants.platform, из таблицы заказчика) —
//      если там однозначно PQ или MQB, используем как есть, никакого дальнейшего анализа.
//   2) Если в таблице стоит осознанно неоднозначное "PQ35/MQB" или колонка пустая/нераспознанная —
//      ТОЛЬКО тогда используем запасной сигнал: platform по OEM самой магнитолы (detectPlatform),
//      ровно как просит заметка в самой таблице ("но нужна проверка магнитолы на mqb").
//   3) Если и запасной сигнал не дал ответа — честный platform_unknown, не гадаем.
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
  // за штатный сценарий, тем же путём идём и здесь.
  if (isStandardStated || !headunitType) {
    const rowPlatform = classifyRowPlatform(variants.platform);
    const resolvedPlatform = (rowPlatform === 'MQB' || rowPlatform === 'PQ')
      ? rowPlatform
      : platform; // таблица не дала однозначного ответа — запасной сигнал по OEM магнитолы

    if (resolvedPlatform === 'MQB') {
      return variants.dynamic
        ? { kind: 'dynamic', links: variants.dynamic, cameraModel: variants.cameraModel }
        : { kind: 'not_available', cameraModel: variants.cameraModel };
    }
    if (resolvedPlatform === 'PQ') {
      return variants.static
        ? { kind: 'static', links: variants.static, cameraModel: variants.cameraModel }
        : { kind: 'not_available', cameraModel: variants.cameraModel };
    }
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

  // Сквозной тайм-бюджет на весь запрос (55с из 60с maxDuration в vercel.json — 5с про запас
  // на чтение таблиц/сериализацию; было 50с/10с, но живые Vercel-логи 19.09.2026 показали, что
  // реальный запас гораздо больше — см. api/check-camera.js за подробностями). Здесь особенно
  // важен, т.к. ниже возможны ДО ЧЕТЫРЁХ последовательных вызовов Gemini (VIN-lookup + повтор
  // при пропущенной магнитоле + сверка наличия уровня 2 + это всё внутри одного запроса).
  const deadline = Date.now() + 55000;

  try {
    const parts = [
      { key: 'radio', description: AI_RADIO_DESC },
      { key: 'handle', description: AI_HANDLE_DESC }
    ];
    let ai = await findVehiclePartsViaAI(vin, parts, { deadline });

    // Наблюдение 19.09.2026: на той же машине (Skoda Octavia), которую ИИ до этого трижды подряд
    // находил без проблем, один вызов вернул car_name, но БЕЗ магнитолы — не HTTP-ошибка (retry на
    // 503 в lib/gemini.js тут не срабатывает, т.к. ошибки не было вообще), а просто разброс между
    // одинаковыми запросами. Один точечный повтор именно этого случая — раз машина в принципе
    // определилась, но магнитолы нет, а времени ещё достаточно. Не повторяем для остальных вебхуков/
    // случаев огулом, чтобы не удваивать стоимость там, где детали у машины реально нет.
    if (ai?.carName && !ai?.parts?.radio?.oem && Date.now() < deadline - 20000) {
      const retryAi = await findVehiclePartsViaAI(vin, parts, { deadline });
      if (retryAi?.parts?.radio?.oem) ai = retryAi;
    }

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
