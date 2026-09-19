// Мост между сайтом lixcompany.ru (OpenCart) и мини-приложениями в MAX/Telegram.

// ВАЖНО: этот флаг отключает проверку SSL-сертификатов для запросов,
// которые делает сервер. Он нужен, потому что API MAX использует
// российский сертификат Минцифры, которого нет в доверенных
// сертификатах на зарубежных серверах вроде Render. Это рабочий, но не
// самый безопасный обход — если захотите, потом заменим на добавление
// самого сертификата в доверенные (надёжнее, но чуть больше работы).
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

// ID вашей группы в MAX для менеджеров — куда присылать уведомления о заявках
const MANAGERS_GROUP_ID = '-79068581102977';

// Собственный публичный адрес этого сервера — нужен, чтобы подписаться
// на события MAX (нажатия кнопок) при запуске
const OWN_BASE_URL = 'https://lixline-bridge-server.onrender.com';

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
const MAX_BOT_TOKEN = (process.env.MAX_BOT_TOKEN || '').trim();

/**
 * Отправляет сообщение через официальный MAX Bot API, опционально с кнопками.
 * Документация: https://dev.max.ru/docs-api/methods/POST/messages
 */
async function sendMaxMessage(targetParam, targetId, text, buttons) {
  if (!MAX_BOT_TOKEN || !targetId) return;

  const url = `https://platform-api2.max.ru/messages?${targetParam}=${encodeURIComponent(targetId)}`;

  const body = { text };
  if (buttons) {
    body.attachments = [
      {
        type: 'inline_keyboard',
        payload: { buttons },
      },
    ];
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: MAX_BOT_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.warn(`MAX API ошибка (${targetParam}=${targetId}):`, res.status, await res.text());
    } else {
      console.log(`Сообщение успешно отправлено (${targetParam}=${targetId})`);
    }
  } catch (e) {
    console.warn('Исключение при обращении к MAX API:', e.message);
  }
}

/** Подтверждает нажатие кнопки: убирает "часики" у клиента и может
 *  заменить текст/кнопки исходного сообщения — см. POST /answers */
async function answerCallback(callbackId, { notification, message } = {}) {
  if (!MAX_BOT_TOKEN || !callbackId) return;
  const url = `https://platform-api2.max.ru/answers?callback_id=${encodeURIComponent(callbackId)}`;
  const body = {};
  if (notification) body.notification = notification;
  if (message) body.message = message;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: MAX_BOT_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn('Ошибка answerCallback:', res.status, await res.text());
    }
  } catch (e) {
    console.warn('Не удалось подтвердить нажатие кнопки:', e.message);
  }
}

/** Регистрирует наш /webhook как получателя событий MAX (нажатия кнопок и т.д.) */
async function registerWebhook() {
  if (!MAX_BOT_TOKEN) return;
  try {
    const res = await fetch('https://platform-api2.max.ru/subscriptions', {
      method: 'POST',
      headers: {
        Authorization: MAX_BOT_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: `${OWN_BASE_URL}/webhook`,
        update_types: ['message_callback', 'message_created'],
      }),
    });
    if (res.ok) {
      console.log('Подписка на события MAX оформлена:', `${OWN_BASE_URL}/webhook`);
    } else {
      console.warn('Не удалось оформить подписку на события MAX:', res.status, await res.text());
    }
  } catch (e) {
    console.warn('Исключение при подписке на события MAX:', e.message);
  }
}

// Чтобы не обработать одно и то же нажатие дважды, если MAX по какой-то
// причине пришлёт событие повторно
const processedCallbacks = new Set();

// Храним текст последнего сообщения о заказе для каждого клиента, чтобы
// при нажатии кнопки дописать к нему подтверждение, а не стереть заказ
const pendingOrderText = new Map();

// Приём событий от MAX — сюда прилетают нажатия кнопок
app.post('/webhook', async (req, res) => {
  const update = req.body || {};
  console.log('MAX update:', JSON.stringify(update));

  // Обычное текстовое сообщение от клиента (не нажатие кнопки) —
  // пересылаем его в группу менеджеров, чтобы никто не потерялся
  if (update.update_type === 'message_created' && update.message) {
    const sender = update.message.sender;
    const text = update.message.body && update.message.body.text;

    // не реагируем на сообщения самого бота (иначе будет эхо по кругу)
    if (sender && !sender.is_bot) {
      const name = sender.name || sender.first_name || 'Клиент';
      const bodyText = text || '(вложение без текста)';

      if (MANAGERS_GROUP_ID) {
        await sendMaxMessage(
          'chat_id',
          MANAGERS_GROUP_ID,
          `✉️ ${name} (ID ${sender.user_id}) написал(а):\n${bodyText}`
        );
      }
    }
  }

  if (update.update_type === 'message_callback' && update.callback) {
    const { callback_id, payload, user } = update.callback;

    if (processedCallbacks.has(callback_id)) {
      return res.json({ ok: true });
    }
    processedCallbacks.add(callback_id);

    const name = (user && (user.name || user.first_name)) || 'Клиент';

    let choiceText = 'сделал выбор';
    let confirmLine = 'Спасибо за ответ!';
    if (payload === 'call_yes') {
      choiceText = '✅ согласен на звонок';
      confirmLine = '✅ Хорошо, мы позвоним вам по указанному номеру в ближайшее время.';
    }
    if (payload === 'call_no') {
      choiceText = '💬 просит написать здесь, в чат с ботом';
      confirmLine = '💬 Хорошо, продолжим здесь — напишите, если хотите что-то уточнить уже сейчас.';
    }

    // Дописываем подтверждение к исходному тексту заказа, а не стираем его —
    // у клиента должна остаться видна вся история, что именно он заказал
    const userId = user ? user.user_id : null;
    const originalOrderText = userId ? pendingOrderText.get(userId) : null;
    const updatedText = originalOrderText ? `${originalOrderText}\n\n${confirmLine}` : confirmLine;
    if (userId) pendingOrderText.delete(userId);

    // меняем исходное сообщение клиенту: кнопки исчезают, появляется
    // явное подтверждение выбора — это и есть видимый отклик на нажатие
    await answerCallback(callback_id, {
      message: { text: updatedText, attachments: [] },
    });

    if (MANAGERS_GROUP_ID) {
      await sendMaxMessage(
        'chat_id',
        MANAGERS_GROUP_ID,
        `👉 ${name} (ID ${user ? user.user_id : '—'}) ${choiceText}`
      );
    }
  }

  res.json({ ok: true });
});

// Пароль для "пульта" — простой веб-страницы, с которой можно вручную
// написать конкретному клиенту. Впишите свой пароль в переменную
// окружения ADMIN_SECRET в Render.
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();

app.post('/api/reply', async (req, res) => {
  const { secret, user_id, text } = req.body || {};
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Неверный пароль' });
  }
  if (!user_id || !text) {
    return res.status(400).json({ error: 'Укажите ID клиента и текст сообщения' });
  }
  await sendMaxMessage('user_id', user_id, text);

  // сохраняем копию в группе менеджеров — так у вас остаётся история,
  // что именно и кому вы отвечали
  if (MANAGERS_GROUP_ID) {
    await sendMaxMessage('chat_id', MANAGERS_GROUP_ID, `📤 Вы ответили (ID ${user_id}):\n${text}`);
  }

  res.json({ ok: true });
});

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
  const commentText = comment ? `\nВаш комментарий: ${comment}` : '';

  // Подтверждение клиенту — придёт прямо в его чат с ботом «Ликс-Лайн»,
  // с кнопками "звоните" / "лучше напишите"
  if (max_user_id) {
    const orderText = `Добрый день, ${name}! Мы получили вашу заявку по товару ${itemsText}.\nВаш номер телефона: ${phone}${commentText}`;
    pendingOrderText.set(max_user_id, orderText);

    await sendMaxMessage(
      'user_id',
      max_user_id,
      `${orderText}\n\nКак вам удобнее — позвонить или продолжить здесь, в переписке?`,
      [
        [
          { type: 'callback', text: 'Да, позвоните', payload: 'call_yes' },
          { type: 'callback', text: 'Переписка в чате', payload: 'call_no' },
        ],
      ]
    );
  }

  // Уведомление в группу менеджеров
  if (MANAGERS_GROUP_ID) {
    await sendMaxMessage(
      'chat_id',
      MANAGERS_GROUP_ID,
      `🔔 Новая заявка! (ID ${max_user_id || '—'})\n${name}, ${phone}\n${itemsText}${commentText}`
    );
  }

  // Личное уведомление вам (необязательно, если заполнено в .env)
  if (process.env.MAX_NOTIFY_USER_ID) {
    await sendMaxMessage(
      'user_id',
      process.env.MAX_NOTIFY_USER_ID,
      `🔔 Новая заявка! (ID ${max_user_id || '—'})\n${name}, ${phone}\n${itemsText}${commentText}`
    );
  }

  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error('Глобальная ошибка сервера:', err.stack);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`Мост Ликс-Лайн запущен на порту ${PORT}`);
  registerWebhook();
});
