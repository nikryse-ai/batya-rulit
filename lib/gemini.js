// Общий helper для вызовов Gemini с включённым веб-поиском (google_search grounding).
// Используется и для уровня 2 сверки с таблицей (lib/ai-match.js), и для ИИ-фолбэка
// поиска OE по VIN, когда VIN не распознан в Laximo (lib/ai-vin-lookup.js).
// Зафиксировано на конкретной версии, а не на алиасе "gemini-flash-latest" — алиас переключился
// на новую модель (gemini-3.7-flash), которая на момент проверки (29.08.2026) стабильно отдаёт
// 503 "high demand". gemini-3.6-flash с тем же ключом и google_search работает надёжно.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 503 "high demand" — временная перегрузка модели на стороне Google, сам ответ
// прямо советует "please try again later". Ретраим только этот код: 401/403 (ключ/доступ)
// и 429 (квота — раньше решалось только биллингом, не повторными запросами) повторять бессмысленно.
const RETRY_STATUS = 503;
const RETRY_DELAYS_MS = [1500, 3000];

// Отправляет prompt в Gemini с google_search, ожидает строгий JSON-ответ в тексте
// (модель иногда оборачивает JSON в markdown-код или добавляет пояснения — вырезаем { ... } регуляркой).
// Возвращает распарсенный объект или null (нет ключа / ошибка сети / не удалось распарсить / таймаут).
//
// timeoutMs (опционально) — жёсткий бюджет времени на весь вызов, включая ретраи. Без него функция
// может выполняться неограниченно долго (реальный случай 04.09.2026: связка из 2 последовательных
// вызовов Gemini заняла 60.8с и упёрлась в maxDuration Vercel — клиент получил пустой 504 вместо
// ответа). С таймаутом при исчерпании бюджета вызов просто возвращает null — вызывающий код (уже
// умеет обрабатывать null как "не найдено") отдаёт клиенту осмысленное сообщение вместо обрыва связи.
export async function callGeminiSearchJson(prompt, { timeoutMs } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null; // ключ не добавлен в env — фича молча недоступна, не роняем вебхук

  const deadline = timeoutMs ? Date.now() + timeoutMs : null;

  let resp;
  for (let attempt = 0; ; attempt++) {
    const timeLeft = deadline ? deadline - Date.now() : Infinity;
    if (timeLeft <= 0) {
      console.error('Gemini request skipped: timeout budget exhausted');
      return null;
    }

    const controller = deadline ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeLeft) : null;
    try {
      resp = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }]
        }),
        signal: controller?.signal
      });
    } catch (err) {
      console.error('Gemini request threw (or timed out):', err);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (resp.ok) break;

    const bodyText = await resp.text().catch(() => '');
    const timeLeftAfter = deadline ? deadline - Date.now() : Infinity;
    if (resp.status === RETRY_STATUS && attempt < RETRY_DELAYS_MS.length && RETRY_DELAYS_MS[attempt] < timeLeftAfter) {
      console.error(`Gemini request failed (attempt ${attempt + 1}):`, resp.status, bodyText, '- retrying');
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    console.error('Gemini request failed:', resp.status, bodyText);
    return null;
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}
