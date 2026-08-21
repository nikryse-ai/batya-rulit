import { findVehicle, searchVehicleDetails, searchWithFallback } from '../lib/laximo.js';
import { matchOemAgainstSheets } from '../lib/ai-match.js';
import { findVehiclePartsViaAI } from '../lib/ai-vin-lookup.js';
import { SHEETS } from '../lib/sheets.js';

// BMW/Mercedes, нештатная (Android) магнитола: клиенту нужна ЗАДНЯЯ камера + OE-номер
// штатной магнитолы (чтобы позже свериться с таблицей совместимости — логика таблицы отдельно).

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

const CAMERA_RE = /camera|камер/i;
// KaFAS — камера-ассистент на лобовом стекле (BMW), не камера обзора — легко спутать, т.к. в названии нет "передн"/"задн"
// "держатель" — крепление камеры, не сама камера (напр. BMW 750i "Держатель Камеры")
const CAMERA_EXCLUDE_RE = /кожух|крышка|чехол|переходник|разъ[её]м|провод|кабель|жгут|кронштейн|держатель|креплен|фиксатор|эбу|блок управлен|экшен|kafas/i;
const REAR_RE = /задн|rear/i;
const FRONT_RE = /передн|front/i;

// Полнотекстовый поиск Laximo у BMW/Mercedes не даёт названия системы (CIC/NBT/NTG/Comand и т.п.
// — проверено прямыми запросами, нигде не встречается), поэтому ищем только OE и название детали.
// У Mercedes каталог называет магнитолу/мультимедиа-блок обезличенно "Блок управления" без уточнения —
// точность здесь ниже, чем у BMW, где встречаются информативные названия ("радиоприемник",
// "информационный дисплей", "система навигации"). Радио-запросы идут первыми — это сам блок магнитолы,
// "дисплей" оставлен запасным вариантом (у BMW CIC/NBT это отдельная деталь — экран, не сама электроника).
const HEADUNIT_QUERIES = ['radio', 'радио', 'аудио', 'дисплей', 'навигация'];
const HEADUNIT_INCLUDE_RE = /радио|дисплей|навигац|аудио|блок\s*управлен/i;
// "дистанц" (не полное "дистанционн") — у BMW встречается сокращённо: "Дистанц.радиоуправление M Sport" (пульт, не магнитола)
// "к-т/к-кт/комплект/набор" — ремкомплекты панели ("Рем.к-т пан.упр.радиоприемн."), не сама магнитола
// "панель\s*управлен" — физическая панель с кнопками ("Панель управления аудиосистемой"), не блок электроники
// "наушник" — беспроводные наушники заднего развлечения ("Накладные радионаушники")
const HEADUNIT_EXCLUDE_RE = /рама|крыло|стекл|уплотнител|подрамник|кронштейн|катализатор|усилитель\s*тормоз|сальник|дистанц|щиток|кожух|панель\s*приборов|панель\s*управлен|подушк|ремень|люк|окн|лобов|звукоизоляц|портативн|к-т|к-кт|комплект|набор|наушник|потолок|крыш|накладк/i;

const AI_CAMERA_DESC = 'камера заднего вида (сам модуль камеры, не крепление/кожух)';
const AI_HEADUNIT_DESC = 'штатное головное устройство/магнитола BMW или Mercedes (сам блок электроники, не пульт/панель управления)';

export default async function handler(req, res) {
  const { vin } = req.body ?? {};

  if (!vin || !VIN_RE.test(vin)) {
    return res.json({
      found: false,
      message: 'Некорректный VIN. Проверьте — 17 латинских символов без букв I, O, Q.'
    });
  }

  try {
    let carName, camera, headunit, viaAI = false;

    const vehicles = await findVehicle(vin);
    const vehicle = vehicles?.[0];

    if (vehicle) {
      carName = `${vehicle.brand} ${vehicle.name}`;

      const cameraResults = await searchVehicleDetails(vehicle.catalog, vehicle.ssd, vehicle.vehicleId, 'camera');
      const cameraCandidates = cameraResults.filter(r => CAMERA_RE.test(r.name) && !CAMERA_EXCLUDE_RE.test(r.name));
      const rearExplicit = cameraCandidates.filter(r => REAR_RE.test(r.name));
      const cameraAmbiguous = cameraCandidates.filter(r => !REAR_RE.test(r.name) && !FRONT_RE.test(r.name));
      const foundCamera = rearExplicit[0] ?? cameraAmbiguous[0] ?? null;
      if (foundCamera) camera = { oem: foundCamera.oem, name: foundCamera.name };

      const foundHeadunit = await searchWithFallback(
        vehicle.catalog, vehicle.ssd, vehicle.vehicleId,
        HEADUNIT_QUERIES, HEADUNIT_INCLUDE_RE, HEADUNIT_EXCLUDE_RE
      );
      if (foundHeadunit) headunit = { oem: foundHeadunit.oem, name: foundHeadunit.name };
    } else {
      // Laximo не распознал VIN (не покрывает рынок/год) — пробуем через ИИ с веб-поиском
      const ai = await findVehiclePartsViaAI(vin, [
        { key: 'camera', description: AI_CAMERA_DESC },
        { key: 'headunit', description: AI_HEADUNIT_DESC }
      ]);
      if (ai) {
        carName = ai.carName;
        if (ai.parts.camera?.oem) camera = { oem: ai.parts.camera.oem, name: ai.parts.camera.part_name };
        if (ai.parts.headunit?.oem) headunit = { oem: ai.parts.headunit.oem, name: ai.parts.headunit.part_name };
        viaAI = Boolean(camera || headunit);
      }
    }

    if (!camera && !headunit) {
      return res.json({
        found: false,
        car_name: carName,
        message: carName
          ? 'Ни камера, ни штатная магнитола для этого автомобиля не найдены в каталоге производителя.'
          : 'Автомобиль по этому VIN не найден в каталоге производителя, и определить его через ИИ тоже не удалось.'
      });
    }

    const decoder = headunit
      ? await matchOemAgainstSheets({
          oe: headunit.oem,
          sheetNames: [SHEETS.BMW_MERCEDES_DECODER],
          resultKind: 'decoder'
        })
      : null;

    return res.json({
      found: true,
      car_name: carName,
      camera: camera ? { oem: camera.oem, part_name: camera.name } : null,
      headunit: headunit ? { oem: headunit.oem, part_name: headunit.name } : null,
      decoder,
      source: viaAI ? 'ai_fallback' : 'laximo',
      message: [
        viaAI ? 'Автомобиль не найден в официальном каталоге — детали определены через ИИ приблизительно, точность ниже обычной.' : null,
        camera ? `Камера заднего вида: ${camera.oem} — ${camera.name}` : 'Камера заднего вида не найдена в каталоге производителя.',
        headunit ? `Штатная магнитола: ${headunit.oem} — ${headunit.name}` : 'Штатная магнитола не определена в каталоге по этому VIN.',
        decoder ? decoder.message : null,
        `Автомобиль: ${carName}`
      ].filter(Boolean).join('\n')
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ found: false, message: 'Технический сбой. Попробуйте позже.' });
  }
}
