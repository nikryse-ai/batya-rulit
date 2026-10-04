import { resolveVagScenario } from '../lib/vag-scenario.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

// ИСПРАВЛЕНО 04.10.2026: вся бизнес-логика вынесена в lib/vag-scenario.js, чтобы её могли
// использовать и generic-вебхуки (check-camera.js/check-lamp.js/check-handle.js) как
// подстраховку, если Savvy вызвала их вместо check_vag для машины концерна ВАГ.
export default async function handler(req, res) {
  const { vin, headunit_type } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      car_name: null,
      radio: null,
      platform: null,
      trunk_handle_variants: [],
      camera_variant: null,
      plate_lamp: null,
      plate_lamp_availability: null,
      headunit_type: headunit_type ?? null,
      source: null,
      availability: null,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  // Сквозной тайм-бюджет на весь запрос (55с из 60с maxDuration в vercel.json — 5с про запас
  // на чтение таблиц/сериализацию). Здесь особенно важен, т.к. внутри resolveVagScenario
  // возможны до 2 вызовов Gemini (VIN-lookup + повтор при пропущенной магнитоле) плюс
  // 3 параллельных обращения к таблицам.
  const deadline = Date.now() + 55000;

  try {
    const result = await resolveVagScenario(vin, { headunit_type, deadline });
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      found: false,
      car_name: null,
      radio: null,
      platform: null,
      trunk_handle_variants: [],
      camera_variant: null,
      plate_lamp: null,
      plate_lamp_availability: null,
      headunit_type: headunit_type ?? null,
      source: null,
      availability: null,
      message: 'Технический сбой. Попробуйте позже.'
    });
  }
}
