# Батя Рулит — ИИ-бот для подбора камер заднего вида

## Концепция

Бот на платформе Suvvy.ai:
1. Запрашивает у клиента VIN-номер автомобиля
2. Вызывает вебхук → partsapi.ru (VINdecodeOE) → получает OEM-номер камеры заднего вида
3. Ищет аналоги (неоригинальные камеры) в Google Таблице со складскими остатками
4. Отдаёт клиенту список доступных аналогов

## Стек

- **Бот**: Suvvy.ai (LLM-агент, веб-хук + Google Sheets)
- **Вебхук**: Node.js / Vercel Functions
- **Данные по авто**: partsapi.ru
- **Склад аналогов**: Google Sheets

## Структура проекта

```
batya-rulit/
├── api/
│   └── vin.js          # Vercel Function — принимает VIN, возвращает OEM + аналоги
├── lib/
│   ├── partsapi.js     # Обёртка над partsapi.ru
│   └── sheets.js       # Обёртка над Google Sheets API
├── .env.example
├── vercel.json
└── package.json
```

## Переменные окружения

```
PARTSAPI_KEY=       # Ключ от partsapi.ru
GOOGLE_SHEET_ID=    # ID Google Таблицы со складом
GOOGLE_SERVICE_ACCOUNT_JSON=  # JSON сервисного аккаунта Google
WEBHOOK_SECRET=     # Токен для проверки запросов от Suvvy (опционально)
```
