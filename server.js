// Мост между сайтом lixcompany.ru (OpenCart) и мини-приложениями в MAX/Telegram.
// Забирает каталог с фида на сайте, кэширует его в памяти и отдаёт
// в чистом виде мини-приложению. Также принимает заявки на заказ.
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
    throw new Error('FEED_URL или FEED_TOKEN не заданы in .env');
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

const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN;

// Универсальная функция отправки сообщений в МАКС
async function sendMaxMessage(targetParam, targetId, text) {
  if (!MAX_BOT_TOKEN || !targetId) return;
  const url = `https://max.ru{targetParam}=${encodeURIComponent(targetId)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: MAX_BOT_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.warn(`MAX API ошибка (${targetParam}=${targetId}):`, res.status, await res.text());
    } else {
      console.log(`Сообщение успешно отправлено в ${targetParam}=${targetId}`);
    }
  } catch (e) {
    console.warn(`Исключение при отправке через MAX API:`, e.message);
  }
}

app.post('/api/order', async (req, res) => {
  const { name, phone, comment, items, max_user_id } = req.body || {};
  if (!name || !phone) {
    return res.status(400).json({ error: 'Укажите имя и телефон' });
  }

  console.log('Новая заявка:', { name, phone, comment, items, max_user_id });

  const itemsText = (items || [])
    .map((i) => `«${i.name}» — ${i.price} руб.`)
    .join(', ');

  const commentText = comment ? `\nКомментарий: ${comment}` : '';

  // Текст сообщения без спецсимволов разметки
  const clientText = `Добрый день, ${name}! Заявка принята.\nТовар: ${itemsText}\nТелефон: ${phone}${commentText}`;
  const groupText = `🔔 Новая заявка из МАКС-Магазина!\n\nКлиент: ${name}\nТелефон: ${phone}\nТовар: ${itemsText}${commentText}`;

  // 1. Отправка клиенту
  if (max_user_id) {
    await sendMaxMessage('user_id', max_user_id, clientText);
  }

  // 2. Отправка менеджерам в группу
  await sendMaxMessage('chat_id', MANAGERS_GROUP_ID, groupText);

  // 3. Отправка админу (если задан)
  if (process.env.MAX_NOTIFY_USER_ID) {
    await sendMaxMessage('user_id', process.env.MAX_NOTIFY_USER_ID, groupText);
  }

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Мост Ликс-Лайн запущен на порту: ${PORT}`);
});
