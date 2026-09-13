import { fetchSheets, SHEETS } from './sheets.js';
import { callGeminiSearchJson } from './gemini.js';

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

// Собирает ВСЕ прямые совпадения OE по листам в rowsBySheet, в порядке, в котором
// они там перечислены (порядок задаёт вызывающая сторона).
function findAllDirectMatches(oe, rowsBySheet) {
  const target = normalizeOe(oe);
  if (!target) return [];

  const matches = [];
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
        matches.push({ sheetName, row, oeKey });
      }
    }
  }
  return matches;
}

// Разные листы могут содержать один и тот же OE, но не у каждого листа заполнены
// колонки маркетплейсов (напр. "ручки ФОРД" сейчас почти пуст, см. lib/sheets.js).
// Без этого приоритет по листам ломался: первый попавшийся лист с OE, но без
// артикулов, "выигрывал" и код даже не заглядывал в лист с реальными данными.
// Поэтому для availability сначала ищем среди ВСЕХ совпадений то, где артикулы реально
// заполнены, и только если таких нет вообще — берём первое совпадение как есть.
function directMatch(oe, rowsBySheet) {
  const matches = findAllDirectMatches(oe, rowsBySheet);
  if (!matches.length) return null;

  const withData = matches.find(m => marketplaceFields(m.row, m.oeKey).length > 0);
  return withData ?? matches[0];
}

// Некоторые ячейки (напр. "Применяемость (модели авто)" в "РУЧКИ VAG") — многоабзацные списки
// на несколько КБ (один узел камеры подходит на десяток разных моделей с годами/комплектациями).
// Без обрезки это раздувает и ответ вебхука (Savvy отдаёт "Длина ответа превышает максимально
// допустимую"), и промпт для Gemini (лишний размер запроса = медленнее и дороже).
function truncate(str, max) {
  const s = String(str);
  return s.length > max ? s.slice(0, max).trim() + '…' : s;
}

const KEY_MAX = 40; // на имя колонки — в некоторых листах встречаются кривые заголовки
                     // (в лист влита ячейка со списком десятков совместимых моделей вместо короткого имени)
const FIELD_MAX = 200; // на одно значение поля в клиентском message/row
const DETAILS_MAX = 400; // на весь "details" целиком, как жёсткий предохранитель
const MESSAGE_MAX = 900; // финальный хард-кап на message — что бы ни было в таблице, Savvy не отклонит по длине
const FIELD_MAX_PROMPT = 80; // на одно поле в дампе для Gemini — там нужен только ориентир, не полный текст

function formatRow(row, oeKey, fieldMax = FIELD_MAX) {
  const details = Object.entries(row)
    .filter(([k, v]) => k !== oeKey && v)
    .map(([k, v]) => `${truncate(k, KEY_MAX)}: ${truncate(v, fieldMax)}`)
    .join('; ');
  return truncate(details, DETAILS_MAX);
}

// Клиенту нужны только реальные ссылки/артикулы наших магазинов — не служебные колонки листа
// (применяемость, модель камеры, платформа и т.п. — это внутренний ориентир, не для клиента).
// "Ссылка ВБ"/"Ссылка Озон" исключены намеренно: в листе "Товары с ссылками" это Excel-гиперссылки
// с текстом-плейсхолдером "Ссылка" поверх реального адреса — CSV-экспорт видит только этот текст,
// не сам URL. Реальный адрес собирается ниже из числового ID в колонках "Карточка Озон"/"Карточка
// Вайлдбериз" по известному формату ссылок маркетплейсов.
// Каждый лейбл пробует свои варианты колонок по порядку, первый найденный с данными побеждает —
// это не даёт "Ссылка Озон"/"Ссылка ВБ" (плейсхолдер, см. выше) просочиться вторым дублем после
// того как уже найдена настоящая ссылка из "Карточка Озон"/"Карточка Вайлдбериз".
const MARKETPLACE_SOURCES = [
  {
    label: 'Озон',
    patterns: [
      { re: /^Карточка\s*Озон$/i, buildUrl: id => `https://www.ozon.ru/product/${id}/` },
      { re: /озон/i, exclude: /^Ссылка/i }
    ]
  },
  {
    label: 'Wildberries',
    patterns: [
      { re: /^Карточка\s*Вайлдбериз$/i, buildUrl: id => `https://www.wildberries.ru/catalog/${id}/detail.aspx` },
      { re: /вайлдбериз|^вб$/i, exclude: /^Ссылка/i }
    ]
  },
  { label: 'Яндекс.Маркет', patterns: [{ re: /яндекс|^ям$/i }] },
  { label: 'Avito', patterns: [{ re: /avito|авито/i }] },
  { label: 'Интернет-магазин', patterns: [{ re: /интер\s*маг/i }] }
];

// Некоторые листы (напр. "РУЧКИ VAG") хранят ссылку без схемы ("ozon.ru/product/123/") —
// добавляем https://, иначе клиент получит нередактируемый неполный адрес.
function normalizeLink(value) {
  const v = value.trim();
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

function marketplaceFields(row, oeKey) {
  const fields = [];
  for (const { label, patterns } of MARKETPLACE_SOURCES) {
    for (const { re, exclude, buildUrl } of patterns) {
      const key = Object.keys(row).find(k => k !== oeKey && re.test(k) && !(exclude && exclude.test(k)));
      if (!key || !row[key]) continue;
      const value = buildUrl ? buildUrl(row[key].trim()) : normalizeLink(row[key]);
      fields.push(`${label}: ${truncate(value, FIELD_MAX)}`);
      break;
    }
  }
  return fields;
}

// Та же обрезка (ключей и значений) для объекта row, который целиком уходит в JSON-ответ вебхука —
// иначе даже без message общий размер ответа может превысить лимит Savvy.
function truncateRow(row, fieldMax = FIELD_MAX) {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [truncate(k, KEY_MAX), truncate(v, fieldMax)])
  );
}

async function findCrossReferenceMatch(oe, rowsBySheet, deadline) {
  const tableDump = Object.entries(rowsBySheet)
    .map(([sheetName, rows]) => {
      const lines = rows.map(row => {
        const oeKey = findOeKey(row);
        return `- ${oeKey ? row[oeKey] : '?'} | ${formatRow(row, oeKey, FIELD_MAX_PROMPT)}`;
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

  // Остаток общего тайм-бюджета запроса (deadline проброшен от api/*.js через matchOemAgainstSheets) —
  // не фиксированные 15с, а сколько реально осталось: если VIN-lookup отработал быстро, здесь
  // будет намного больше времени на реальный поиск, а не гарантированный ранний обрыв.
  // Если времени почти не осталось — не тратим его на запрос, который почти наверняка не успеет.
  const timeoutMs = deadline ? Math.max(0, deadline - Date.now()) : 15000;
  if (timeoutMs < 3000) return null;

  const parsed = await callGeminiSearchJson(prompt, { timeoutMs });
  if (!parsed?.found || !parsed.matched_oe) return null;

  const direct = directMatch(parsed.matched_oe, rowsBySheet);
  if (!direct) return null;
  return { ...direct, crossReferenceUsed: parsed.cross_reference_used };
}

function buildResult({ source, row, oeKey, crossReferenceUsed }) {
  // "Артикул продавца" хранит "<OE> <описание>" — для отображения нужен только чистый код
  const matchedOe = SELLER_ARTICLE_RE.test(oeKey) ? row[oeKey].trim().split(/\s+/)[0] : row[oeKey];

  // Клиенту — только реальные артикулы маркетплейсов, не служебные колонки листа
  // (применяемость/модель камеры/платформа — внутренний ориентир, не для клиента).
  const market = marketplaceFields(row, oeKey);
  let message = market.length
    ? `Деталь найдена, OE ${matchedOe}. ${market.join('; ')}`
    : `Деталь определена в каталоге (OE ${matchedOe}), но наши артикулы для этого варианта пока не добавлены в таблицу.`;

  if (source === 'cross_reference') {
    message = `[Совпадение найдено через кросс-номер ${crossReferenceUsed}, не напрямую по оригинальному OE] ${message}`;
  }

  return { found: true, source, matchedOe, row: truncateRow(row), message: truncate(message, MESSAGE_MAX) };
}

// oe: строка OE-номера, найденного через ИИ по VIN
// sheetNames: имена листов для проверки — по решению заказчика (13.09.2026) сверка идёт по ВСЕМ
//   товарным листам сразу (см. ALL_AVAILABILITY_SHEETS в lib/sheets.js), не только по листу сценария
// deadline (опционально) — сквозной тайм-бюджет всего запроса, см. lib/ai-vin-lookup.js и lib/gemini.js.
export async function matchOemAgainstSheets({ oe, sheetNames, deadline }) {
  if (!oe) {
    return { found: false, source: 'none', message: 'OE-номер не определён — сверка с таблицей наличия невозможна.' };
  }

  const rowsBySheet = await fetchSheets(sheetNames);

  const level1 = directMatch(oe, rowsBySheet);
  if (level1) {
    return buildResult({ source: 'direct', row: level1.row, oeKey: level1.oeKey });
  }

  const level2 = await findCrossReferenceMatch(oe, rowsBySheet, deadline);
  if (level2) {
    return buildResult({
      source: 'cross_reference',
      row: level2.row,
      oeKey: level2.oeKey,
      crossReferenceUsed: level2.crossReferenceUsed
    });
  }

  return {
    found: false,
    source: 'none',
    message: 'В таблице наличия совпадений не найдено — ни напрямую по OE, ни по кросс-номерам аналогов.'
  };
}

// Лист "РУЧКИ VAG" на одну ручку багажника хранит сразу 3 готовых товарных варианта камеры —
// под Android (нештатную) магнитолу, под штатную со статическими парковочными линиями и под
// штатную с динамическими (следящими за рулём). По решению заказчика (13.09.2026) какой именно
// вариант предложить клиенту определяет ИИ в промпте Savvy по точной модели его магнитолы —
// код здесь только достаёт все 3 варианта как есть, без попытки угадать правило самостоятельно
// (та же логика уже применялась к чипу видеосигнала ВАГ 28.07.2026 и декодеру BMW/Mercedes).
function findVagRow(handleOe, rowsBySheet) {
  const rows = rowsBySheet[SHEETS.VAG] ?? [];
  const target = normalizeOe(handleOe);
  return rows.find(r => normalizeOe(r['OE Артикул']) === target) ?? null;
}

function variantLinks(row, ozonKey, wbKey) {
  const links = [row[ozonKey], row[wbKey]].filter(v => v && v.trim()).map(normalizeLink);
  return links.length ? links : null;
}

export async function findVagCameraVariants({ handleOe, deadline }) {
  if (!handleOe) return null;
  const rowsBySheet = await fetchSheets([SHEETS.VAG]);
  const row = findVagRow(handleOe, rowsBySheet);
  if (!row) return null;

  return {
    cameraModel: row['Модель камеры'] || null,
    platform: row['Платформа'] || null,
    android: variantLinks(row, 'Озон АНДРОИД', 'ВБ АНДРОИД'),
    static: variantLinks(row, 'Озон СТАТИЧНЫЕ', 'ВБ СТАТИЧНЫЕ'),
    dynamic: variantLinks(row, 'Озон ДИНАМИЧ', 'ВБ ДИНАМИЧ')
  };
}
