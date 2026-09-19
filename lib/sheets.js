// Чтение листов Google Таблицы совместимости и наличия через публичный gviz CSV-экспорт.
// Таблица расшарена «по ссылке» — сервисный аккаунт не нужен, читаем живьём при каждом запросе.
const SPREADSHEET_ID = '1tXo0LULH1IyzeUJEctifvE6iOq9qj2EoV_EcXKbu3LY';

// Имена листов сверены напрямую со структурой файла таблицы 13.09.2026 — старые константы
// (Штатные малая часть / Совместимость камер / HS Применяемость по OE / декодеры BMW/MERCEDES)
// больше не существуют под этими именами. Это важно: gviz-экспорт Google Sheets НЕ выдаёт ошибку
// на несуществующее имя листа, а молча подставляет первый лист таблицы — из-за этого сверка
// наличия долгое время могла тихо читать не тот лист. Названия ниже проверены посимвольно
// (у "Плафоны по OE" и "Артикул продавца" в исходнике реальный пробел в конце).
export const SHEETS = {
  VAG: 'РУЧКИ VAG',
  FORD_HANDLE: 'ручки ФОРД',
  LAMP: 'Плафоны по OE ',
  // Мастер-таблица с живыми артикулами маркетплейсов (Название товара | Артикул продавца |
  // Ссылка ВБ | Карточка Вайлдбериз | Ссылка Озон | Карточка Озон). Колонка "Артикул продавца" хранит
  // OE не как чистое значение, а как "<OE> <описание через пробел>" — см. извлечение первого токена
  // в lib/ai-match.js. Колонки "Ссылка ВБ"/"Ссылка Озон" — Excel-гиперссылки с текстом-плейсхолдером
  // "Ссылка" поверх реального адреса; сырой CSV-экспорт видит только этот текст, не URL — поэтому
  // реальную ссылку lib/ai-match.js собирает из числового ID в "Карточка Озон"/"Карточка Вайлдбериз".
  ALL_PRODUCTS: 'Товары с ссылками'
};

// По просьбе заказчика (13.09.2026) сверка наличия теперь ищет OE по ВСЕМ товарным листам сразу,
// а не только по "своему" листу сценария — раньше не найденное на одном листе могло реально быть
// на другом. Лист "декодеры BMWMERCEDES" сюда не входит — это не машиночитаемая таблица (нет шапки
// колонок, свободные заметки), решение по декодеру BMW/Mercedes сознательно отдано ИИ в промпте Savvy.
export const ALL_AVAILABILITY_SHEETS = [SHEETS.VAG, SHEETS.FORD_HANDLE, SHEETS.LAMP, SHEETS.ALL_PRODUCTS];

// Простой RFC4180-парсер: учитывает кавычки, экранированные "" внутри поля
// и переносы строк \n внутри значения (в некоторых листах — несколько моделей авто в одной ячейке).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* пропускаем, перевод строки — по \n */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else { field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  return rows;
}

// ИСПРАВЛЕНО 19.09.2026: раньше этот fetch не имел таймаута вообще — реальный прод-случай
// (BMW VIN, check-camera) показал ответ за 72с при общем тайм-бюджете запроса в 50с: сам
// вызов Gemini укладывался в бюджет, а вот чтение таблиц наличия ничем не ограничивалось
// и утянуло итог почти к потолку Vercel maxDuration=60с. Теперь fetch уважает переданный
// таймаут (AbortController) и, как и остальной код проекта, при сбое/таймауте не бросает
// исключение, а тихо возвращает [] — один медленный/недоступный лист не должен рушить
// остальные (см. также fetchSheets ниже: Promise.all теперь никогда не отклоняется).
async function fetchSheetRows(sheetName, { timeoutMs } = {}) {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let resp;
  try {
    resp = await fetch(url, { signal: controller?.signal });
  } catch (err) {
    console.error(`Sheets fetch failed/timed out for "${sheetName}":`, err);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!resp.ok) {
    console.error(`Sheets fetch failed for "${sheetName}": ${resp.status}`);
    return [];
  }

  const text = await resp.text();
  const table = parseCsv(text).filter(r => r.some(cell => cell?.trim()));
  if (table.length < 2) return [];

  // Некоторые листы (напр. "РУЧКИ VAG") имеют декоративную строку НАД настоящей шапкой колонок —
  // одна общая подпись на объединённые ячейки группы ("ANDROID", "ДЛЯ ШТАТНОЙ МАГНИТОЛЫ..."),
  // а остальные ячейки пустые. Если принять её за шапку, все пустые заголовки схлопнутся в один
  // ключ "" и данные станут нечитаемыми. Эвристика: настоящая шапка колонок никогда не пустее
  // следующей за ней строки — если первая строка пустее второй, значит первая строка декоративная.
  const nonEmptyCount = row => row.filter(cell => cell?.trim()).length;
  const headerIdx = nonEmptyCount(table[0]) < nonEmptyCount(table[1]) ? 1 : 0;

  const header = table[headerIdx];
  const rows = table.slice(headerIdx + 1);
  return rows.map(r => {
    const obj = {};
    header.forEach((h, i) => { obj[h.trim()] = (r[i] ?? '').trim(); });
    return obj;
  });
}

// sheetNames: string[] → { [sheetName]: Array<{ [колонка]: значение }> }
// timeoutMs (опционально) — бюджет на КАЖДЫЙ отдельный лист (листы читаются параллельно через
// Promise.all, не последовательно, так что при N листах общее время — это время самого
// медленного одного, не сумма всех). Без него — дефолт 15с на лист, чтобы даже без явного
// дедлайна от вызывающего кода чтение таблиц не могло виснуть неограниченно долго.
export async function fetchSheets(sheetNames, { timeoutMs = 15000 } = {}) {
  const unique = [...new Set(sheetNames)];
  const results = await Promise.all(unique.map(name => fetchSheetRows(name, { timeoutMs })));
  return unique.reduce((acc, name, i) => { acc[name] = results[i]; return acc; }, {});
}
