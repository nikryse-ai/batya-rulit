// Чтение листов Google Таблицы «Совместимость камер» через публичный gviz CSV-экспорт.
// Таблица расшарена «по ссылке» — сервисный аккаунт не нужен, читаем живьём при каждом запросе.
const SPREADSHEET_ID = '1tXo0LULH1IyzeUJEctifvE6iOq9qj2EoV_EcXKbu3LY';

export const SHEETS = {
  STANDARD: 'Штатные малая часть',
  STANDARD_FALLBACK: 'Совместимость камер',
  HS_LAMP: 'HS Применяемость по OE',
  FORD_HANDLE: 'ручки ФОРД',
  VAG: 'РУЧКИ VAG',
  BMW_MERCEDES_DECODER: 'декодеры BMW/MERCEDES',
  // Мастер-таблица с живыми артикулами маркетплейсов (Название товара | артикул Вайлдбериз |
  // артикул Озон | артикул Avito | Артикул продавца). Колонка "Артикул продавца" хранит OE не как
  // чистое значение, а как "<OE> <описание через пробел>" (напр. "284426877R Камера Renault Koleos 2") —
  // см. извлечение первого токена в lib/ai-match.js. Подключается как доп. источник ПОСЛЕ родного
  // сценарного листа и ДО интернет-поиска (уровень 2).
  ALL_PRODUCTS: 'ВСЕ ТОВАРЫ ( думаем)'
};

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

async function fetchSheetRows(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const resp = await fetch(url);

  if (!resp.ok) {
    throw new Error(`Sheets fetch failed for "${sheetName}": ${resp.status}`);
  }

  const text = await resp.text();
  const table = parseCsv(text).filter(r => r.some(cell => cell?.trim()));
  if (table.length < 2) return [];

  const [header, ...rows] = table;
  return rows.map(r => {
    const obj = {};
    header.forEach((h, i) => { obj[h.trim()] = (r[i] ?? '').trim(); });
    return obj;
  });
}

// sheetNames: string[] → { [sheetName]: Array<{ [колонка]: значение }> }
export async function fetchSheets(sheetNames) {
  const unique = [...new Set(sheetNames)];
  const results = await Promise.all(unique.map(fetchSheetRows));
  return unique.reduce((acc, name, i) => { acc[name] = results[i]; return acc; }, {});
}
