import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import { MongoClient } from "mongodb";

// ================== CONFIG ==================
const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;

const MONGODB_URI = process.env.MONGODB_URI;

const DA_DONATE_URL =
  process.env.DA_DONATE_URL || "https://dalink.to/mystreambot";

// Стоимость одной публикации
const PRICE_PER_POST = parseInt(process.env.PRICE_PER_POST || "100", 10);

// Personal Access Token DonationAlerts (ставим в ENV: DA_API_TOKEN)
const DA_API_TOKEN = process.env.DA_API_TOKEN || null;

// Админ для создания промокодов
const ADMIN_TG_ID = 618072923;

// Определяем parent-домен (для Twitch)
let PARENT_DOMAIN = "localhost";
try {
  if (RENDER_URL) {
    PARENT_DOMAIN = new URL(RENDER_URL).host;
  }
} catch (e) {
  console.error("Ошибка парсинга RENDER_URL:", e);
}

// ================== EXPRESS ==================
const app = express();
app.use(express.json());

if (!TOKEN) {
  console.error("Ошибка: BOT_TOKEN не задан!");
  process.exit(1);
}
if (!RENDER_URL) {
  console.error(
    "Внимание: RENDER_EXTERNAL_URL не задан! WebApp-кнопка может работать некорректно."
  );
}

// ================== TELEGRAM WEBHOOK ==================
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================== WEBAPP ДЛЯ iframe ==================
app.get("/webapp", (req, res) => {
  const src = req.query.src || "";
  res.send(`
    <html>
      <body style="margin:0;background:#000">
        <iframe
          src="${src}"
          allowfullscreen
          allow="autoplay; encrypted-media; picture-in-picture"
          style="width:100%;height:100%;border:0;"
        ></iframe>
      </body>
    </html>
  `);
});

// ================== HELPERS: YouTube/Twitch/VK ==================
function extractYouTubeId(url) {
  try {
    if (url.includes("watch?v=")) return url.split("v=")[1].split("&")[0];
    if (url.includes("youtu.be/"))
      return url.split("youtu.be/")[1].split("?")[0];
  } catch {}
  return null;
}

async function getThumbnail(url) {
  // Twitch
  if (url.includes("twitch.tv")) {
    try {
      const name = url.split("/").pop().split("?")[0];
      return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${name}-1280x720.jpg`;
    } catch {
      return null;
    }
  }

  // YouTube
  if (url.includes("youtu")) {
    const id = extractYouTubeId(url);
    if (!id) return null;
    return `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  }

  // VK video (thumbnail Telegram сам создаст)
  if (url.includes("vk.com/video")) {
    return null;
  }

  return null;
}

function getEmbed(url) {
  // Twitch
  if (url.includes("twitch.tv")) {
    try {
      const name = url.split("/").pop().split("?")[0];
      return `https://player.twitch.tv/?channel=${name}&parent=${PARENT_DOMAIN}`;
    } catch {
      return url;
    }
  }

  // YouTube
  if (url.includes("youtu")) {
    const id = extractYouTubeId(url);
    if (id) {
      return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
    }
  }

  // VK
  if (url.includes("vk.com/video")) {
    try {
      const raw = url.split("video")[1]; // -123_456
      const [oid, vid] = raw.split("_");
      return `https://vk.com/video_ext.php?oid=${oid}&id=${vid}&hd=1`;
    } catch {
      return url;
    }
  }

  return url;
}

// ================== ПУБЛИКАЦИЯ СТРИМА ==================
async function publishStreamPost(channelId, embedUrl, thumbnail, donateName) {
  const buttons = [
    [
      {
        text: "🎥 Смотреть стрим",
        url: `${RENDER_URL}/webapp?src=${encodeURIComponent(embedUrl)}`,
      },
    ],
  ];

  if (donateName) {
    buttons.push([
      {
        text: "💸 Донат",
        url: `https://www.donationalerts.com/r/${donateName}`,
      },
    ]);
  }

  const caption =
    "🔴 Не пропустите стрим!\n\n" +
    "🎥 Нажмите «Смотреть стрим», чтобы открыть трансляцию.\n" +
    "💬 Чат находится в комментариях под постом.\n" +
    "💸 Донат — через соответствующую кнопку ниже.";

  if (thumbnail) {
    await bot.sendPhoto(channelId, thumbnail, {
      caption,
      reply_markup: { inline_keyboard: buttons },
    });
  } else {
    await bot.sendMessage(channelId, caption, {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  await bot.sendMessage(channelId, "💬 Чат стрима");
}

// ================== MONGODB ==================
let mongoClient;
let db;
let usersCol;
let ordersCol;
let promoCol;

async function initMongo() {
  if (!MONGODB_URI) {
    console.error("MONGODB_URI не задан, работа с балансом отключена.");
    return;
  }
  try {
    mongoClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
    });
    await mongoClient.connect();
    db = mongoClient.db();
    usersCol = db.collection("users");
    ordersCol = db.collection("orders");
    promoCol = db.collection("promocodes");
    console.log("MongoDB подключен");
  } catch (err) {
    console.error("Ошибка подключения к MongoDB:", err.message);
  }
}

async function getUser(tgId) {
  if (!usersCol) return null;
  return usersCol.findOne({ tgId });
}

async function getOrCreateUser(tgId) {
  if (!usersCol) {
    return { tgId, balance: 0 };
  }
  let user = await usersCol.findOne({ tgId });
  if (!user) {
    user = {
      tgId,
      balance: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await usersCol.insertOne(user);
  }
  return user;
}

async function updateUserBalance(tgId, delta) {
  if (!usersCol) return null;
  const res = await usersCol.findOneAndUpdate(
    { tgId },
    {
      $inc: { balance: delta },
      $set: { updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, returnDocument: "after" }
  );
  return res.value;
}

// ================== ПРОМОКОДЫ ==================
async function createPromocode(code, postsCount, createdBy) {
  if (!promoCol) return;

  const normalized = code.trim().toUpperCase();

  const doc = {
    code: normalized,
    remainingPosts: postsCount,
    createdBy,
    createdAt: new Date(),
  };

  await promoCol.updateOne(
    { code: normalized },
    { $set: doc },
    { upsert: true }
  );
}

async function applyPromocode(tgId, code) {
  if (!promoCol || !usersCol) return { ok: false, message: "База недоступна" };

  const normalized = code.trim().toUpperCase();

  const promo = await promoCol.findOne({
    code: normalized,
    remainingPosts: { $gt: 0 },
  });

  if (!promo) {
    return {
      ok: false,
      message: "Промокод не найден или уже израсходован.",
    };
  }

  const postsToAdd = promo.remainingPosts;
  const amountRub = postsToAdd * PRICE_PER_POST;

  const user = await updateUserBalance(tgId, amountRub);

  await promoCol.updateOne(
    { _id: promo._id },
    { $set: { remainingPosts: 0, usedAt: new Date(), usedBy: tgId } }
  );

  const newBalance = user?.balance || 0;

  return {
    ok: true,
    message:
      `Промокод успешно активирован.\n` +
      `Начислено ${amountRub} ₽ (${postsToAdd} бесплатных публикаций).\n` +
      `Текущий баланс: ${Math.round(newBalance)} ₽.`,
  };
}

// ================== ЗАКАЗЫ (через DonationAlerts) ==================
function generateOrderId() {
  return Math.random().toString(36).slice(2, 10);
}

async function createOrder(tgId, amount) {
  if (!ordersCol) return null;
  const orderId = generateOrderId();
  const doc = {
    orderId,
    tgId,
    amount,
    status: "pending",
    createdAt: new Date(),
  };
  await ordersCol.insertOne(doc);
  return orderId;
}

function buildDonateUrl(orderId, amount) {
  const params = new URLSearchParams();
  params.set("amount", String(amount));
  params.set("message", `ORDER_${orderId}`);
  return `${DA_DONATE_URL}?${params.toString()}`;
}

// Проверка баланса перед постом
async function ensureBalanceForPost(tgId, chatId) {
  // если нет Mongo — не блокируем
  if (!usersCol) return true;

  const user = await getOrCreateUser(tgId);
  const currentBalance = user.balance || 0;

  if (currentBalance >= PRICE_PER_POST) {
    return true;
  }

  const text =
    `Для публикации стрима необходим баланс не менее ${PRICE_PER_POST} ₽.\n` +
    `Сейчас на Вашем счёте: ${Math.round(currentBalance)} ₽.\n\n` +
    `Пожалуйста, пополните баланс, чтобы разместить пост или введите промокод.`;

  await bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Пополнить баланс", callback_data: "topup" }],
        [{ text: "Ввести промокод", callback_data: "promo_enter" }],
      ],
    },
  });

  return false;
}

async function chargeForPost(tgId) {
  if (!usersCol) return;
  await updateUserBalance(tgId, -PRICE_PER_POST);
}

// ================== DonationAlerts: REST polling ==================

async function handleDonation(donation) {
  if (!ordersCol || !usersCol) return;

  const msg =
    donation.message ||
    donation.message_text ||
    donation.text ||
    donation.comment ||
    "";

  const match = msg.match(/ORDER_([a-zA-Z0-9]+)/);
  if (!match) return;

  const orderId = match[1];

  const order = await ordersCol.findOne({
    orderId,
    status: "pending",
  });

  if (!order) return;

  let amountRub = parseFloat(donation.amount);
  if (!Number.isFinite(amountRub) || amountRub <= 0) {
    amountRub = order.amount;
  }

  const user = await updateUserBalance(order.tgId, amountRub);

  await ordersCol.updateOne(
    { _id: order._id },
    {
      $set: {
        status: "paid",
        paidAt: new Date(),
        realAmount: amountRub,
        donationId: donation.id,
      },
    }
  );

  if (user) {
    try {
      await bot.sendMessage(
        order.tgId,
        `Оплата ${amountRub} ₽ получена. Ваш новый баланс: ${Math.round(
          user.balance
        )} ₽.`
      );
    } catch (err) {
      console.error(
        "Не удалось отправить уведомление пользователю:",
        err.message
      );
    }
  }
}

// опрос DonationAlerts каждые 5 секунд
async function pollDonationAlerts() {
  if (!DA_API_TOKEN) return;
  if (!ordersCol || !usersCol) return;

  try {
    const resp = await axios.get(
      "https://www.donationalerts.com/api/v1/alerts/donations",
      {
        headers: {
          Authorization: `Bearer ${DA_API_TOKEN}`,
        },
        params: {
          limit: 50,
        },
      }
    );

    const list = resp.data?.data || resp.data || [];
    if (!Array.isArray(list)) return;

    for (const donation of list) {
      try {
        await handleDonation(donation);
      } catch (e) {
        console.error("Ошибка обработки доната:", e.message);
      }
    }
  } catch (err) {
    console.error(
      "Ошибка при опросе DonationAlerts:",
      err.response?.data || err.message
    );
  }
}

// ================== TELEGRAM: конфиг стримера ==================
const streamerConfig = {}; // userId -> { channelId, donateName }

// команда /donate <имя_на_DA>
bot.onText(/\/donate (.+)/, (msg, match) => {
  const userId = msg.from.id;
  const name = match[1].trim();

  streamerConfig[userId] = streamerConfig[userId] || {};
  streamerConfig[userId].donateName = name;

  bot.sendMessage(
    msg.chat.id,
    `Донат успешно подключён:\nhttps://www.donationalerts.com/r/${name}`
  );
});

// команда /create <код> <число_публикаций> (только для ADMIN_TG_ID)
bot.onText(/\/create\s+(\S+)\s+(\d+)/, async (msg, match) => {
  const fromId = msg.from.id;
  if (fromId !== ADMIN_TG_ID) {
    return bot.sendMessage(
      msg.chat.id,
      "Команда /create доступна только администратору."
    );
  }

  const code = match[1];
  const postsCount = parseInt(match[2], 10);

  if (!postsCount || postsCount <= 0) {
    return bot.sendMessage(
      msg.chat.id,
      "Укажите положительное количество бесплатных публикаций."
    );
  }

  try {
    await createPromocode(code, postsCount, fromId);
    bot.sendMessage(
      msg.chat.id,
      `Промокод «${code}» создан.\nКоличество бесплатных публикаций: ${postsCount}.`
    );
  } catch (err) {
    console.error("Ошибка создания промокода:", err.message);
    bot.sendMessage(
      msg.chat.id,
      "Не удалось создать промокод. Попробуйте позже."
    );
  }
});

// ================== /start ==================
bot.onText(/\/start/, (msg) => {
  const text =
    "Добро пожаловать!\n\n" +
    "Чтобы подключить Ваш канал:\n" +
    "1. Добавьте бота в администраторы канала.\n" +
    "2. Отправьте любое сообщение в канале.\n" +
    "3. Перешлите это сообщение сюда, в бот.\n\n" +
    "После подключения Вы сможете отправлять ссылки на трансляции.\n\n" +
    `Публикация стрима списывает с баланса ${PRICE_PER_POST} ₽. Баланс можно пополнить в боте.`;

  bot.sendMessage(msg.chat.id, text);
});

// ================== /balance ==================
bot.onText(/\/balance/, async (msg) => {
  const userId = msg.from.id;
  const user = await getOrCreateUser(userId);
  const bal = user.balance || 0;

  const text = `Ваш текущий баланс: ${Math.round(bal)} ₽.`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "Пополнить баланс", callback_data: "topup" }],
      [{ text: "Ввести промокод", callback_data: "promo_enter" }],
    ],
  };

  bot.sendMessage(msg.chat.id, text, { reply_markup: keyboard });
});

// ================== CALLBACK-ЗАПРОСЫ ==================
const promoWaitingUsers = new Set(); // userId, ждём ввода промокода

bot.on("callback_query", async (query) => {
  const { id, from, data, message } = query;
  const chatId = message?.chat?.id;
  const userId = from.id;

  try {
    if (data === "topup") {
      const text =
        "Выберите сумму пополнения. После оплаты баланс будет пополнен автоматически:";

      const keyboard = {
        inline_keyboard: [
          [
            { text: "100 ₽", callback_data: "pay_100" },
            { text: "300 ₽", callback_data: "pay_300" },
          ],
          [
            { text: "500 ₽", callback_data: "pay_500" },
            { text: "1000 ₽", callback_data: "pay_1000" },
          ],
          [{ text: "10000 ₽", callback_data: "pay_10000" }],
        ],
      };

      await bot.sendMessage(chatId, text, { reply_markup: keyboard });
    } else if (data && data.startsWith("pay_")) {
      const amount = parseInt(data.split("_")[1], 10);
      if (!amount || amount <= 0) {
        await bot.sendMessage(
          chatId,
          "Не удалось определить сумму пополнения. Попробуйте ещё раз."
        );
      } else {
        const orderId = await createOrder(userId, amount);
        if (!orderId) {
          await bot.sendMessage(
            chatId,
            "Сейчас пополнение баланса недоступно (ошибка базы данных). Попробуйте позже."
          );
        } else {
          const payUrl = buildDonateUrl(orderId, amount);
          const txt =
            `Для пополнения баланса на ${amount} ₽ перейдите по ссылке ниже и завершите оплату.\n\n` +
            `Публикации будут начислены автоматически после подтверждения платежа DonationAlerts.`;

          await bot.sendMessage(chatId, txt, {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Оплатить через DonationAlerts",
                    url: payUrl,
                  },
                ],
              ],
            },
          });
        }
      }
    } else if (data === "promo_enter") {
      promoWaitingUsers.add(userId);
      await bot.sendMessage(
        chatId,
        "Отправьте промокод одним сообщением (например: VOLNA100)."
      );
    }
  } catch (err) {
    console.error("Ошибка в callback_query:", err.message);
  } finally {
    try {
      await bot.answerCallbackQuery(id);
    } catch (e) {
      // ignore
    }
  }
});

// ================== ОБРАБОТКА сообщений (в т.ч. промокод) ==================
bot.on("message", async (msg) => {
  try {
    const text = msg.text || "";
    const userId = msg.from.id;

    // если ждём промокод
    if (
      promoWaitingUsers.has(userId) &&
      text &&
      !text.startsWith("/") &&
      !msg.forward_from_chat
    ) {
      promoWaitingUsers.delete(userId);
      const code = text.trim();
      const res = await applyPromocode(userId, code);
      await bot.sendMessage(msg.chat.id, res.message);
      return;
    }

    // Подключение канала (пересланное сообщение из канала)
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      streamerConfig[userId] = streamerConfig[userId] || {};
      streamerConfig[userId].channelId = msg.forward_from_chat.id;

      return bot.sendMessage(
        msg.chat.id,
        `Канал успешно подключён: ${msg.forward_from_chat.title}\n\n` +
          "Теперь Вы можете отправить ссылку на стрим."
      );
    }

    // игнорируем команды
    if (text.startsWith("/")) return;

    // обрабатываем только ссылки
    if (!text.startsWith("http://") && !text.startsWith("https://")) return;

    // проверяем подключение канала
    const cfg = streamerConfig[userId];
    if (!cfg || !cfg.channelId) {
      return bot.sendMessage(
        msg.chat.id,
        "Перед публикацией стрима необходимо подключить Ваш канал.\n\n" +
          "Пожалуйста, выполните следующие шаги:\n" +
          "1. Добавьте бота администраторами Вашего канала.\n" +
          "2. Отправьте любое сообщение в канале.\n" +
          "3. Перешлите это сообщение сюда.\n\n" +
          "После подключения Вы сможете размещать ссылки на трансляции."
      );
    }

    // проверяем баланс
    const enough = await ensureBalanceForPost(userId, msg.chat.id);
    if (!enough) return;

    // формируем embed и thumbnail
    const embed = getEmbed(text);
    const thumb = await getThumbnail(text);

    // публикуем пост
    await publishStreamPost(cfg.channelId, embed, thumb, cfg.donateName);

    // списываем стоимость поста
    await chargeForPost(userId);

    const user = await getOrCreateUser(userId);
    const bal = user.balance || 0;

    bot.sendMessage(
      msg.chat.id,
      `Готово! Публикация успешно размещена.\n` +
        `С Вашего баланса списано ${PRICE_PER_POST} ₽.\n` +
        `Текущий баланс: ${Math.round(bal)} ₽.`
    );
  } catch (err) {
    console.error("MESSAGE ERROR:", err);
  }
});

// ================== СТАРТ СЕРВЕРА ==================
async function start() {
  await initMongo();

  if (DA_API_TOKEN) {
    console.log(
      "Запускаем опрос DonationAlerts каждые 5 секунд..."
    );
    setInterval(pollDonationAlerts, 5000);
  } else {
    console.log(
      "DA_API_TOKEN не задан. Автоматический учёт оплат DonationAlerts отключён."
    );
  }

  app.listen(PORT, () => console.log("SERVER RUNNING ON PORT", PORT));
}

start().catch((err) => {
  console.error("Fatal start error:", err);
  process.exit(1);
});
