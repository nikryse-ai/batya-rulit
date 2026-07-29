import { findVehicle } from '../lib/laximo.js';

export default async function handler(req, res) {
  const { vin } = req.body ?? {};
  if (!vin) return res.status(400).json({ error: 'vin required' });

  try {
    const vehicles = await findVehicle(vin);
    return res.json({ vehicles });
  } catch (err) {
    console.error(err);
    return res.status(err.status || 500).json({ error: err.message, body: err.body });
  }
}
