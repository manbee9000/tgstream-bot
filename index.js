import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import { MongoClient, ObjectId } from "mongodb";
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

// ---- домен родителя для Twitch embed
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

// ====== выдача фронтенда рулетки
app.use("/giveaway", express.static("webapp/giveaway"));

// ================== HELPERS СТРИМОВ ==================
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

// =========================================================
// ================ MONGODB ================================
// =========================================================
let mongoClient;
let db;
let usersCol;
let ordersCol;
let promoCol;
let settingsCol;
let rafflesCol; // новая коллекция розыгрышей

async function initMongo() {
  if (!MONGODB_URI) {
    console.error("MONGODB_URI не задан, работа с БД отключена.");
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
    rafflesCol = db.collection("raffles");

    console.log("MongoDB подключен");
  } catch (err) {
    console.error("Ошибка подключения:", err.message);
  }
}

// =========================================================
// ============ ФУНКЦИИ ДЛЯ РОЗЫГРЫШЕЙ =====================
// =========================================================

async function createDraftRaffle(ownerId) {
  const doc = {
    ownerId,
    title: null,
    imageUrl: null,
    channelId: null,
    requiredSubs: [],
    startAt: null,
    endAt: null,
    participants: [],
    status: "draft", // draft | active | finished
    createdAt: new Date(),
  };

  const res = await rafflesCol.insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

async function updateRaffle(id, update) {
  await rafflesCol.updateOne(
    { _id: new ObjectId(id) },
    { $set: update }
  );
}

async function getActiveDraft(ownerId) {
  return rafflesCol.findOne({
    ownerId,
    status: "draft",
  });
}

async function getRaffle(id) {
  return rafflesCol.findOne({ _id: new ObjectId(id) });
}

async function addParticipant(raffleId, nickname) {
  await rafflesCol.updateOne(
    { _id: new ObjectId(raffleId) },
    { $addToSet: { participants: nickname } }
  );
}

// ================== SUPPORT BUTTON ==================
function supportKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "❤️ Поддержать сервера бота",
          url: DA_DONATE_URL,
        },
      ],
    ],
  };
}

// =========================================================
// ================== ПУБЛИКАЦИЯ СТРИМА ====================
// =========================================================

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

// =========================================================
// ================== ПРОМО + БАЛАНС =======================
// =========================================================

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

// ================== ЗАКАЗЫ (НА БУДУЩЕЕ) ==================
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

// ⚠ Сейчас делаем всё бесплатным: просто возвращаем true
async function ensureBalanceForPost(tgId, chatId) {
  return true;

  // СТАРАЯ ЛОГИКА НА БУДУЩЕЕ:
  // ...
}

async function chargeForPost(tgId) {
  if (!usersCol) return;
  await updateUserBalance(tgId, -PRICE_PER_POST);
}

// ================== DonationAlerts realtime ==============
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
    Object.prototype.hasOwnProperty.call(node, "id") &&
    Object.prototype.hasOwnProperty.call(node, "message") &&
    Object.prototype.hasOwnProperty.call(node, "amount") &&
    Object.prototype.hasOwnProperty.call(node, "currency");

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

// ================== TELEGRAM LOGIC ==================
const streamerConfig = {};

const raffleWaitImage = new Set();
const raffleWaitTitle = new Set();
const raffleWaitSubs = new Set();
const raffleWaitTime = new Set();
const promoWaitingUsers = new Set();

// /donate
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

// /create промокод
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

// /da — авторизация DA
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
        inline_keyboard: [
          [{ text: "Авторизовать DonationAlerts", url: authUrl }],
        ],
      },
    }
  );
});

// /giveaway — меню розыгрышей
bot.onText(/\/giveaway/, async (msg) => {
  const uid = msg.from.id;

  let draft = await getActiveDraft(uid);
  if (!draft) {
    draft = await createDraftRaffle(uid);
  }

  await bot.sendMessage(
    msg.chat.id,
    "🎁 *Меню розыгрышей*\n\nВыберите действие:",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📸 Загрузить картинку", callback_data: "raffle_image" }],
          [{ text: "📝 Задать название", callback_data: "raffle_title" }],
          [{ text: "🔗 Требуемые подписки", callback_data: "raffle_subs" }],
          [{ text: "⏱ Время старта/конца", callback_data: "raffle_time" }],
          [{ text: "📢 Опубликовать", callback_data: "raffle_publish" }],
          [{ text: "❤️ Поддержать", url: DA_DONATE_URL }],
        ],
      },
    }
  );
});

// ==========================================
// =============== НОВОЕ МЕНЮ ===============
// ==========================================

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || "друг";

  const text =
    `👋 Привет, *${name}*!\n\n` +
    `Этот бот помогает:\n` +
    `• создать розыгрыш\n` +
    `• публиковать стрим в канал\n` +
    `• подключить донаты\n` +
    `• управлять каналами\n\n` +
    `Выберите действие в меню ниже:`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        [
          { text: "🎁 Создать розыгрыш" },
          { text: "📋 Мои розыгрыши" }
        ],
        [
          { text: "📣 Мои каналы" },
          { text: "⚙️ Подключить донат" }
        ],
        [
          { text: "🎥 Отправить стрим" },
          { text: "⭐ Поддержать бота" }
        ],
        [
          { text: "📘 Инструкция" }
        ]
      ],
      resize_keyboard: true
    }
  });
});

// /balance пока оставляем (но платёж фактически не используется)
bot.onText(/\/balance/, async (msg) => {
  const user = await getOrCreateUser(msg.from.id);
  const bal = user.balance || 0;

  bot.sendMessage(msg.chat.id, `Ваш баланс: ${Math.round(bal)} ₽.`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Пополнить баланс", callback_data: "topup" }],
        [{ text: "Ввести промокод", callback_data: "promo_enter" }],
      ],
    },
  });
});

// ================== CALLBACK QUERY (ВСЁ ВМЕСТЕ) =========
bot.on("callback_query", async (query) => {
  const { id, from, data, message } = query;
  const uid = from.id;
  const chatId = message?.chat?.id;

  try {
    // ----- блок розыгрышей -----
    const draft = await getActiveDraft(uid);

    if (data === "raffle_image") {
      raffleWaitImage.add(uid);
      await bot.sendMessage(
        chatId,
        "Отправьте фото для розыгрыша одним сообщением."
      );
      return;
    }

    if (data === "raffle_title") {
      raffleWaitTitle.add(uid);
      await bot.sendMessage(chatId, "Введите название розыгрыша:");
      return;
    }

    if (data === "raffle_subs") {
      raffleWaitSubs.add(uid);
      await bot.sendMessage(
        chatId,
        "Введите через пробел @юзернеймы каналов, на которые нужно быть подписанным.\nНапример:\n`@volnaae @musicclub`\n\nЧтобы очистить список — отправьте `нет`.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (data === "raffle_time") {
      raffleWaitTime.add(uid);
      await bot.sendMessage(
        chatId,
        "Введите время старта и конца в формате:\n\n`2025-01-01 12:00 | 2025-01-01 12:10`"
      );
      return;
    }

    if (data === "raffle_publish") {
      if (!draft) {
        await bot.sendMessage(chatId, "Нет черновика.");
        return;
      }

      if (!draft.title || !draft.imageUrl || !draft.channelId || !draft.endAt) {
        await bot.sendMessage(
          chatId,
          "❗ Для публикации нужно указать:\n— фото\n— название\n— подключить канал (перешлите сообщение из канала)\n— время окончания"
        );
        return;
      }

      const url = `${RENDER_URL}/giveaway/?id=${draft._id.toString()}`;

      await bot.sendPhoto(draft.channelId, draft.imageUrl, {
        caption:
          `🎁 *${draft.title}*\n\nУчаствуйте в розыгрыше!\nНажмите кнопку ниже, чтобы попасть в список участников.`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🎉 Участвовать", url }]],
        },
      });

      await updateRaffle(draft._id, { status: "active" });
      await bot.sendMessage(chatId, "Розыгрыш опубликован!");
      return;
    }

    // ----- блок пополнения баланса (на будущее) -----
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
      return;
    }

    if (data.startsWith("pay_")) {
      const amount = parseInt(data.split("_")[1], 10);
      if (!amount || amount <= 0) {
        await bot.sendMessage(chatId, "Неверная сумма.");
        return;
      }

      const orderId = await createOrder(uid, chatId, amount);
      if (!orderId) {
        await bot.sendMessage(chatId, "Ошибка базы данных.");
        return;
      }

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
      return;
    }

    if (data === "promo_enter") {
      promoWaitingUsers.add(uid);
      await bot.sendMessage(chatId, "Введите промокод одним сообщением.");
      return;
    }
  } catch (err) {
    console.error("callback error:", err);
  } finally {
    try {
      await bot.answerCallbackQuery(id);
    } catch {}
  }
});

// ==========================================
// =========== ОБРАБОТКА КНОПОК МЕНЮ =========
// ==========================================
bot.on("message", async (msg) => {
  const text = msg.text;
  const chatId = msg.chat.id;
  const uid = msg.from.id;

  // 📌 Создать розыгрыш
  if (text === "🎁 Создать розыгрыш") {
    return bot.emit("text", { ...msg, text: "/giveaway" });
  }

  // 📌 Мои розыгрыши (позже можно сделать список черновиков + активных)
  if (text === "📋 Мои розыгрыши") {
    return bot.sendMessage(chatId, "Ваши розыгрыши появятся здесь (в разработке).");
  }

  // 📌 Мои каналы — подсказка как подключить
  if (text === "📣 Мои каналы") {
    return bot.sendMessage(
      chatId,
      "Чтобы подключить канал:\n\n" +
      "1. Добавьте бота в администраторы канала\n" +
      "2. Отправьте любое сообщение из канала сюда"
    );
  }

  // 📌 Подключить донат — просто инструкция
  if (text === "⚙️ Подключить донат") {
    return bot.sendMessage(
      chatId,
      "Введите команду в формате:\n\n`/donate ваш_донат_нейм`\n" +
      "Пример:\n`/donate volnaae_donate`",
      { parse_mode: "Markdown" }
    );
  }

  // 📌 Отправить стрим — инструкция
  if (text === "🎥 Отправить стрим") {
    return bot.sendMessage(
      chatId,
      "Отправьте ссылку на стрим YouTube или Twitch — бот опубликует её в вашем канале."
    );
  }

  // 📌 Поддержать бота — просто переход
  if (text === "⭐ Поддержать бота") {
    return bot.sendMessage(
      chatId,
      "Спасибо за поддержку 😍\n\n" + DA_DONATE_URL
    );
  }

  // 📌 Инструкция
  if (text === "📘 Инструкция") {
    return bot.sendMessage(
      chatId,
      "📘 *Краткая инструкция по боту:*\n\n" +
      "• 🎁 Создавайте розыгрыши через меню\n" +
      "• 🎥 Отправляйте стримы просто прислав ссылку\n" +
      "• 📣 Подключение канала — переслать сообщение из него\n" +
      "• ⚙️ Подключение доната — команда `/donate`\n" +
      "• ⭐ Поддержать — помогает содержать сервер\n\n" +
      "Если нужна помощь — я рядом ❤️",
      { parse_mode: "Markdown" }
    );
  }
});

// ======================================================================
// =============== API ДЛЯ WEBAPP (РУЛЕТКА) ==============================
// ======================================================================

app.get("/api/raffle", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.json({ ok: false });

    const raffle = await getRaffle(id);
    if (!raffle) return res.json({ ok: false });

    res.json({
      ok: true,
      participants: raffle.participants || [],
      endAt: raffle.endAt,
      title: raffle.title,
    });
  } catch (err) {
    console.error("api raffle error:", err);
    res.json({ ok: false });
  }
});

app.get("/api/join", async (req, res) => {
  try {
    const id = req.query.id;
    const nick = req.query.nick;

    if (!id || !nick) return res.json({ ok: false });

    await addParticipant(id, nick);

    res.json({ ok: true });
  } catch (err) {
    console.error("join error:", err);
    res.json({ ok: false });
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
