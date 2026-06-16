import { createOrder, searchCamera } from '../lib/tadam.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { vin } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  try {
    const orderId = await createOrder(vin);
    const articles = await searchCamera(orderId);

    if (articles.length === 0) {
      return res.json({
        found: false,
        message: 'Камера заднего вида для этого автомобиля не найдена в каталоге производителя.'
      });
    }

    const { oem, oem_vendor, part_name } = articles[0];

    return res.json({
      found: true,
      oem,
      oem_vendor,
      part_name,
      message: `OEM артикул камеры: ${oem} (${oem_vendor}). Деталь: ${part_name}.`
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      found: false,
      message: 'Технический сбой. Попробуйте позже или напишите нам напрямую.'
    });
  }
}
