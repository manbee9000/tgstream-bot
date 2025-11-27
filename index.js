import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import { MongoClient } from "mongodb";
import WebSocket from "ws";

// ================== CONFIG ==================
const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;

const MONGODB_URI = process.env.MONGODB_URI;

// DonationAlerts: страница доната для пополнения баланса бота
const DA_DONATE_URL =
  process.env.DA_DONATE_URL || "https://dalink.to/mystreambot";

// Widget token (секрет виджета оповещений / статистики)
const DA_WIDGET_TOKEN = process.env.DA_WIDGET_TOKEN || null;

// Стоимость одной публикации
const PRICE_PER_POST = parseInt(process.env.PRICE_PER_POST || "100", 10);

// OAuth-приложение DonationAlerts
const DA_CLIENT_ID = process.env.DA_CLIENT_ID || null;
const DA_CLIENT_SECRET = process.env.DA_CLIENT_SECRET || null;

// Скоупы строго согласно документации DA
// oauth-user-show — для /api/v1/user/oauth
// oauth-donation-subscribe — для подписки на $alerts:donation_<user_id>
const DA_SCOPES =
  process.env.DA_SCOPES || "oauth-user-show oauth-donation-subscribe";

// Redirect-URL для OAuth (берём из ENV, а если нет — по умолчанию /da-oauth)
const DA_REDIRECT_PATH = process.env.DA_REDIRECT_PATH || "/da-oauth";

// Админ для создания промокодов и авторизации DA
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
    if (url.includes("youtu.be/")) return url.split("youtu.be/")[1].split("?")[0];
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
let settingsCol;

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
    settingsCol = db.collection("settings");
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

// 🔴 ИЗМЕНЕНО: добавлен chatId третьим аргументом и сохранение в документ
async function createOrder(tgId, amount, chatId) {
  if (!ordersCol) return null;
  const orderId = generateOrderId();
  const doc = {
    orderId,
    tgId,
    chatId, // <--- сохраняем чат, откуда человек жмакнул оплату
    amount,
    status: "pending",
    createdAt: new Date(),
  };
  await ordersCol.insertOne(doc);
  return orderId;
}

// Формируем URL на страницу доната с уже проставленным комментарием ORDER_xxx
function buildDonateUrl(orderId, amount) {
  const params = new URLSearchParams();
  params.set("message", `ORDER_${orderId}`);
  params.set("amount", String(amount));
  return `${DA_DONATE_URL}?${params.toString()}`;
}

// Проверка баланса перед постом
async function ensureBalanceForPost(tgId, chatId) {
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

// ================== DonationAlerts: OAuth + WebSocket ==================

// В памяти
let daAccessToken = null;
let daRefreshToken = null;
let daTokenExpiresAt = null; // Date
let daUserId = null;

let daWs = null;
let daWsClientId = null;
let daReconnectTimer = null;

// загрузка токенов из Mongo
async function loadDaTokensFromDb() {
  if (!settingsCol) return;
  const doc = await settingsCol.findOne({ _id: "da_oauth" });
  if (!doc) return;

  daAccessToken = doc.accessToken || null;
  daRefreshToken = doc.refreshToken || null;
  daTokenExpiresAt = doc.expiresAt ? new Date(doc.expiresAt) : null;
  daUserId = doc.userId || null;
}

// сохранение токенов в Mongo
async function saveDaTokensToDb() {
  if (!settingsCol) return;
  await settingsCol.updateOne(
    { _id: "da_oauth" },
    {
      $set: {
        accessToken: daAccessToken,
        refreshToken: daRefreshToken,
        expiresAt: daTokenExpiresAt,
        userId: daUserId,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

// обмен code -> token (Authorization Code Grant)
async function exchangeCodeForToken(code) {
  if (!DA_CLIENT_ID || !DA_CLIENT_SECRET) {
    throw new Error("DA_CLIENT_ID или DA_CLIENT_SECRET не заданы.");
  }

  const redirectUri = `${RENDER_URL}${DA_REDIRECT_PATH}`;
  const body = new URLSearchParams();
  body.set("client_id", DA_CLIENT_ID);
  body.set("client_secret", DA_CLIENT_SECRET);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", redirectUri);
  body.set("code", code);

  const resp = await axios.post(
    "https://www.donationalerts.com/oauth/token",
    body.toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );

  const data = resp.data || {};

  daAccessToken = data.access_token;
  daRefreshToken = data.refresh_token || null;
  daTokenExpiresAt = new Date(
    Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600 * 1000)
  );

  await saveDaTokensToDb();
}

// обновление токена по refresh_token при необходимости
async function ensureDaAccessToken() {
  if (!daAccessToken) return false;
  if (!daTokenExpiresAt) return true;

  const now = Date.now();
  const expiresInMs = daTokenExpiresAt.getTime() - now;

  // обновляем за минуту до истечения
  if (expiresInMs > 60 * 1000) return true;

  if (!daRefreshToken) return true;

  try {
    const body = new URLSearchParams();
    body.set("client_id", DA_CLIENT_ID);
    body.set("client_secret", DA_CLIENT_SECRET);
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", daRefreshToken);
    body.set("scope", DA_SCOPES);

    const resp = await axios.post(
      "https://www.donationalerts.com/oauth/token",
      body.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const data = resp.data || {};
    daAccessToken = data.access_token;
    daRefreshToken = data.refresh_token || daRefreshToken;
    daTokenExpiresAt = new Date(
      Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600 * 1000)
    );

    await saveDaTokensToDb();
    console.log("DA OAuth: access_token обновлён.");
    return true;
  } catch (err) {
    console.error(
      "Ошибка обновления DA access_token:",
      err.response?.data || err.message
    );
    return false;
  }
}

// получение userId и socket_connection_token (/api/v1/user/oauth)
async function fetchDaUserInfo() {
  if (!daAccessToken) return null;

  const resp = await axios.get(
    "https://www.donationalerts.com/api/v1/user/oauth",
    {
      headers: {
        Authorization: `Bearer ${daAccessToken}`,
      },
    }
  );

  const data = resp.data?.data || resp.data || {};
  return data;
}

// По документации DonationAlerts сообщения канала содержат donation resource
// "представленный так же, как в Donations Alerts List". Мы рекурсивно ищем
// объект с полями id, message, amount, currency.
function findDonationObject(node) {
  if (!node || typeof node !== "object") return null;

  const hasRequiredFields =
    Object.prototype.hasOwnProperty.call(node, "id") &&
    Object.prototype.hasOwnProperty.call(node, "message") &&
    Object.prototype.hasOwnProperty.call(node, "amount") &&
    Object.prototype.hasOwnProperty.call(node, "currency");

  if (hasRequiredFields) {
    return node;
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findDonationObject(item);
        if (found) return found;
      }
    } else if (value && typeof value === "object") {
      const found = findDonationObject(value);
      if (found) return found;
    }
  }

  return null;
}

function extractDonationFromWsMessage(msg) {
  return findDonationObject(msg);
}

async function handleDonation(donation) {
  if (!ordersCol || !usersCol) return;

  console.log("Получен донат от DA:", {
    id: donation.id,
    amount: donation.amount,
    message: donation.message,
  });

  const msg = donation.message || "";

  const match = msg.match(/ORDER_([a-zA-Z0-9]+)/);
  if (!match) return;

  const orderId = match[1];

  const order = await ordersCol.findOne({
    orderId,
    status: "pending",
  });

  if (!order) {
    console.log("ORDER не найден или уже обработан:", orderId);
    return;
  }

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
      // 🔴 ИЗМЕНЕНО: отправляем в тот чат, откуда человек нажимал оплату,
      // если chatId сохранён; иначе в личку по tgId
      const targetChatId = order.chatId || order.tgId;
      await bot.sendMessage(
        targetChatId,
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

// запуск WebSocket-подключения к DonationAlerts (Centrifugo)
async function startDonationAlertsRealtime() {
  if (!DA_CLIENT_ID || !DA_CLIENT_SECRET) {
    console.log(
      "DA_CLIENT_ID или DA_CLIENT_SECRET не заданы. Автоучёт оплат DonationAlerts отключён."
    );
    return;
  }
  if (!daAccessToken) {
    console.log(
      "DA OAuth ещё не выполнен. Для подключения DonationAlerts нажмите кнопку «Авторизовать DonationAlerts» в боте."
    );
    return;
  }

  const ok = await ensureDaAccessToken();
  if (!ok) return;

  try {
    const userInfo = await fetchDaUserInfo();
    if (!userInfo) {
      console.error("DA: не удалось получить user info.");
      return;
    }

    daUserId = userInfo.id;
    const socketToken = userInfo.socket_connection_token;

    if (!daUserId || !socketToken) {
      console.error(
        "DA: userId или socket_connection_token отсутствуют в ответе."
      );
      return;
    }

    await saveDaTokensToDb(); // сохраним userId

    const wsUrl = "wss://centrifugo.donationalerts.com/connection/websocket";

    if (daWs) {
      try {
        daWs.close();
      } catch {}
      daWs = null;
    }

    console.log("Подключаемся к DonationAlerts WebSocket...");
    daWs = new WebSocket(wsUrl);

    daWs.on("open", () => {
      try {
        const connectMsg = {
          params: { token: socketToken },
          id: 1,
        };
        daWs.send(JSON.stringify(connectMsg));
      } catch (e) {
        console.error("Ошибка отправки connectMsg в DA WebSocket:", e.message);
      }
    });

    daWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // Для отладки можно раскомментировать:
      // console.log("DA WS RAW:", JSON.stringify(msg));

      // Ответ на connect (id=1) с client UUID
      if (msg.id === 1 && msg.result && msg.result.client) {
        daWsClientId = msg.result.client;
        console.log("DA WebSocket: clientId =", daWsClientId);

        try {
          // Запрашиваем токен для подписки на канал донатов
          const resp = await axios.post(
            "https://www.donationalerts.com/api/v1/centrifuge/subscribe",
            {
              channels: [`$alerts:donation_${daUserId}`],
              client: daWsClientId,
            },
            {
              headers: {
                Authorization: `Bearer ${daAccessToken}`,
                "Content-Type": "application/json",
              },
            }
          );

          const arr = resp.data?.channels || [];
          const ch = arr.find((c) =>
            c.channel.includes(`$alerts:donation_${daUserId}`)
          );
          if (!ch) {
            console.error("DA: не удалось получить channel token.");
            return;
          }

          const subMsg = {
            params: {
              channel: ch.channel,
              token: ch.token,
            },
            method: 1,
            id: 2,
          };
          daWs.send(JSON.stringify(subMsg));
          console.log("DA WebSocket: подписка на", ch.channel);
        } catch (err) {
          console.error(
            "Ошибка подписки на DA канал:",
            err.response?.data || err.message
          );
        }

        return;
      }

      // Подтверждение подписки (id=2) можно игнорировать
      if (msg.id === 2) {
        return;
      }

      // Остальные сообщения — потенциальные донаты
      const donation = extractDonationFromWsMessage(msg);
      if (donation) {
        try {
          await handleDonation(donation);
        } catch (err) {
          console.error("Ошибка в handleDonation:", err.message);
        }
      }
    });

    daWs.on("error", (err) => {
      console.error("DA WebSocket error:", err.message);
    });

    daWs.on("close", () => {
      console.log("DA WebSocket: соединение закрыто.");
      scheduleDaReconnect();
    });
  } catch (err) {
    console.error(
      "Ошибка при инициализации DonationAlerts realtime:",
      err.response?.data || err.message
    );
    scheduleDaReconnect();
  }
}

function scheduleDaReconnect(delayMs = 30000) {
  if (daReconnectTimer) return;
  daReconnectTimer = setTimeout(async () => {
    daReconnectTimer = null;
    console.log("Пытаемся переподключиться к DonationAlerts...");
    await startDonationAlertsRealtime();
  }, delayMs);
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

  const keyboard = {
    inline_keyboard: [
      [{ text: "Авторизовать DonationAlerts", callback_data: "da_auth" }],
    ],
  };

  bot.sendMessage(msg.chat.id, text, { reply_markup: keyboard });
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
      [{ text: "Авторизовать DonationAlerts", callback_data: "da_auth" }],
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
        "Выберите сумму пополнения. После оплаты баланс будет пополнен автоматически.\n\n" +
        "Важно: на странице DonationAlerts комментарий к донату будет автоматически заполнен вида `ORDER_xxxxx`. " +
        "НЕ меняйте и не удаляйте его, иначе бот не сможет привязать оплату к вашему заказу.";

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
        // 🔴 ИЗМЕНЕНО: передаём chatId третьим аргументом
        const orderId = await createOrder(userId, amount, chatId);
        if (!orderId) {
          await bot.sendMessage(
            chatId,
            "Сейчас пополнение баланса недоступно (ошибка базы данных). Попробуйте позже."
          );
        } else {
          const payUrl = buildDonateUrl(orderId, amount);
          const txt =
            `Для пополнения баланса на ${amount} ₽ перейдите по ссылке ниже и завершите оплату.\n\n` +
            `Комментарий к донату уже будет заполнен как ORDER_${orderId} — пожалуйста, НЕ меняйте его, иначе бот не сможет засчитать оплату.\n\n` +
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
    } else if (data === "da_auth") {
      if (userId !== ADMIN_TG_ID) {
        await bot.sendMessage(
          chatId,
          "Авторизовать DonationAlerts может только владелец бота."
        );
      } else {
        if (!DA_CLIENT_ID || !DA_CLIENT_SECRET) {
          await bot.sendMessage(
            chatId,
            "Переменные DA_CLIENT_ID и DA_CLIENT_SECRET не заданы на сервере."
          );
        } else {
          const redirectUri = `${RENDER_URL}${DA_REDIRECT_PATH}`;
          const scope = DA_SCOPES;
          const authUrl =
            "https://www.donationalerts.com/oauth/authorize" +
            `?client_id=${encodeURIComponent(DA_CLIENT_ID)}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&response_type=code` +
            `&scope=${encodeURIComponent(scope)}`;

          await bot.sendMessage(
            chatId,
            "Нажмите кнопку ниже, чтобы авторизовать DonationAlerts и включить автоматическое пополнение баланса:",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Авторизовать DonationAlerts", url: authUrl }],
                ],
              },
            }
          );
        }
      }
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

// ================== OAuth callback DonationAlerts ==================
app.get(DA_REDIRECT_PATH, async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send("Не передан параметр code.");
  }

  try {
    await exchangeCodeForToken(String(code));
    await startDonationAlertsRealtime();
    res.send(
      "DonationAlerts успешно авторизован. Можете вернуться в Telegram-бот."
    );
  } catch (err) {
    console.error(
      "Ошибка в обработчике DA OAuth:",
      err.response?.data || err.message
    );
    res
      .status(500)
      .send("Произошла ошибка при авторизации DonationAlerts. Попробуйте позже.");
  }
});

// ================== СТАРТ СЕРВЕРА ==================
async function start() {
  await initMongo();
  await loadDaTokensFromDb();

  if (daAccessToken) {
    startDonationAlertsRealtime().catch((e) =>
      console.error("Ошибка старта DA realtime:", e.message)
    );
  } else {
    console.log(
      "DA OAuth токены не найдены. Нажмите в боте кнопку «Авторизовать DonationAlerts», чтобы включить автоучёт оплат."
    );
  }

  app.listen(PORT, () => console.log("SERVER RUNNING ON PORT", PORT));
}

start().catch((err) => {
  console.error("Fatal start error:", err);
  process.exit(1);
});
