import { google } from 'googleapis';

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
});

export async function findByOem(oem) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `${process.env.SHEET_NAME || 'Лист1'}!A:G`
  });

  const [, ...rows] = res.data.values ?? [];
  return rows
    .filter(row => row[0]?.trim().toUpperCase() === oem.toUpperCase())
    .map(row => ({
      oem:      row[0]?.trim().toUpperCase(),
      article:  row[1]?.trim(),
      brand:    row[2]?.trim(),
      name:     row[3]?.trim(),
      price:    row[4]?.trim(),
      link:     row[5]?.trim(),
      in_stock: row[6]?.trim().toUpperCase() === 'TRUE'
    }));
}
