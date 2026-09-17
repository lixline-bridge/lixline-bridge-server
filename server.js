// Мост между сайтом lixcompany.ru (OpenCart) и мини-приложениями в MAX/Telegram.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FEED_URL = process.env.FEED_URL;
const FEED_TOKEN = process.env.FEED_TOKEN;
const CACHE_TTL = (Number(process.env.CACHE_TTL_SECONDS) || 300) * 1000;

// ID вашей группы в МАКС для менеджеров
const MANAGERS_GROUP_ID = "-79068581102977";

let cache = { data: null, fetchedAt: 0 };

async function getCatalog() {
  const isFresh = cache.data && Date.now() - cache.fetchedAt < CACHE_TTL;
  if (isFresh) return cache.data;

  if (!FEED_URL || !FEED_TOKEN) {
    throw new Error('FEED_URL или FEED_TOKEN не заданы в .env');
  }

  const url = `${FEED_URL}?token=${encodeURIComponent(FEED_TOKEN)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Фид вернул статус ${res.status}`);

  const data = await res.json();
  cache = { data, fetchedAt: Date.now() };
  return data;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/webhook', (req, res) => {
  console.log('MAX update:', JSON.stringify(req.body));
  res.json({ ok: true });
});

app.get('/api/categories', async (req, res) => {
  try {
    const { categories } = await getCatalog();
    res.json(categories);
  } catch (e) {
    res.status(502).json({ error: 'Каталог временно недоступен', details: e.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const { products } = await getCatalog();
    const categoryId = req.query.category ? Number(req.query.category) : null;
    const result = categoryId
      ? products.filter((p) => p.category_ids.includes(categoryId))
      : products;
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'Каталог временно недоступен', details: e.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const { products } = await getCatalog();
    const product = products.find((p) => p.id === Number(req.params.id));
    if (!product) return res.status(404).json({ error: 'Товар не найден' });
    res.json(product);
  } catch (e) {
    res.status(502).json({ error: 'Каталог временно недоступен', details: e.message });
  }
});

// Забираем токен и очищаем его от возможных случайных пробелов
const rawToken = process.env.MAX_BOT_TOKEN || '';
const MAX_BOT_TOKEN = rawToken.trim();

async function sendMaxMessage(targetParam, targetId, textContent) {
  if (!MAX_BOT_TOKEN || !targetId) return;

  const url = `https://max.ru{targetParam}=${encodeURIComponent(targetId)}`;

  // Пробуем стандартный заголовок. Если прокси требует "Bearer ", подставим его.
  const authHeader = MAX_BOT_TOKEN.startsWith('Bearer ') ? MAX_BOT_TOKEN : `Bearer ${MAX_BOT_TOKEN}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: textContent
      })
    });
    
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`MAX API ошибка отправки с Bearer (${targetParam}=${targetId}):`, res.status, errText);
      
      // Запасной вариант: если с Bearer не вышло, пробуем отправить токен чистым текстом
      if (res.status === 400 || res.status === 401) {
        console.log("Пробуем альтернативный формат авторизации без Bearer...");
        const retryRes = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': MAX_BOT_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ text: textContent })
        });
        if (!retryRes.ok) {
          console.warn(`Финальная ошибка без Bearer:`, retryRes.status, await retryRes.text());
        } else {
          console.log(`Успешно отправлено альтернативным методом в ${targetParam}=${targetId}`);
        }
      }
    } else {
      console.log(`Сообщение успешно ушло в чат ${targetParam}=${targetId}`);
    }
  } catch (e) {
    console.warn(`Исключение при работе с МАКС API:`, e.message);
  }
}

app.post('/api/order', async (req, res) => {
  const { name, phone, comment, items, max_user_id } = req.body || {};
  if (!name || !phone) {
    return res.status(400).json({ error: 'Укажите имя и телефон' });
  }

  console.log('Обработка новой заявки:', { name, phone, comment, items, max_user_id });

  const itemsText = (items || [])
    .map((i) => `«${i.name}» — ${i.price} руб.`)
    .join(', ');

  const commentText = comment ? `\nКомментарий: ${comment}` : '';

  const clientText = `Добрый день, ${name}! Ваша заявка принята.\nТовар: ${itemsText}\nТелефон: ${phone}${commentText}`;
  const groupText = `🔔 Новая заявка из МАКС-Магазина!\nКлиент: ${name}\nТелефон: ${phone}\nТовар: ${itemsText}${commentText}`;

  if (max_user_id) {
    await sendMaxMessage('user_id', max_user_id, clientText);
  }

  await sendMaxMessage('chat_id', MANAGERS_GROUP_ID, groupText);

  if (process.env.MAX_NOTIFY_USER_ID) {
    await sendMaxMessage('user_id', process.env.MAX_NOTIFY_USER_ID, groupText);
  }

  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error("Глобальная ошибка сервера:", err.stack);
  res.status(500).json({ error: "Внутренняя ошибка сервера" });
});

app.listen(PORT, () => {
  console.log(`Мост Ликс-Лайн успешно запущен на порту: ${PORT}`);
});
