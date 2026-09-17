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

// Приёмник событий от MAX (нужен, только если захотите личные уведомления
// о заявках — см. README, раздел "Личные уведомления")
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

// Приём заявок из мини-приложения (кнопка "Оформить заявку")
const MAX_BOT_TOKEN = process.env.MAX_BOT_TOKEN;

// Отправляет сообщение конкретному пользователю MAX от имени бота.
// Официальный метод: https://dev.max.ru/docs-api/methods/POST/messages
async function sendMaxMessage(userId, text) {
  if (!MAX_BOT_TOKEN || !userId) return;
  const url = `https://platform-api2.max.ru/messages?user_id=${encodeURIComponent(userId)}`;
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
      console.warn('MAX API вернул ошибку при отправке сообщения:', res.status, await res.text());
    }
  } catch (e) {
    console.warn('Не удалось отправить сообщение через MAX API:', e.message);
  }
}

app.post('/api/order', async (req, res) => {
  const { name, phone, comment, items, max_user_id } = req.body || {};
  if (!name || !phone) {
    return res.status(400).json({ error: 'Укажите имя и телефон' });
  }

  console.log('Новая заявка:', {
    name,
    phone,
    comment,
    items,
    max_user_id,
    at: new Date().toISOString(),
  });

  const itemsText = (items || [])
    .map((i) => `«${i.name}» — ${new Intl.NumberFormat('ru-RU').format(i.price)} ₽`)
    .join(', ');

  // Подтверждение клиенту — придёт прямо в его чат с ботом «Ликс-Лайн»
  if (max_user_id) {
    await sendMaxMessage(
      max_user_id,
      `Добрый день, ${name}! Мы получили вашу заявку по товару ${itemsText}.\nСкоро свяжемся с вами по номеру ${phone}${comment ? `\nВаш комментарий: ${comment}` : ''}\n\nМожете написать здесь, если хотите что-то уточнить уже сейчас.`
    );
  }

  // Уведомление вам самим — заполните MAX_NOTIFY_USER_ID в .env своим ID
  // (как его получить — см. README), чтобы новые заявки сразу приходили вам
  if (process.env.MAX_NOTIFY_USER_ID) {
    await sendMaxMessage(
      process.env.MAX_NOTIFY_USER_ID,
      `🔔 Новая заявка с сайта!\n${name}, ${phone}\n${itemsText}${comment ? `\nКомментарий: ${comment}` : ''}`
    );
  }

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Мост Ликс-Лайн запущен: http://localhost:${PORT}`);
});
