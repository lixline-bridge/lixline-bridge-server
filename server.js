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

// ID группы в Telegram для менеджеров — заявки из Telegram пойдут сюда,
// а не в группу MAX. Заполните в Render переменную TELEGRAM_MANAGERS_GROUP_ID,
// как только создадите такую группу (см. инструкцию).
const TELEGRAM_MANAGERS_GROUP_ID = (process.env.TELEGRAM_MANAGERS_GROUP_ID || '').trim();

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
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();

/**
 * Отправляет сообщение через Telegram Bot API, опционально с кнопками.
 * Документация: https://core.telegram.org/bots/api#sendmessage
 */
async function sendTelegramMessage(chatId, text, buttons) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN не задан в Render — сообщение в Telegram не отправлено');
    return false;
  }
  if (!chatId) {
    console.error('Telegram: не передан ID получателя — сообщение не отправлено');
    return false;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text };
  if (buttons) {
    body.reply_markup = {
      inline_keyboard: buttons.map((row) =>
        row.map((b) => ({ text: b.text, callback_data: b.payload }))
      ),
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseText = await res.text();
    if (!res.ok) {
      console.error(`Telegram API ошибка (chat_id=${chatId}):`, res.status, responseText);
    } else {
      console.log(`Сообщение в Telegram успешно отправлено (chat_id=${chatId})`);
    }
    return res.ok;
  } catch (e) {
    console.error('Исключение при обращении к Telegram API:', e.message);
    return false;
  }
}

/** Подтверждает нажатие кнопки в Telegram и меняет текст/убирает кнопки исходного сообщения */
async function answerTelegramCallback(callbackQueryId, notification) {
  if (!TELEGRAM_BOT_TOKEN || !callbackQueryId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: notification }),
    });
  } catch (e) {
    console.warn('Не удалось подтвердить нажатие кнопки в Telegram:', e.message);
  }
}

async function editTelegramMessage(chatId, messageId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId || !messageId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } }),
    });
  } catch (e) {
    console.warn('Не удалось изменить сообщение в Telegram:', e.message);
  }
}

/** Регистрирует наш /webhook/telegram как получателя событий Telegram */
async function registerTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${OWN_BASE_URL}/webhook/telegram` }),
    });
    if (res.ok) {
      console.log('Подписка на события Telegram оформлена:', `${OWN_BASE_URL}/webhook/telegram`);
    } else {
      console.warn('Не удалось оформить подписку на события Telegram:', res.status, await res.text());
    }
  } catch (e) {
    console.warn('Исключение при подписке на события Telegram:', e.message);
  }
}

/**
 * Отправляет уведомление в нужную группу менеджеров: заявки/сообщения
 * из Telegram — в Telegram-группу, из MAX — в MAX-группу. Если Telegram-
 * группа ещё не настроена (нет TELEGRAM_MANAGERS_GROUP_ID) — временно
 * дублирует в MAX-группу, чтобы уведомление не потерялось совсем.
 */
async function notifyManagers(platform, text) {
  if (platform === 'telegram') {
    if (TELEGRAM_MANAGERS_GROUP_ID) {
      await sendTelegramMessage(TELEGRAM_MANAGERS_GROUP_ID, text);
    } else if (MANAGERS_GROUP_ID) {
      await sendMaxMessage('chat_id', MANAGERS_GROUP_ID, `[Telegram-группа не настроена] ${text}`);
    }
  } else if (MANAGERS_GROUP_ID) {
    await sendMaxMessage('chat_id', MANAGERS_GROUP_ID, text);
  }
}

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
        await notifyManagers('max', `✉️ ${name} (ID ${sender.user_id}) написал(а):\n${bodyText}`);
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
      confirmLine = '✅ Хорошо, мы позвоним вам по указанному номеру в ближайшее рабочее время. Мы работаем с 9:00 до 18:00 в стандартные рабочие дни. Если вы ожидаете звонок определенное время - напишите пожалуйста, когда нам лучше позвонить вам';
    }
    if (payload === 'call_no') {
      choiceText = '💬 просит написать здесь, в чат с ботом';
      confirmLine = '💬 Хорошо, продолжим здесь — напишите, если хотите что-то уточнить уже сейчас.';
    }

    // Дописываем подтверждение к исходному тексту заказа, а не стираем его —
    // у клиента должна остаться видна вся история, что именно он заказал
    const userId = user ? user.user_id : null;
    const storeKey = userId ? `max:${userId}` : null;
    const originalOrderText = storeKey ? pendingOrderText.get(storeKey) : null;
    const updatedText = originalOrderText ? `${originalOrderText}\n\n${confirmLine}` : confirmLine;
    if (storeKey) pendingOrderText.delete(storeKey);

    // меняем исходное сообщение клиенту: кнопки исчезают, появляется
    // явное подтверждение выбора — это и есть видимый отклик на нажатие
    await answerCallback(callback_id, {
      message: { text: updatedText, attachments: [] },
    });

    await notifyManagers('max', `👉 ${name} (ID ${user ? user.user_id : '—'}) ${choiceText}`);
  }

  res.json({ ok: true });
});

// Приём событий от Telegram — сюда прилетают и обычные сообщения, и нажатия кнопок
app.post('/webhook/telegram', async (req, res) => {
  const update = req.body || {};
  console.log('Telegram update:', JSON.stringify(update));

  // Нажатие кнопки
  if (update.callback_query) {
    const cb = update.callback_query;
    const callbackId = cb.id;

    if (processedCallbacks.has(callbackId)) {
      return res.json({ ok: true });
    }
    processedCallbacks.add(callbackId);

    const payload = cb.data;
    const from = cb.from || {};
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Клиент';
    const chatId = cb.message && cb.message.chat && cb.message.chat.id;
    const messageId = cb.message && cb.message.message_id;

    let choiceText = 'сделал выбор';
    let confirmLine = 'Спасибо за ответ!';
    if (payload === 'call_yes') {
      choiceText = '✅ согласен на звонок';
      confirmLine = '✅ Хорошо, мы позвоним вам по указанному номеру в ближайшее рабочее время. Мы работаем с 9:00 до 18:00 в стандартные рабочие дни. Если вы ожидаете звонок определённое время — напишите, пожалуйста, когда нам лучше позвонить вам';
    }
    if (payload === 'call_no') {
      choiceText = '💬 просит написать здесь, в чат с ботом';
      confirmLine = '💬 Хорошо, продолжим здесь — напишите, если хотите что-то уточнить уже сейчас.';
    }

    const storeKey = chatId ? `telegram:${chatId}` : null;
    const originalOrderText = storeKey ? pendingOrderText.get(storeKey) : null;
    const updatedText = originalOrderText ? `${originalOrderText}\n\n${confirmLine}` : confirmLine;
    if (storeKey) pendingOrderText.delete(storeKey);

    await answerTelegramCallback(callbackId, 'Спасибо!');
    if (chatId && messageId) {
      await editTelegramMessage(chatId, messageId, updatedText);
    }

    await notifyManagers('telegram', `👉 ${name} (ID ${chatId || '—'}) ${choiceText}`);

    return res.json({ ok: true });
  }

  // Обычное текстовое сообщение
  if (update.message && update.message.text && update.message.from && !update.message.from.is_bot) {
    const msg = update.message;
    const from = msg.from;
    const chatId = msg.chat.id;
    const text = msg.text;

    // Сообщение в группе менеджеров. Если это «Ответить» на сообщение бота
    // о клиенте (в нём есть «(ID 123456)») — пересылаем ответ клиенту в его
    // чат с ботом. Всё остальное в группе игнорируем: это общение менеджеров
    // между собой, бот его никуда не пересылает и не повторяет.
    if (TELEGRAM_MANAGERS_GROUP_ID && String(chatId) === TELEGRAM_MANAGERS_GROUP_ID) {
      const repliedText = (msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption)) || '';
      const idMatch = repliedText.match(/\(ID (\d+)\)/);
      if (idMatch) {
        const clientId = idMatch[1];
        const sent = await sendTelegramMessage(clientId, text);
        await sendTelegramMessage(
          TELEGRAM_MANAGERS_GROUP_ID,
          sent
            ? `✅ Доставлено клиенту (ID ${clientId})`
            : `⚠️ Не удалось доставить клиенту (ID ${clientId}): возможно, он не разрешил боту писать или заблокировал бота`
        );
      }
      return res.json({ ok: true });
    }

    // Сообщения клиентов принимаем только из личного чата с ботом
    if (msg.chat.type === 'private') {
      const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Клиент';
      await notifyManagers('telegram', `✉️ ${name} (ID ${chatId}) написал(а):\n${text}`);
    }
  }

  res.json({ ok: true });
});

// Пароль для "пульта" — простой веб-страницы, с которой можно вручную
// написать конкретному клиенту. Впишите свой пароль в переменную
// окружения ADMIN_SECRET в Render.
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();

app.post('/api/reply', async (req, res) => {
  const { secret, user_id, text, platform } = req.body || {};
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Неверный пароль' });
  }
  if (!user_id || !text) {
    return res.status(400).json({ error: 'Укажите ID клиента и текст сообщения' });
  }

  if (platform === 'telegram') {
    await sendTelegramMessage(user_id, text);
  } else {
    await sendMaxMessage('user_id', user_id, text);
  }

  // сохраняем копию в группе менеджеров — так у вас остаётся история,
  // что именно и кому вы отвечали
  await notifyManagers(platform, `📤 Вы ответили (ID ${user_id}):\n${text}`);

  res.json({ ok: true });
});

app.post('/api/order', async (req, res) => {
  const { name, phone, comment, items, platform, platform_user_id, max_user_id } = req.body || {};
  if (!name || !phone) {
    return res.status(400).json({ error: 'Укажите имя и телефон' });
  }

  // ВРЕМЕННО: подробный лог того, что реально прислала витрина —
  // уберём, как только разберёмся с недостающим ID у Telegram
  console.log('========== СЫРОЕ ТЕЛО ЗАЯВКИ ==========');
  console.log(JSON.stringify(req.body, null, 2));

  // platform/platform_user_id — новый универсальный вид заявки из витрины.
  // max_user_id оставлен для совместимости со старой версией файла.
  const effectivePlatform = platform || (max_user_id ? 'max' : null);
  const effectiveUserId = platform_user_id || max_user_id || null;

  console.log('Новая заявка:', {
    name,
    phone,
    comment,
    items,
    platform: effectivePlatform,
    userId: effectiveUserId,
    hasTelegramToken: !!TELEGRAM_BOT_TOKEN,
    hasMaxToken: !!MAX_BOT_TOKEN,
    at: new Date().toISOString(),
  });

  const itemsText = (items || [])
    .map((i) => `«${i.name}» — ${new Intl.NumberFormat('ru-RU').format(i.price)} ₽`)
    .join(', ');
  const commentText = comment ? `\nВаш комментарий: ${comment}` : '';

  const buttons = [
    [
      { type: 'callback', text: 'Да, позвоните', payload: 'call_yes' },
      { type: 'callback', text: 'Переписка в чате', payload: 'call_no' },
    ],
  ];

  // Подтверждение клиенту — придёт прямо в его чат с ботом,
  // с кнопками "звоните" / "переписка в чате"
  if (effectiveUserId) {
    const orderText = `Добрый день, ${name}! Мы получили вашу заявку по товару ${itemsText}.\nВаш номер телефона: ${phone}${commentText}`;
    const askLine = '\n\nКак вам удобнее — позвонить или продолжить здесь, в переписке?';

    if (effectivePlatform === 'telegram') {
      pendingOrderText.set(`telegram:${effectiveUserId}`, orderText);
      await sendTelegramMessage(effectiveUserId, orderText + askLine, buttons);
    } else {
      pendingOrderText.set(`max:${effectiveUserId}`, orderText);
      await sendMaxMessage('user_id', effectiveUserId, orderText + askLine, buttons);
    }
  } else {
    console.warn('ID клиента не определился — подтверждение клиенту не отправлено');
  }

  const idNote = effectiveUserId ? `(ID ${effectiveUserId})` : '(ID не определился — отвечайте только звонком)';

  // Уведомление в группу менеджеров — в MAX или в Telegram,
  // в зависимости от того, откуда пришла заявка
  await notifyManagers(
    effectivePlatform,
    `🔔 Новая заявка! ${idNote}\n${name}, ${phone}\n${itemsText}${commentText}`
  );

  // Личное уведомление вам (необязательно, если заполнено в .env)
  if (process.env.MAX_NOTIFY_USER_ID) {
    await sendMaxMessage(
      'user_id',
      process.env.MAX_NOTIFY_USER_ID,
      `🔔 Новая заявка! ${idNote}\n${name}, ${phone}\n${itemsText}${commentText}`
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
  registerTelegramWebhook();
});
