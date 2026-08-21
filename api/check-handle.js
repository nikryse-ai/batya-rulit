import { findVehicle, searchVehicleDetails } from '../lib/laximo.js';
import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { SHEETS } from '../lib/sheets.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
const TRUNK_RE = /багажн|luggage|trunk|tailgate|deck ?lid/i; // корень "багажн" — ловит и "багажника", и "багажного отсека"
const KIT_RE = /личинок|комплект|набор/i; // общие ремкомплекты личинок замков на все двери сразу — не сама ручка/кнопка

const AI_PART_DESC = 'ручка/кнопка открывания двери багажника (не ручка двери салона и не ручка сиденья)';

export default async function handler(req, res) {
  const { vin } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  try {
    let carName, handles = [], viaAI = false;

    const vehicles = await findVehicle(vin);
    const vehicle = vehicles?.[0];

    if (vehicle) {
      carName = `${vehicle.brand} ${vehicle.name}`;

      // Ищем именно ручку/кнопку двери БАГАЖНИКА, а не ручки дверей/сидений
      const results = await searchVehicleDetails(vehicle.catalog, vehicle.ssd, vehicle.vehicleId, 'handle');
      const trunkItems = results.filter(r => TRUNK_RE.test(r.name));
      const clean = trunkItems.filter(r => !KIT_RE.test(r.name));
      const found = clean.length ? clean : trunkItems; // если остались только ремкомплекты — лучше их, чем ничего
      handles = found.map(h => ({ oem: h.oem, name: h.name }));
    } else {
      // Laximo не распознал VIN (не покрывает рынок/год) — пробуем через ИИ с веб-поиском
      const ai = await findVehiclePartsViaAI(vin, [{ key: 'handle', description: AI_PART_DESC }]);
      if (ai?.parts?.handle?.oem) {
        carName = ai.carName;
        handles = [{ oem: ai.parts.handle.oem, name: ai.parts.handle.part_name }];
        viaAI = true;
      }
    }

    if (!handles.length) {
      return res.json({
        found: false,
        car_name: carName,
        message: carName
          ? 'У этого автомобиля ручка/кнопка багажника не выделена отдельной деталью в каталоге (крышка открывается замком/кнопкой без отдельной ручки, либо не входит в этот раздел каталога).'
          : 'Автомобиль по этому VIN не найден в каталоге производителя, и определить его через ИИ тоже не удалось.'
      });
    }

    const availability = await matchOemAgainstSheets({
      oe: handles[0].oem,
      sheetNames: [SHEETS.FORD_HANDLE, SHEETS.ALL_PRODUCTS],
      resultKind: 'availability'
    });

    return res.json({
      found: true,
      car_name: carName,
      handles: handles.map(h => ({ oem: h.oem, part_name: h.name })),
      source: viaAI ? 'ai_fallback' : 'laximo',
      availability,
      message: [
        viaAI ? 'Автомобиль не найден в официальном каталоге — деталь определена через ИИ приблизительно, точность ниже обычной.' : null,
        handles.map(h => `${h.oem} — ${h.name}`).join('\n'),
        availability.message
      ].filter(Boolean).join('\n')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
