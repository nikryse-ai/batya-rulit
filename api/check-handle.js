import { findVehicle, searchVehicleDetails } from '../lib/laximo.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
const TRUNK_RE = /багажн|luggage|trunk|tailgate|deck ?lid/i; // корень "багажн" — ловит и "багажника", и "багажного отсека"
const KIT_RE = /личинок|комплект|набор/i; // общие ремкомплекты личинок замков на все двери сразу — не сама ручка/кнопка

export default async function handler(req, res) {
  const { vin } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  try {
    const vehicles = await findVehicle(vin);
    const vehicle = vehicles?.[0];

    if (!vehicle) {
      return res.json({ found: false, message: 'Автомобиль по этому VIN не найден в каталоге.' });
    }

    // Ищем именно ручку/кнопку двери БАГАЖНИКА, а не ручки дверей/сидений
    const results = await searchVehicleDetails(vehicle.catalog, vehicle.ssd, vehicle.vehicleId, 'handle');
    const trunkItems = results.filter(r => TRUNK_RE.test(r.name));
    const clean = trunkItems.filter(r => !KIT_RE.test(r.name));
    const handles = clean.length ? clean : trunkItems; // если остались только ремкомплекты — лучше их, чем ничего

    return res.json({
      found: handles.length > 0,
      car_name: `${vehicle.brand} ${vehicle.name}`,
      handles: handles.map(h => ({ oem: h.oem, part_name: h.name })),
      message: handles.length
        ? handles.map(h => `${h.oem} — ${h.name}`).join('\n')
        : 'У этого автомобиля ручка/кнопка багажника не выделена отдельной деталью в каталоге (крышка открывается замком/кнопкой без отдельной ручки, либо не входит в этот раздел каталога).'
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
