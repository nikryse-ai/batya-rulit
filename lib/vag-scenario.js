import { matchOemAgainstSheets, findVagCameraVariants } from './ai-match.js';
import { findVehiclePartsViaAI } from './ai-vin-lookup.js';
import { ALL_AVAILABILITY_SHEETS } from './sheets.js';

// ИСПРАВЛЕНО 04.10.2026: вынесено из api/check-vag.js в отдельный модуль — реальный прод-случай
// (живой тест через Savvy) показал, что Savvy иногда вызывает generic-вебхуки (check-camera,
// check-lamp, check-handle) для машин концерна ВАГ вместо выделенного check_vag action, то есть
// клиент получает обычный ответ про одну деталь вместо платформы/android/плафона. Теперь эти
// 3 generic-вебхука сами определяют концерн по car_name и, если это ВАГ, досчитывают и отдают
// полный ВАГ-сценарий сами — независимо от того, какой webhook реально вызвала Savvy.
export function isVagBrand(carName) {
  return /volkswagen|\bvw\b|škoda|skoda|шкода|фольксваген|\baudi\b|ауди|\bseat\b|сеат|сиат|cupra|купра/i.test(carName || '');
}

const MQB_PREFIXES = ['5G0', '3G0', '5Q0', '5NA', '3QB', '5WA', '5WB', '3QF', '5LA', '5LB', '5TA', '5TB'];
const PQ_PREFIXES = ['1K0', '3C0', '5N0', '1Z0', '1T0', '7N0', '6R0', '6C0', '7L0', '7L6', '1P0'];

const AI_RADIO_DESC = 'штатное головное устройство/магнитола (аудиосистема) концерна VAG (VW/Skoda/Audi/Seat/Cupra)';
const AI_HANDLE_DESC = 'ручка/кнопка открывания двери багажника (не ручка двери салона и не ручка сиденья)';
const AI_LAMP_DESC = 'плафон подсветки заднего номерного знака (не плафон освещения салона)';

function classifyHeadunitType(headunitType) {
  const type = (headunitType || '').toLowerCase();
  const isNonstandard = /нештат|android|андроид/.test(type);
  const isStandardStated = !isNonstandard && /штатн/.test(type);
  return { isNonstandard, isStandardStated };
}

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

// Приоритет:
//   1) Колонка «Платформа» у найденной строки ручки (variants.platform, из таблицы заказчика) —
//      если там однозначно PQ или MQB, используем как есть, никакого дальнейшего анализа.
//   2) Если в таблице стоит осознанно неоднозначное "PQ35/MQB" или колонка пустая/нераспознанная —
//      ТОЛЬКО тогда используем запасной сигнал: platform по OEM самой магнитолы (detectPlatform).
//   3) Если и запасной сигнал не дал ответа — честный platform_unknown, не гадаем.
function resolveCameraVariant(variants, { platform, headunitType }) {
  if (!variants) return null;
  const { isNonstandard, isStandardStated } = classifyHeadunitType(headunitType);

  if (isNonstandard) {
    return variants.android
      ? { kind: 'android', links: variants.android, cameraModel: variants.cameraModel }
      : { kind: 'not_available', cameraModel: variants.cameraModel };
  }

  const rowPlatform = classifyRowPlatform(variants.platform);
  const resolvedPlatform = (rowPlatform === 'MQB' || rowPlatform === 'PQ')
    ? rowPlatform
    : platform; // таблица не дала однозначного ответа — запасной сигнал по OEM магнитолы

  const standardVariant = resolvedPlatform === 'MQB'
    ? (variants.dynamic ? { kind: 'dynamic', links: variants.dynamic } : null)
    : resolvedPlatform === 'PQ'
      ? (variants.static ? { kind: 'static', links: variants.static } : null)
      : null;

  if (isStandardStated) {
    return standardVariant
      ? { ...standardVariant, cameraModel: variants.cameraModel }
      : { kind: resolvedPlatform ? 'not_available' : 'platform_unknown', cameraModel: variants.cameraModel };
  }

  // Тип магнитолы клиент явно не назвал (или назвал что-то неразборчивое) — отдаём ВСЁ, что
  // реально нашлось (android + штатный, если платформа определилась), не угадываем за клиента.
  return {
    kind: 'headunit_unclear',
    cameraModel: variants.cameraModel,
    androidLinks: variants.android ?? null,
    standardVariant
  };
}

// Не все штатные магнитолы ВАГ вообще принимают видеосигнал с камеры — отдельный вопрос от
// платформы/статика-динамика, от него не зависит. Справочника "модель магнитолы → видеовход
// да/нет" не существует — единственный шанс поймать это есть у LLM в Savvy по своим знаниям.
const CAMERA_SUPPORT_CAVEAT = 'Не все штатные магнитолы в принципе принимают видеосигнал с камеры — это отдельный вопрос от платформы/варианта выше. По точной модели магнитолы клиента (см. выше) определи, поддерживает ли она видеовход вообще; если нет — честно скажи, что для его магнитолы решения нет, и не предлагай ссылку выше.';

function formatCameraVariant(resolved) {
  if (!resolved) return null;
  const modelLine = resolved.cameraModel ? `Модель камеры для этой ручки: ${resolved.cameraModel}.` : null;
  switch (resolved.kind) {
    case 'android':
      return [modelLine, `Камера для Android/нештатной магнитолы: ${resolved.links.join(', ')}`].filter(Boolean).join('\n');
    case 'static':
      return [modelLine, `Камера для штатной магнитолы (платформа PQ, статические парковочные линии): ${resolved.links.join(', ')}`, CAMERA_SUPPORT_CAVEAT].filter(Boolean).join('\n');
    case 'dynamic':
      return [modelLine, `Камера для штатной магнитолы (платформа MQB, динамические следящие линии): ${resolved.links.join(', ')}`, CAMERA_SUPPORT_CAVEAT].filter(Boolean).join('\n');
    case 'not_available':
      return [modelLine, 'Для этого сочетания магнитолы и автомобиля готового варианта камеры в таблице нет — сообщите клиенту честно, без предположений.'].filter(Boolean).join('\n');
    case 'platform_unknown':
      return [modelLine, 'Не удалось определить платформу магнитолы (PQ/MQB) по её OEM-номеру — нужна ручная проверка, прежде чем предлагать статический или динамический вариант камеры.'].filter(Boolean).join('\n');
    case 'headunit_unclear': {
      const androidLine = resolved.androidLinks
        ? `Если магнитола Android/нештатная: ${resolved.androidLinks.join(', ')}`
        : 'Если магнитола Android/нештатная: готового варианта в таблице нет.';
      const standardLine = resolved.standardVariant
        ? `Если магнитола штатная (платформа ${resolved.standardVariant.kind === 'dynamic' ? 'MQB, динамические следящие линии' : 'PQ, статические парковочные линии'}): ${resolved.standardVariant.links.join(', ')}`
        : 'Если магнитола штатная: платформу (PQ/MQB) определить не удалось — нужна ручная проверка.';
      return [
        modelLine,
        androidLine,
        standardLine,
        resolved.standardVariant ? CAMERA_SUPPORT_CAVEAT : null,
        'Уточните у клиента, штатная магнитола или Android/нештатная — чтобы дать точный вариант без лишнего.'
      ].filter(Boolean).join('\n');
    }
    default:
      return modelLine;
  }
}

// Плафон подсветки номера — второе возможное место установки камеры у Android/нештатной
// магнитолы (альтернатива ручке багажника). Сверяется по общей таблице наличия (та же
// "Плафоны по OE ", что использует check-lamp.js), не по листу "РУЧКИ VAG".
function formatPlateLampOption(plateLamp, availability) {
  if (!plateLamp) {
    return 'Альтернативный вариант камеры (через плафон подсветки номера) не определён для этого автомобиля.';
  }
  const base = `Альтернативный вариант установки камеры — плафон подсветки номера: ${plateLamp.name}.`;
  return availability?.found
    ? `${base} ${availability.message}`
    : `${base} В таблице наличия для этого плафона совпадений не найдено.`;
}

// Возвращает объект ответа (та же форма, что раньше строил api/check-vag.js напрямую) —
// вызывающий код сам решает, что с ним делать (res.json для check-vag.js, либо подстановка
// вместо generic-ответа в check-camera.js/check-lamp.js/check-handle.js при обнаружении ВАГ).
export async function resolveVagScenario(vin, { headunit_type, deadline } = {}) {
  const parts = [
    { key: 'radio', description: AI_RADIO_DESC },
    { key: 'handle', description: AI_HANDLE_DESC },
    { key: 'plate_lamp', description: AI_LAMP_DESC }
  ];
  let ai = await findVehiclePartsViaAI(vin, parts, { deadline });

  // Точечный повтор для случая "машина определилась (или вообще не определилась), магнитолы
  // нет" — см. историю правок в памяти проекта (разброс между одинаковыми запросами к Gemini).
  const needsRetry = !ai || (ai.carName && !ai.parts?.radio?.oem);
  if (needsRetry && Date.now() < deadline - 20000) {
    const retryAi = await findVehiclePartsViaAI(vin, parts, { deadline });
    if (retryAi) ai = retryAi;
  }

  const carName = ai?.carName;
  const radio = ai?.parts?.radio?.oem
    ? { oem: ai.parts.radio.oem, name: ai.parts.radio.part_name }
    : null;
  const trunkHandles = ai?.parts?.handle?.oem
    ? [{ oem: ai.parts.handle.oem, name: ai.parts.handle.part_name }]
    : [];
  const plateLamp = ai?.parts?.plate_lamp?.oem
    ? { oem: ai.parts.plate_lamp.oem, name: ai.parts.plate_lamp.part_name, crossReferences: ai.parts.plate_lamp.cross_references }
    : null;

  if (!radio) {
    // Поля ниже (radio/platform/... /availability) включены как null/[] даже в found:false —
    // реальный прод-случай 04.10.2026: Savvy-экшен настроен на JSONPath к полям, которые есть
    // только в found:true, и при их отсутствии падает с "Путь до переменной не найден" вместо
    // того, чтобы просто показать клиенту текст сообщения о сбое.
    return {
      found: false,
      car_name: carName,
      radio: null,
      platform: null,
      trunk_handle_variants: [],
      camera_variant: null,
      plate_lamp: null,
      plate_lamp_availability: null,
      headunit_type: headunit_type ?? null,
      source: null,
      availability: null,
      message: carName
        ? 'Магнитола не определена для этого автомобиля.'
        : 'Не удалось определить автомобиль по этому VIN.'
    };
  }

  const platform = detectPlatform(radio.oem);
  const { isStandardStated } = classifyHeadunitType(headunit_type);
  const showPlateLampAlternative = !isStandardStated;

  const [availability, cameraVariants, plateLampAvailability] = await Promise.all([
    matchOemAgainstSheets({
      oe: radio.oem,
      crossReferences: ai.parts.radio.cross_references,
      sheetNames: ALL_AVAILABILITY_SHEETS,
      deadline
    }),
    trunkHandles.length
      ? findVagCameraVariants({ handleOe: trunkHandles[0].oem, deadline })
      : Promise.resolve(null),
    plateLamp && showPlateLampAlternative
      ? matchOemAgainstSheets({
          oe: plateLamp.oem,
          crossReferences: plateLamp.crossReferences,
          sheetNames: ALL_AVAILABILITY_SHEETS,
          deadline
        })
      : Promise.resolve(null)
  ]);

  const cameraVariant = resolveCameraVariant(cameraVariants, { platform, headunitType: headunit_type });

  return {
    found: true,
    car_name: carName,
    radio: { oem: radio.oem, part_name: radio.name },
    platform,
    trunk_handle_variants: trunkHandles.map(h => ({ oem: h.oem, part_name: h.name })),
    camera_variant: cameraVariant,
    plate_lamp: plateLamp ? { oem: plateLamp.oem, part_name: plateLamp.name } : null,
    plate_lamp_availability: plateLampAvailability,
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
      showPlateLampAlternative ? formatPlateLampOption(plateLamp, plateLampAvailability) : null,
      headunit_type ? `Тип магнитолы клиента (со слов клиента): ${headunit_type}.` : null
    ].filter(Boolean).join('\n')
  };
}
