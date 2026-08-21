import { findVehicle, searchVehicleDetails, searchWithFallback } from '../lib/laximo.js';
import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { SHEETS } from '../lib/sheets.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
const TRUNK_RE = /багажн|luggage|trunk|tailgate|deck ?lid/i;
const KIT_RE = /личинок|комплект|набор/i;

const RADIO_QUERIES = ['radio', 'head unit', 'магнитола', 'стерео', 'navigation'];
const RADIO_INCLUDE_RE = /гол(?:ов\S*|\.)?\s*устр|магнитол|радионавигацион|стерео|радио\//i;
// Полнотекстовый поиск цепляет посторонние детали, где искомое слово встречается мимоходом
// (заглушка гнезда ГУ, конденсатор радиопомех, модуль подушки безопасности с кнопками ГУ,
// монтажный к-кт для постзаводской установки магнитолы и т.д. — это не сама магнитола)
const RADIO_EXCLUDE_RE = /заглушка|конденсатор|антенн|кабель|жгут|провод|разъ[её]м|модуль\s*подуш|переходник|табличк|к-кт|комплект|набор|постзавод/i;

const MQB_PREFIXES = ['5G0', '3G0', '5Q0', '5NA', '3QB', '5WA', '5WB', '3QF', '5LA', '5LB', '5TA', '5TB'];
const PQ_PREFIXES = ['1K0', '3C0', '5N0', '1Z0', '1T0', '7N0', '6R0', '6C0', '7L0', '7L6', '1P0'];

const AI_RADIO_DESC = 'штатное головное устройство/магнитола (аудиосистема) концерна VAG (VW/Skoda/Audi/Seat/Cupra)';

function detectPlatform(oem) {
  const prefix = oem.slice(0, 3).toUpperCase();
  if (MQB_PREFIXES.includes(prefix)) return 'MQB';
  if (PQ_PREFIXES.includes(prefix)) return 'PQ';
  return null;
}

export default async function handler(req, res) {
  const { vin } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  try {
    let carName, radio, trunkHandles = [], viaAI = false;

    const vehicles = await findVehicle(vin);
    const vehicle = vehicles?.[0];

    if (vehicle) {
      carName = `${vehicle.brand} ${vehicle.name}`;

      const foundRadio = await searchWithFallback(
        vehicle.catalog, vehicle.ssd, vehicle.vehicleId,
        RADIO_QUERIES, RADIO_INCLUDE_RE, RADIO_EXCLUDE_RE
      );
      if (foundRadio) radio = { oem: foundRadio.oem, name: foundRadio.name };

      const handleResults = await searchVehicleDetails(vehicle.catalog, vehicle.ssd, vehicle.vehicleId, 'handle');
      const trunkItems = handleResults.filter(r => TRUNK_RE.test(r.name));
      const cleanHandles = trunkItems.filter(r => !KIT_RE.test(r.name));
      trunkHandles = (cleanHandles.length ? cleanHandles : trunkItems).slice(0, 4).map(h => ({ oem: h.oem, name: h.name }));
    } else {
      // Laximo не распознал VIN (не покрывает рынок/год) — пробуем через ИИ с веб-поиском.
      // Варианты ручки багажника через ИИ не запрашиваем — это не критично для сверки с таблицей,
      // а список из 1 предположительного варианта был бы менее полезен, чем честное "не определено".
      const ai = await findVehiclePartsViaAI(vin, [{ key: 'radio', description: AI_RADIO_DESC }]);
      if (ai?.parts?.radio?.oem) {
        carName = ai.carName;
        radio = { oem: ai.parts.radio.oem, name: ai.parts.radio.part_name };
        viaAI = true;
      }
    }

    if (!radio) {
      return res.json({
        found: false,
        car_name: carName,
        message: carName
          ? 'Магнитола не определена в каталоге по этому VIN.'
          : 'Автомобиль по этому VIN не найден в каталоге производителя, и определить его через ИИ тоже не удалось.'
      });
    }

    const platform = detectPlatform(radio.oem);

    const availability = await matchOemAgainstSheets({
      oe: radio.oem,
      sheetNames: [SHEETS.VAG, SHEETS.ALL_PRODUCTS],
      resultKind: 'availability'
    });

    return res.json({
      found: true,
      car_name: carName,
      radio: { oem: radio.oem, part_name: radio.name },
      platform,
      trunk_handle_variants: trunkHandles.map(h => ({ oem: h.oem, part_name: h.name })),
      source: viaAI ? 'ai_fallback' : 'laximo',
      availability,
      message: [
        viaAI ? 'Автомобиль не найден в официальном каталоге — деталь определена через ИИ приблизительно, точность ниже обычной.' : null,
        `Магнитола: ${radio.oem} — ${radio.name}`,
        availability.message,
        platform ? `Платформа: ${platform}` : null,
        trunkHandles.length
          ? `Варианты ручки/кнопки багажника:\n${trunkHandles.map(h => `${h.oem} — ${h.name}`).join('\n')}`
          : (viaAI ? null : 'Ручка/кнопка багажника не выделена отдельной деталью в каталоге.')
      ].filter(Boolean).join('\n')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
