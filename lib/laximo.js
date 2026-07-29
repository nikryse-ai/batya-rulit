const BASE_URL = 'https://ws.laximo.ru/restApi/v1';

function authHeader() {
  const pair = `${process.env.LAXIMO_LOGIN}:${process.env.LAXIMO_PASSWORD}`;
  const b64 = Buffer.from(pair, 'utf8').toString('base64');
  return `Basic ${b64}`;
}

async function laximoPost(path, params) {
  const query = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${path}?${query}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader() }
  });

  const text = await resp.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!resp.ok) {
    const err = new Error(`Laximo ${path} failed: ${resp.status}`);
    err.status = resp.status;
    err.body = body;
    throw err;
  }

  return body;
}

// VIN → массив совпадений { catalog, brand, name, vehicleId, ssd, attributes }
export async function findVehicle(identString) {
  return laximoPost('/findVehicle', { identString });
}

// Полнотекстовый поиск деталей по автомобилю → [{ oem, name }] или { oem, name } если один результат
export async function searchVehicleDetails(catalog, ssd, vehicleId, query) {
  const result = await laximoPost('/searchVehicleDetails', { catalog, ssd, vehicleId, query });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

// Пробует несколько формулировок запроса по очереди, берёт первый результат,
// прошедший фильтр matchRe. Нужен т.к. один и тот же термин ("lamp" vs "light",
// "radio" vs "head unit") у разных марок находит разные (или неверные) детали.
export async function searchWithFallback(catalog, ssd, vehicleId, queries, matchRe, excludeRe = null) {
  for (const q of queries) {
    const results = await searchVehicleDetails(catalog, ssd, vehicleId, q);
    const match = results.find(r => matchRe.test(r.name) && (!excludeRe || !excludeRe.test(r.name)));
    if (match) return match;
  }
  return null;
}
