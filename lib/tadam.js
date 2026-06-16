const BASE_URL = 'https://v2.sel.tadam.ai';
const WORKER_ID = process.env.TADAM_WORKER_ID;

export async function createOrder(vin) {
  const res = await fetch(`${BASE_URL}/order/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vins: [vin.toUpperCase()], workerId: WORKER_ID })
  });
  const data = await res.json();
  if (data.status !== 'ok' || !data.body?.id) {
    throw new Error(`Ta-Dam order/create failed: ${JSON.stringify(data)}`);
  }
  return data.body.id;
}

export async function searchCamera(orderId) {
  const params = new URLSearchParams({
    workerId: WORKER_ID,
    orderId,
    query: 'камера заднего вида',
    take: '4',
    waitTree: 'true'
  });
  const res = await fetch(`${BASE_URL}/parts/catalog/search/with-schema?${params}`);
  const data = await res.json();
  if (data.status !== 'ok') {
    throw new Error(`Ta-Dam search failed: ${JSON.stringify(data)}`);
  }

  const results = [];
  for (const item of data.body?.items ?? []) {
    for (const pos of item.schema?.positions ?? []) {
      if (!pos.isFound) continue;
      for (const part of pos.parts ?? []) {
        for (const article of part.articles ?? []) {
          if (article.formattedValue) {
            results.push({
              oem: article.formattedValue,
              oem_vendor: article.formattedVendor ?? article.vendor ?? '',
              part_name: part.name ?? pos.name ?? ''
            });
          }
        }
      }
    }
  }
  return results;
}
