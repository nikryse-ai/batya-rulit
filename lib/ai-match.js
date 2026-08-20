import { fetchSheets } from './sheets.js';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

// Разные листы называют колонку с OE по-разному: "OE Артикул", "OE Part Number",
// "OE Number", а в мастер-таблице "ВСЕ ТОВАРЫ" это вообще "Артикул продавца".
const OE_COLUMN_PATTERNS = [/^OE\b/i, /OE\s*Артикул/i, /OE\s*Part\s*Number/i, /OE\s*Number/i, /Артикул\s*продавца/i];

function findOeKey(row) {
  const keys = Object.keys(row);
  for (const pattern of OE_COLUMN_PATTERNS) {
    const found = keys.find(k => pattern.test(k));
    if (found) return found;
  }
  return keys.find(k => /OE/i.test(k)) ?? null;
}

function normalizeOe(str) {
  return (str || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// В "ВСЕ ТОВАРЫ" колонка "Артикул продавца" хранит не чистый OE, а "<OE> <описание>"
// (напр. "284426877R Камера Renault Koleos 2 (2016-н.в.)") — нужный код всегда первый токен до пробела.
const SELLER_ARTICLE_RE = /Артикул\s*продавца/i;

// Ищет OE напрямую по листам в rowsBySheet, в порядке, в котором они там перечислены
// (порядок задаёт вызывающая сторона — приоритет отдаётся листу с реальными живыми артикулами).
function directMatch(oe, rowsBySheet) {
  const target = normalizeOe(oe);
  if (!target) return null;

  for (const [sheetName, rows] of Object.entries(rowsBySheet)) {
    for (const row of rows) {
      const oeKey = findOeKey(row);
      if (!oeKey || !row[oeKey]) continue;

      const raw = row[oeKey];
      const candidates = SELLER_ARTICLE_RE.test(oeKey)
        // "Артикул продавца": берём только первый токен (сам OE), остальное — описание товара
        ? [normalizeOe(raw.trim().split(/\s+/)[0])]
        // остальные листы: OE — вся ячейка целиком, иногда несколько через "/" или ","
        : raw.split(/[\/,]/).map(normalizeOe);

      if (candidates.includes(target)) {
        return { sheetName, row, oeKey };
      }
    }
  }
  return null;
}

function formatRow(row, oeKey) {
  return Object.entries(row)
    .filter(([k, v]) => k !== oeKey && v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
}

async function findCrossReferenceMatch(oe, rowsBySheet) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null; // ключ ещё не добавлен в env — уровень 2 молча недоступен

  const tableDump = Object.entries(rowsBySheet)
    .map(([sheetName, rows]) => {
      const lines = rows.map(row => {
        const oeKey = findOeKey(row);
        return `- ${oeKey ? row[oeKey] : '?'} | ${formatRow(row, oeKey)}`;
      });
      return `### Лист "${sheetName}"\n${lines.join('\n') || '(пусто)'}`;
    })
    .join('\n\n');

  const prompt = `Дан оригинальный OEM-номер автозапчасти: "${oe}".
Найди в интернете известные неоригинальные / кросс-номера (взаимозаменяемые аналоги от известных производителей автозапчастей) для этого OEM-номера.
Затем сравни каждый найденный кросс-номер со списком строк из нашей таблицы наличия ниже (сравнивай только сами номера — игнорируй пробелы, дефисы, регистр).
Если нашёл совпадение — ответь СТРОГО в формате JSON, без пояснений и без markdown-разметки:
{"found": true, "matched_oe": "<номер из нашей таблицы, который совпал>", "cross_reference_used": "<кросс-номер, через который нашли совпадение>"}
Если совпадений нет — ответь: {"found": false}

Таблица:
${tableDump}`;

  const resp = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }]
    })
  });

  if (!resp.ok) {
    console.error('Gemini request failed:', resp.status, await resp.text().catch(() => ''));
    return null;
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
  if (!parsed.found || !parsed.matched_oe) return null;

  const direct = directMatch(parsed.matched_oe, rowsBySheet);
  if (!direct) return null;
  return { ...direct, crossReferenceUsed: parsed.cross_reference_used };
}

function buildResult({ source, row, oeKey, resultKind, crossReferenceUsed }) {
  // "Артикул продавца" хранит "<OE> <описание>" — для отображения нужен только чистый код
  const matchedOe = SELLER_ARTICLE_RE.test(oeKey) ? row[oeKey].trim().split(/\s+/)[0] : row[oeKey];
  const details = formatRow(row, oeKey);
  let message;

  if (resultKind === 'decoder') {
    const decoderKey = Object.keys(row).find(k => /decoder/i.test(k));
    const raw = decoderKey ? row[decoderKey] : '';
    const hasDecoder = /да|yes/i.test(raw) ? true : /нет|no/i.test(raw) ? false : null;
    message = hasDecoder === null
      ? `Найдена запись по магнитоле (${matchedOe}), но наличие декодера видеосигнала не указано. ${details}`
      : hasDecoder
        ? `Декодер видеосигнала для этой магнитолы (${matchedOe}) есть. ${details}`
        : `Декодер видеосигнала для этой магнитолы (${matchedOe}) отсутствует. ${details}`;
  } else {
    message = `Найдено совпадение в таблице наличия (${matchedOe}). ${details}`;
  }

  if (source === 'cross_reference') {
    message = `[Совпадение найдено через кросс-номер ${crossReferenceUsed}, не напрямую по оригинальному OE] ${message}`;
  }

  return { found: true, source, matchedOe, row, message };
}

// oe: строка OE-номера, найденного через Laximo
// sheetNames: имена листов для проверки (родной сценарный лист + опциональный фолбэк),
//   в порядке приоритета — первый найденный матч побеждает
// resultKind: 'availability' (маркетплейсы) | 'decoder' (Да/Нет по декодеру видеосигнала BMW/Mercedes)
export async function matchOemAgainstSheets({ oe, sheetNames, resultKind = 'availability' }) {
  if (!oe) {
    return { found: false, source: 'none', message: 'OE-номер не определён — сверка с таблицей наличия невозможна.' };
  }

  const rowsBySheet = await fetchSheets(sheetNames);

  const level1 = directMatch(oe, rowsBySheet);
  if (level1) {
    return buildResult({ source: 'direct', row: level1.row, oeKey: level1.oeKey, resultKind });
  }

  const level2 = await findCrossReferenceMatch(oe, rowsBySheet);
  if (level2) {
    return buildResult({
      source: 'cross_reference',
      row: level2.row,
      oeKey: level2.oeKey,
      resultKind,
      crossReferenceUsed: level2.crossReferenceUsed
    });
  }

  return {
    found: false,
    source: 'none',
    message: 'В таблице наличия совпадений не найдено — ни напрямую по OE, ни по кросс-номерам аналогов.'
  };
}
