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
let rafflesCol; // коллекция розыгрышей

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

async function createDraftRaffle(ownerId, channelId) {
  const doc = {
    ownerId,
    channelId: channelId || null,
    title: null,
    imageUrl: null,
    requiredSubs: [],
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
const streamerConfig = {}; // по юзеру: { channelId, channelTitle, donateName }

// состояние мастера розыгрыша
// userState[uid] = { step, draftId }
const userState = new Map();

// промокоды
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

// ===== мастер создания розыгрыша =====
async function startGiveaway(uid, chatId) {
  const cfg = streamerConfig[uid];
  if (!cfg || !cfg.channelId) {
    await bot.sendMessage(
      chatId,
      "❌ У вас не подключён ни один канал.\n\nСначала нажмите «📢 Подключить канал» и перешлите сюда сообщение из вашего канала."
    );
    return;
  }

  const draft = await createDraftRaffle(uid, cfg.channelId);

  userState.set(uid, {
    step: "await_desc",
    draftId: draft._id.toString(),
  });

  await bot.sendMessage(
    chatId,
    "✏️ Введите описание розыгрыша.\n\nВы можете:\n• отправить только текст, или\n• отправить текст с одним фото в ОДНОМ сообщении, или\n• сначала отправить фото, потом текст."
  );
}

// /giveaway как алиас на мастер
bot.onText(/\/giveaway/, async (msg) => {
  await startGiveaway(msg.from.id, msg.chat.id);
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
    `• публиковать стримы в канал\n` +
    `• создавать розыгрыши\n` +
    `• проверять подписки\n` +
    `• проводить честный розыгрыш с рулеткой\n\n` +
    `Выберите действие в меню ниже:`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        [
          { text: "🎁 Создать розыгрыш" },
          { text: "📢 Подключить канал" }
        ],
        [
          { text: "🎥 Отправить стрим" },
          { text: "⚙️ Подключить донат" }
        ],
        [
          { text: "⭐ Поддержать бота" },
          { text: "📘 Инструкция" }
        ]
      ],
      resize_keyboard: true,
    },
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

// ================== CALLBACK QUERY (ТОПАП/ПРОМО) =========
bot.on("callback_query", async (query) => {
  const { id, from, data, message } = query;
  const uid = from.id;
  const chatId = message?.chat?.id;

  try {
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

    if (data && data.startsWith("pay_")) {
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
// =========== ОБЩИЙ ОБРАБОТЧИК MESSAGE =====
// ==========================================
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const uid = msg.from.id;
    const text = msg.text || "";

    // 1) Промокод — отдельный режим
    if (
      promoWaitingUsers.has(uid) &&
      text &&
      !text.startsWith("/") &&
      !msg.forward_from_chat
    ) {
      promoWaitingUsers.delete(uid);
      const res = await applyPromocode(uid, text.trim());
      await bot.sendMessage(chatId, res.message);
      return;
    }

    // 2) Подключение канала — пересланное сообщение из канала
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      streamerConfig[uid] = streamerConfig[uid] || {};
      streamerConfig[uid].channelId = msg.forward_from_chat.id;
      streamerConfig[uid].channelTitle = msg.forward_from_chat.title || "канал";

      await bot.sendMessage(
        chatId,
        `📢 Канал подключён:\n${streamerConfig[uid].channelTitle}\n\nТеперь можно создавать розыгрыши или отправлять стримы.`
      );
      return;
    }

    // 3) Обработка кнопок меню
    if (text === "🎁 Создать розыгрыш") {
      await startGiveaway(uid, chatId);
      return;
    }

    if (text === "📢 Подключить канал") {
      await bot.sendMessage(
        chatId,
        "Чтобы подключить канал:\n\n" +
          "1️⃣ Добавьте бота в ваш канал как администратора с правом публикации.\n" +
          "2️⃣ Перешлите сюда любое сообщение из этого канала.\n\n" +
          "После этого бот запомнит канал и сможет публиковать туда стримы и розыгрыши."
      );
      return;
    }

    if (text === "🎥 Отправить стрим") {
      await bot.sendMessage(
        chatId,
        "Чтобы опубликовать стрим:\n\n" +
          "1️⃣ Убедитесь, что канал подключён (кнопка «📢 Подключить канал»).\n" +
          "2️⃣ Просто отправьте сюда ссылку на стрим YouTube или Twitch.\n\n" +
          "Бот сделает пост в канале с кнопкой «Смотреть стрим»."
      );
      return;
    }

    if (text === "⚙️ Подключить донат") {
      await bot.sendMessage(
        chatId,
        "Чтобы подключить донаты к стриму, используйте команду:\n\n" +
          "`/donate ваш_донат_нейм`\n\n" +
          "Пример:\n`/donate volnaae_donate`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (text === "⭐ Поддержать бота") {
      await bot.sendMessage(
        chatId,
        "Спасибо за поддержку ❤️\n\n" + DA_DONATE_URL
      );
      return;
    }

    if (text === "📘 Инструкция") {
      await bot.sendMessage(
        chatId,
        "📘 *Краткая инструкция по боту:*\n\n" +
          "• 📢 Подключите канал — добавьте бота в админы и перешлите сообщение.\n" +
          "• 🎁 Создайте розыгрыш — мастер попросит описание, подписки и время окончания.\n" +
          "• 🎥 Отправьте ссылку на стрим — бот опубликует пост в канале.\n" +
          "• ⚙️ Подключите донат через `/donate`.\n" +
          "• ⭐ Поддержать — помогает оплачивать сервера.\n\n" +
          "Сейчас все функции по публикации стримов и розыгрышей доступны бесплатно.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    // 4) Команды обрабатываются через onText — здесь не трогаем
    if (text.startsWith("/")) {
      return;
    }

    // 5) Мастер розыгрыша — пошаговый сценарий
    const state = userState.get(uid);
    if (state) {
      const { step, draftId } = state;

      // шаг 1: описание (текст + опционально фото)
      if (step === "await_desc") {
        let description = "";
        let imageUrl = null;

        if (msg.photo && msg.photo.length > 0) {
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          const link = await bot.getFileLink(fileId);
          imageUrl = link;

          if (msg.caption && msg.caption.trim()) {
            description = msg.caption.trim();
          } else if (text && text.trim()) {
            description = text.trim();
          }
        } else if (text && text.trim()) {
          description = text.trim();
        }

        if (!description && !imageUrl) {
          await bot.sendMessage(
            chatId,
            "Не понял сообщение.\nОтправьте, пожалуйста, текст розыгрыша (можно с одним фото)."
          );
          return;
        }

        await updateRaffle(draftId, {
          title: description,
          imageUrl: imageUrl || null,
        });

        userState.set(uid, {
          step: "await_subs",
          draftId,
        });

        await bot.sendMessage(
          chatId,
          "📌 Теперь отправьте список каналов, на которые нужно подписаться.\n\n" +
            "Формат: `@channel1 @channel2 @channel3`\n" +
            "Если дополнительные подписки не нужны — отправьте слово `нет`.\n\n" +
            "Подписка на канал, где выйдет пост с розыгрышем, подразумевается по умолчанию.",
          { parse_mode: "Markdown" }
        );
        return;
      }

      // шаг 2: обязательные подписки
      if (step === "await_subs") {
        if (!text) {
          await bot.sendMessage(
            chatId,
            "Отправьте, пожалуйста, список каналов в виде текста или слово `нет`."
          );
          return;
        }

        const lower = text.trim().toLowerCase();
        let subs = [];

        if (lower !== "нет") {
          subs = text
            .split(/\s+/)
            .map((x) => x.trim())
            .filter((x) => x.startsWith("@"));
        }

        await updateRaffle(draftId, {
          requiredSubs: subs,
        });

        userState.set(uid, {
          step: "await_end",
          draftId,
        });

        await bot.sendMessage(
          chatId,
          "⏳ Теперь укажите *время окончания* розыгрыша.\n\n" +
            "Формат: `дд.мм.гггг чч:мм`\n" +
            "Например: `29.03.2025 13:00`",
          { parse_mode: "Markdown" }
        );
        return;
      }

      // шаг 3: время окончания
      if (step === "await_end") {
        if (!text) {
          await bot.sendMessage(
            chatId,
            "Отправьте, пожалуйста, дату и время в формате `дд.мм.гггг чч:мм`."
          );
          return;
        }

        const raw = text.trim();
        const match = raw.match(
          /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/
        );
        if (!match) {
          await bot.sendMessage(
            chatId,
            "❌ Неверный формат даты.\nПример: `01.12.2025 12:30`.",
            { parse_mode: "Markdown" }
          );
          return;
        }

        const [, dd, mm, yyyy, hh, min] = match;
        const endAt = new Date(
          Number(yyyy),
          Number(mm) - 1,
          Number(dd),
          Number(hh),
          Number(min)
        );

        if (Number.isNaN(endAt.getTime())) {
          await bot.sendMessage(
            chatId,
            "❌ Не получилось разобрать дату, попробуйте ещё раз.\nФормат: `дд.мм.гггг чч:мм`.",
            { parse_mode: "Markdown" }
          );
          return;
        }

        await updateRaffle(draftId, {
          endAt,
        });

        // публикация
        const raffle = await getRaffle(draftId);
        const cfg = streamerConfig[uid];

        if (!cfg || !cfg.channelId) {
          await bot.sendMessage(
            chatId,
            "Канал куда публиковать розыгрыш не найден. Подключите канал и начните заново."
          );
          userState.delete(uid);
          return;
        }

        const url = `${RENDER_URL}/giveaway/?id=${draftId}`;

        const caption =
          `🎁 *Розыгрыш*\n\n` +
          `${raffle.title || "Участвуйте в розыгрыше!"}\n\n` +
          `Нажмите кнопку ниже, чтобы участвовать.`;

        const inlineKeyboard = [
          [
            {
              text: "🎉 Участвовать",
              url,
            },
          ],
        ];

        try {
          if (raffle.imageUrl) {
            await bot.sendPhoto(cfg.channelId, raffle.imageUrl, {
              caption,
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: inlineKeyboard },
            });
          } else {
            await bot.sendMessage(cfg.channelId, caption, {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: inlineKeyboard },
            });
          }

          await updateRaffle(draftId, { status: "active" });
          userState.delete(uid);

          await bot.sendMessage(chatId, "✅ Розыгрыш опубликован в вашем канале.");
        } catch (err) {
          console.error("Ошибка публикации розыгрыша:", err);
          await bot.sendMessage(
            chatId,
            "❌ Не удалось опубликовать розыгрыш. Проверьте, что бот всё ещё администратор канала."
          );
        }

        return;
      }
    }

    // 6) Если не в мастере и это ссылка — логика стримов
    if (text.startsWith("http://") || text.startsWith("https://")) {
      const cfg = streamerConfig[uid];
      if (!cfg || !cfg.channelId) {
        await bot.sendMessage(
          chatId,
          "Сначала подключите канал:\n1. Добавьте бота в админы канала.\n2. Перешлите сообщение из канала сюда."
        );
        return;
      }

      const enough = await ensureBalanceForPost(uid, chatId);
      if (!enough) return;

      const embed = getEmbed(text);
      const thumb = await getThumbnail(text);

      await publishStreamPost(cfg.channelId, embed, thumb, cfg.donateName);
      await chargeForPost(uid);

      const user = await getOrCreateUser(uid);
      await bot.sendMessage(
        chatId,
        `Готово! Баланс: ${Math.round(user.balance || 0)} ₽.`
      );
      return;
    }

    // 7) Всё остальное — игнорируем
  } catch (err) {
    console.error("msg error:", err);
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
