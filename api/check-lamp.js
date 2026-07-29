import { findVehicle, searchWithFallback } from '../lib/laximo.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
const PLATE_RE = /номер/i;
// "lamp" находит правильную деталь у Toyota/Ford, "light" — у VW/Audi. Один и тот же
// термин на разных марках может попасть на совсем другую лампу (проверено эмпирически).
const PLATE_QUERIES = ['license plate lamp', 'license plate light'];

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

    const plate = await searchWithFallback(vehicle.catalog, vehicle.ssd, vehicle.vehicleId, PLATE_QUERIES, PLATE_RE);

    return res.json({
      found: Boolean(plate),
      car_name: `${vehicle.brand} ${vehicle.name}`,
      plate_lamp: plate ? { oem: plate.oem, part_name: plate.name } : null,
      message: plate
        ? `Подсветка номера: ${plate.oem} — ${plate.name}`
        : 'Плафон подсветки номера для этого автомобиля не найден в каталоге производителя.'
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
