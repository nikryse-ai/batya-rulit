import { matchOemAgainstSheets, findVagCameraVariants } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { ALL_AVAILABILITY_SHEETS } from '../lib/sheets.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

const MQB_PREFIXES = ['5G0', '3G0', '5Q0', '5NA', '3QB', '5WA', '5WB', '3QF', '5LA', '5LB', '5TA', '5TB'];
const PQ_PREFIXES = ['1K0', '3C0', '5N0', '1Z0', '1T0', '7N0', '6R0', '6C0', '7L0', '7L6', '1P0'];

const AI_RADIO_DESC = 'штатное головное устройство/магнитола (аудиосистема) концерна VAG (VW/Skoda/Audi/Seat/Cupra)';
const AI_HANDLE_DESC = 'ручка/кнопка открывания двери багажника (не ручка двери салона и не ручка сиденья)';
const AI_LAMP_DESC = 'плафон подсветки заднего номерного знака (не плафон освещения салона)';

// ИСПРАВЛЕНО 26.09.2026: для нештатной (Android) магнитолы камера заднего вида ВАГ может
// физически стоять в ОДНОМ из двух мест в зависимости от кузова/комплектации — в ручке
// багажника (ручки VAG) ИЛИ в плафоне подсветки номера (как у штатного сценария check-lamp).
// Раньше check-vag искал только по ручке — если у конкретного авто камера на самом деле
// в плафоне, вариант для Android никогда не находился, хотя товар в таблице есть.
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
  const { isNonstandard, isStandardStated } = classifyHeadunitType(headunitType);

  if (isNonstandard) {
    return variants.android
      ? { kind: 'android', links: variants.android, cameraModel: variants.cameraModel }
      : { kind: 'not_available', cameraModel: variants.cameraModel };
  }

  // Платформу считаем независимо от того, подтвердил клиент штатную магнитолу или тип неясен —
  // нужна в обоих случаях (во втором — как один из предлагаемых вариантов, см. ниже).
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

  // ИСПРАВЛЕНО 26.09.2026: раньше при НЕ переданном/нераспознанном типе магнитолы код молча
  // считал её штатной — если платформу не удавалось определить (нередкий случай, см. неполноту
  // PQ_PREFIXES/MQB_PREFIXES выше и в памяти проекта), клиент получал честное, но бесполезное
  // "платформу не определить", хотя android-ссылка реально была в таблице (реальный прод-случай:
  // Audi Q3, клиент сказал в чате "Android-магнитола", headunit_type до вебхука не дошёл).
  // Теперь при неясном типе отдаём ВСЁ, что реально нашлось — не угадываем за клиента.
  return {
    kind: 'headunit_unclear',
    cameraModel: variants.cameraModel,
    androidLinks: variants.android ?? null,
    standardVariant
  };
}

// Не все штатные магнитолы ВАГ вообще принимают видеосигнал с камеры — это отдельный вопрос
// от платформы/статика-динамика (решается выше кодом) и от него не зависит: магнитола без
// видеовхода может стоять и на PQ-, и на MQB-платформе. Справочника "модель магнитолы → есть
// видеовход или нет" не существует ни у нас, ни у Laximo (проверялось 28.07.2026) — единственный
// шанс поймать этот случай есть у LLM в Savvy по своим знаниям о конкретной модели. ИСПРАВЛЕНО
// 19.09.2026: эта подстраховка была в тексте до сегодняшнего редизайна (13.09), но потерялась,
// когда выбор static/dynamic стал определяться кодом, а не ИИ — возвращена как отдельный шаг
// ПОСЛЕ уже сделанного кодом выбора, не вместо него.
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

// ИСПРАВЛЕНО 26.09.2026: плафон подсветки номера — второе возможное место установки камеры
// у Android/нештатной магнитолы (альтернатива ручке багажника, см. комментарий выше у AI_LAMP_DESC).
// Сверяется по общей таблице наличия (та же "Плафоны по OE ", что использует check-lamp.js),
// не по листу "РУЧКИ VAG" — у плафона нет 3 готовых вариантов (android/static/dynamic), он
// актуален только для нештатной магнитолы.
function formatPlateLampOption(plateLamp, availability) {
  if (!plateLamp) {
    return 'Альтернативный вариант камеры (через плафон подсветки номера) не определён для этого автомобиля.';
  }
  const base = `Альтернативный вариант установки камеры — плафон подсветки номера: ${plateLamp.name}.`;
  return availability?.found
    ? `${base} ${availability.message}`
    : `${base} В таблице наличия для этого плафона совпадений не найдено.`;
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
      { key: 'handle', description: AI_HANDLE_DESC },
      { key: 'plate_lamp', description: AI_LAMP_DESC }
    ];
    let ai = await findVehiclePartsViaAI(vin, parts, { deadline });

    // Наблюдение 19.09.2026: на той же машине (Skoda Octavia), которую ИИ до этого трижды подряд
    // находил без проблем, один вызов вернул car_name, но БЕЗ магнитолы — не HTTP-ошибка (retry на
    // 503 в lib/gemini.js тут не срабатывает, т.к. ошибки не было вообще), а просто разброс между
    // одинаковыми запросами. Один точечный повтор именно этого случая — раз машина в принципе
    // определилась, но магнитолы нет, а времени ещё достаточно. Не повторяем для остальных вебхуков/
    // случаев огулом, чтобы не удваивать стоимость там, где детали у машины реально нет.
    //
    // РАСШИРЕНО 19.09.2026 (тот же день, реальный прод-случай через Savvy): условие изначально
    // покрывало только "машина определилась, магнитолы нет" — но в проде поймали случай, когда
    // findVehiclePartsViaAI вернул null целиком (VIN-lookup упёрся в свой кап 30с и оборвался,
    // лог Vercel: 1 POST, Execution Duration 30.24s, AbortError) — тогда ai?.carName тоже falsy,
    // и старое условие не срабатывало вообще, хотя времени на повтор было предостаточно (30 из 55с).
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
      return res.json({
        found: false,
        car_name: carName,
        message: carName
          ? 'Магнитола не определена для этого автомобиля.'
          : 'Не удалось определить автомобиль по этому VIN.'
      });
    }

    const platform = detectPlatform(radio.oem);
    const { isStandardStated } = classifyHeadunitType(headunit_type);
    // ИСПРАВЛЕНО 26.09.2026: раньше плафон проверялся ТОЛЬКО когда headunit_type явно распознан
    // как нештатная/Android — если параметр не дошёл до вебхука вообще (реальный прод-случай,
    // см. комментарий в resolveCameraVariant выше), альтернатива через плафон молча пропадала
    // точно так же, как пропадала android-ссылка по ручке. Теперь проверяем её всегда, кроме
    // случая, когда клиент явно подтвердил штатную магнитолу (плафон для штатной не актуален).
    const showPlateLampAlternative = !isStandardStated;

    // Эти 3 обращения к таблицам независимы друг от друга (разные OE, разные листы) — раньше шли
    // последовательно (await один за другим), добавляя лишние секунды к уже тугому тайм-бюджету
    // запроса. Promise.all — общее время теперь равно самому медленному из трёх, а не сумме всех.
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

    return res.json({
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
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
