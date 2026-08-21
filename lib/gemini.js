// Общий helper для вызовов Gemini с включённым веб-поиском (google_search grounding).
// Используется и для уровня 2 сверки с таблицей (lib/ai-match.js), и для ИИ-фолбэка
// поиска OE по VIN, когда VIN не распознан в Laximo (lib/ai-vin-lookup.js).
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

// Отправляет prompt в Gemini с google_search, ожидает строгий JSON-ответ в тексте
// (модель иногда оборачивает JSON в markdown-код или добавляет пояснения — вырезаем { ... } регуляркой).
// Возвращает распарсенный объект или null (нет ключа / ошибка сети / не удалось распарсить).
export async function callGeminiSearchJson(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null; // ключ не добавлен в env — фича молча недоступна, не роняем вебхук

  let resp;
  try {
    resp = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }]
      })
    });
  } catch (err) {
    console.error('Gemini request threw:', err);
    return null;
  }

  if (!resp.ok) {
    console.error('Gemini request failed:', resp.status, await resp.text().catch(() => ''));
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
