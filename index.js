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

const DA_DONATE_URL =
  process.env.DA_DONATE_URL || "https://dalink.to/mystreambot";

const DA_WIDGET_TOKEN = process.env.DA_WIDGET_TOKEN || null;

const PRICE_PER_POST = parseInt(process.env.PRICE_PER_POST || "100", 10);

const DA_CLIENT_ID = process.env.DA_CLIENT_ID || null;
const DA_CLIENT_SECRET = process.env.DA_CLIENT_SECRET || null;

const DA_SCOPES =
  process.env.DA_SCOPES || "oauth-user-show oauth-donation-subscribe";

const DA_REDIRECT_PATH = process.env.DA_REDIRECT_PATH || "/da-oauth";

const ADMIN_TG_ID = 618072923;

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

app.use("/giveaway", express.static("webapp/giveaway"));

// ================== HELPERS ==================
function extractYouTubeId(url) {
  try {
    if (url.includes("watch?v=")) return url.split("v=")[1].split("&")[0];
    if (url.includes("youtu.be/")) return url.split("youtu.be/")[1].split("?")[0];
  } catch {}
  return null;
}

async function getThumbnail(url) {
  if (url.includes("twitch.tv")) {
    try {
      const name = url.split("/").pop().split("?")[0];
      return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${name}-1280x720.jpg`;
    } catch {
      return null;
    }
  }

  if (url.includes("youtu")) {
    const id = extractYouTubeId(url);
    if (!id) return null;

    return `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  }

  if (url.includes("vk.com/video")) {
    return null;
  }

  return null;
}

function getEmbed(url) {
  if (url.includes("twitch.tv")) {
    try {
      const name = url.split("/").pop().split("?")[0];
      return `https://player.twitch.tv/?channel=${name}&parent=${PARENT_DOMAIN}`;
    } catch {
      return url;
    }
  }

  if (url.includes("youtu")) {
    const id = extractYouTubeId(url);
    if (id) {
      return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
    }
  }

  if (url.includes("vk.com/video")) {
    try {
      const raw = url.split("video")[1];
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
  if (!promoCol || !usersCol)
    return { ok: false, message: "База недоступна" };

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
// ================== ЗАКАЗЫ ==================
function generateOrderId() {
  return Math.random().toString(36).slice(2, 10);
}

async function createOrder(tgId, chatId, amount) {
  if (!ordersCol) return null;
  const orderId = generateOrderId();
  const doc = {
    orderId,
    tgId,
    chatId,
    amount,
    status: "pending",
    createdAt: new Date(),
  };
  await ordersCol.insertOne(doc);
  return orderId;
}

function buildDonateUrl(orderId, amount) {
  const params = new URLSearchParams();
  params.set("message", `ORDER_${orderId}`);
  params.set("amount", String(amount));
  return `${DA_DONATE_URL}?${params.toString()}`;
}

async function ensureBalanceForPost(tgId, chatId) {
  if (!usersCol) return true;

  const user = await getOrCreateUser(tgId);
  const currentBalance = user.balance || 0;

  if (currentBalance >= PRICE_PER_POST) return true;

  const text =
    `Для публикации стрима необходим баланс не менее ${PRICE_PER_POST} ₽.\n` +
    `Сейчас на Вашем счёте: ${Math.round(currentBalance)} ₽.\n\n` +
    `Пожалуйста, пополните баланс или введите промокод.`;

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

// ================== DonationAlerts realtime ==================
let daAccessToken = null;
let daRefreshToken = null;
let daTokenExpiresAt = null;
let daUserId = null;

let daWs = null;
let daWsClientId = null;
let daReconnectTimer = null;

async function loadDaTokensFromDb() {
  if (!settingsCol) return;
  const doc = await settingsCol.findOne({ _id: "da_oauth" });
  if (!doc) return;

  daAccessToken = doc.accessToken || null;
  daRefreshToken = doc.refreshToken || null;
  daTokenExpiresAt = doc.expiresAt ? new Date(doc.expiresAt) : null;
  daUserId = doc.userId || null;
}

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

async function ensureDaAccessToken() {
  if (!daAccessToken) return false;
  if (!daTokenExpiresAt) return true;

  const now = Date.now();
  const expiresInMs = daTokenExpiresAt.getTime() - now;
  if (expiresInMs > 60000) return true;

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

async function fetchDaUserInfo() {
  if (!daAccessToken) return null;

  const resp = await axios.get(
    "https://www.donationalerts.com/api/v1/user/oauth",
    {
      headers: { Authorization: `Bearer ${daAccessToken}` },
    }
  );

  const data = resp.data?.data || resp.data || {};
  return data;
}

function findDonationObject(node) {
  if (!node || typeof node !== "object") return null;

  const has =
    node.hasOwnProperty("id") &&
    node.hasOwnProperty("message") &&
    node.hasOwnProperty("amount") &&
    node.hasOwnProperty("currency");

  if (has) return node;

  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        const r = findDonationObject(item);
        if (r) return r;
      }
    } else if (typeof val === "object" && val) {
      const r = findDonationObject(val);
      if (r) return r;
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
    console.log("ORDER не найден или обработан:", orderId);
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
    const notifyChatId = order.chatId || order.tgId;
    try {
      await bot.sendMessage(
        notifyChatId,
        `Оплата ${amountRub} ₽ получена! Новый баланс: ${Math.round(
          user.balance
        )} ₽.`
      );
    } catch (err) {
      console.error("Ошибка уведомления пользователя:", err.message);
    }
  }
}

async function startDonationAlertsRealtime() {
  if (!DA_CLIENT_ID || !DA_CLIENT_SECRET) {
    console.log("DA CLIENT_ID/SECRET не заданы — учёт отключён.");
    return;
  }
  if (!daAccessToken) {
    console.log("DA OAuth не выполнен. Используйте /da");
    return;
  }

  const ok = await ensureDaAccessToken();
  if (!ok) return;

  try {
    const userInfo = await fetchDaUserInfo();
    if (!userInfo) {
      console.error("DA: не удалось получить user info");
      return;
    }

    daUserId = userInfo.id;
    const socketToken = userInfo.socket_connection_token;
    if (!daUserId || !socketToken) {
      console.error("DA: нет userId или WS-токена");
      return;
    }

    await saveDaTokensToDb();

    const wsUrl = "wss://centrifugo.donationalerts.com/connection/websocket";

    if (daWs) {
      try {
        daWs.close();
      } catch {}
    }

    console.log("Подключение к DA WebSocket…");
    daWs = new WebSocket(wsUrl);

    daWs.on("open", () => {
      daWs.send(
        JSON.stringify({
          params: { token: socketToken },
          id: 1,
        })
      );
    });

    daWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.id === 1 && msg.result && msg.result.client) {
        daWsClientId = msg.result.client;
        console.log("DA clientId =", daWsClientId);

        try {
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
            console.error("Нет channel token");
            return;
          }

          daWs.send(
            JSON.stringify({
              params: { channel: ch.channel, token: ch.token },
              method: 1,
              id: 2,
            })
          );

          console.log("Подписка:", ch.channel);
        } catch (err) {
          console.error("Ошибка подписки:", err.response?.data || err.message);
        }

        return;
      }

      if (msg.id === 2) return;

      const donation = extractDonationFromWsMessage(msg);
      if (donation) await handleDonation(donation);
    });

    daWs.on("close", () => {
      console.log("WS закрыт. Переподключение…");
      scheduleDaReconnect();
    });

    daWs.on("error", (err) => {
      console.error("DA WS ERROR:", err.message);
    });
  } catch (err) {
    console.error("Realtime error:", err.response?.data || err.message);
    scheduleDaReconnect();
  }
}

function scheduleDaReconnect(delayMs = 30000) {
  if (daReconnectTimer) return;
  daReconnectTimer = setTimeout(() => {
    daReconnectTimer = null;
    startDonationAlertsRealtime();
  }, delayMs);
}

// ================== TELEGRAM ==================
const streamerConfig = {};

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

// /create
bot.onText(/\/create\s+(\S+)\s+(\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_TG_ID) {
    return bot.sendMessage(msg.chat.id, "Команда только для владельца.");
  }

  const code = match[1];
  const postsCount = parseInt(match[2], 10);
  if (!postsCount || postsCount <= 0)
    return bot.sendMessage(msg.chat.id, "Укажите положительное число.");

  try {
    await createPromocode(code, postsCount, msg.from.id);
    bot.sendMessage(
      msg.chat.id,
      `Промокод «${code}» создан. Доступно публикаций: ${postsCount}.`
    );
  } catch (err) {
    console.error("Ошибка create:", err.message);
    bot.sendMessage(msg.chat.id, "Ошибка БД.");
  }
});

// ================== новая команда /da ==================
bot.onText(/\/da/, async (msg) => {
  if (msg.from.id !== ADMIN_TG_ID) {
    return bot.sendMessage(msg.chat.id, "Команда доступна только владельцу.");
  }

  if (!DA_CLIENT_ID || !DA_CLIENT_SECRET) {
    return bot.sendMessage(msg.chat.id, "DA CLIENT_ID/SECRET не заданы.");
  }

  const redirectUri = `${RENDER_URL}${DA_REDIRECT_PATH}`;
  const scope = DA_SCOPES;

  const authUrl =
    "https://www.donationalerts.com/oauth/authorize" +
    `?client_id=${encodeURIComponent(DA_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scope)}`;

  bot.sendMessage(
    msg.chat.id,
    "Нажмите кнопку ниже, чтобы авторизовать DonationAlerts:",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "Авторизовать DonationAlerts", url: authUrl }]],
      },
    }
  );
});

// /start — убрали кнопку DA
bot.onText(/\/start/, (msg) => {
  const text =
    "Добро пожаловать!\n\n" +
    "Чтобы подключить Ваш канал:\n" +
    "1. Добавьте бота в администраторы канала.\n" +
    "2. Отправьте любое сообщение в вашем канале.\n" +
    "3. Перешлите это сообщение сюда, в бот.\n\n" +
    "После подключения Вы сможете отправлять ссылки на трансляции.\n\n" +
    `Публикация стрима списывает с баланса ${PRICE_PER_POST} ₽. Баланс можно пополнить в боте.`;

  bot.sendMessage(msg.chat.id, text);
});

// /balance — убрана кнопка DA
bot.onText(/\/balance/, async (msg) => {
  const user = await getOrCreateUser(msg.from.id);
  const bal = user.balance || 0;

  bot.sendMessage(
    msg.chat.id,
    `Ваш баланс: ${Math.round(
      bal
    )} ₽.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Пополнить баланс", callback_data: "topup" }],
          [{ text: "Ввести промокод", callback_data: "promo_enter" }],
        ],
      },
    }
  );
});

// ================== CALLBACK ==================
const promoWaitingUsers = new Set();

bot.on("callback_query", async (query) => {
  const { id, from, data, message } = query;
  const chatId = message?.chat?.id;
  const userId = from.id;

  try {
    if (data === "topup") {
      const text =
        "Выберите сумму пополнения. После оплаты баланс будет пополнен автоматически.\n\n" +
        "**ВАЖНО:** на странице оплаты DonationAlerts необходимо вручную вставить ваш код `ORDER_xxxxx` в поле комментария к донату.\n" +
        "НЕ меняйте и не удаляйте этот код, иначе бот не сможет привязать оплату!";

      await bot.sendMessage(chatId, text, {
        reply_markup: {
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
        },
        parse_mode: "Markdown",
      });
    }

    else if (data.startsWith("pay_")) {
      const amount = parseInt(data.split("_")[1], 10);
      if (!amount || amount <= 0)
        return bot.sendMessage(chatId, "Неверная сумма.");

      const orderId = await createOrder(userId, chatId, amount);
      if (!orderId)
        return bot.sendMessage(chatId, "Ошибка базы данных.");

      const payUrl = buildDonateUrl(orderId, amount);

      const txt =
        `Для пополнения баланса на ${amount} ₽ перейдите по ссылке ниже и завершите оплату.\n\n` +
        `Скопируйте ваш уникальный код и вставьте его в поле комментария на странице оплаты:\n\n` +
        `\`ORDER_${orderId}\`\n\n` +
        `Пожалуйста, НЕ меняйте его и не удаляйте, иначе бот не сможет засчитать оплату.\n\n` +
        `После оплаты просто отправьте ссылку на стрим ещё раз.`;

      await bot.sendMessage(chatId, txt, {
        reply_markup: {
          inline_keyboard: [[{ text: "Оплатить", url: payUrl }]],
        },
        parse_mode: "Markdown",
      });
    }

    else if (data === "promo_enter") {
      promoWaitingUsers.add(userId);
      bot.sendMessage(chatId, "Введите промокод одним сообщением.");
    }
  } catch (err) {
    console.error("callback:", err);
  } finally {
    try {
      await bot.answerCallbackQuery(id);
    } catch {}
  }
});

// ================== MESSAGE HANDLER ==================
bot.on("message", async (msg) => {
  try {
    const text = msg.text || "";
    const userId = msg.from.id;

    if (
      promoWaitingUsers.has(userId) &&
      text &&
      !text.startsWith("/") &&
      !msg.forward_from_chat
    ) {
      promoWaitingUsers.delete(userId);
      const code = text.trim();
      const res = await applyPromocode(userId, code);
      return bot.sendMessage(msg.chat.id, res.message);
    }

    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      streamerConfig[userId] = streamerConfig[userId] || {};
      streamerConfig[userId].channelId = msg.forward_from_chat.id;

      return bot.sendMessage(
        msg.chat.id,
        `Канал подключён: ${msg.forward_from_chat.title}.\nТеперь отправьте ссылку на стрим.`
      );
    }

    if (text.startsWith("/")) return;
    if (!text.startsWith("http://") && !text.startsWith("https://")) return;

    const cfg = streamerConfig[userId];
    if (!cfg || !cfg.channelId) {
      return bot.sendMessage(
        msg.chat.id,
        "Сначала подключите канал:\n1. Добавьте бота в админы.\n2. Перешлите сообщение из канала сюда."
      );
    }

    const enough = await ensureBalanceForPost(userId, msg.chat.id);
    if (!enough) return;

    const embed = getEmbed(text);
    const thumb = await getThumbnail(text);

    await publishStreamPost(cfg.channelId, embed, thumb, cfg.donateName);
    await chargeForPost(userId);

    const user = await getOrCreateUser(userId);
    bot.sendMessage(
      msg.chat.id,
      `Готово! Списано ${PRICE_PER_POST} ₽.\nБаланс: ${Math.round(
        user.balance
      )} ₽.`
    );
  } catch (err) {
    console.error("msg error:", err);
  }
});

// ================== OAUTH CALLBACK ==================
app.get(DA_REDIRECT_PATH, async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Нет параметра code.");

  try {
    await exchangeCodeForToken(String(code));
    await startDonationAlertsRealtime();
    res.send("DonationAlerts успешно авторизован!");
  } catch (err) {
    console.error("OAuth error:", err.response?.data || err.message);
    res.status(500).send("Ошибка авторизации.");
  }
});

// ================== START ==================
async function start() {
  await initMongo();
  await loadDaTokensFromDb();

  if (daAccessToken) {
    startDonationAlertsRealtime().catch((e) =>
      console.error("Ошибка realtime:", e.message)
    );
  } else {
    console.log("DA OAuth не выполнен. Используйте /da");
  }

  app.listen(PORT, () => console.log("SERVER RUNNING ON PORT", PORT));
}

start().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
