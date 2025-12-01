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

// username бота — нужен для deep-link `https://t.me/<bot>?start=raffle_<id>`
const BOT_USERNAME = process.env.BOT_USERNAME || "tgstrm_bot";

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

async function createDraftRaffle(ownerId, channel) {
  const doc = {
    ownerId,
    channelId: channel?.id || null,
    channelTitle: channel?.title || null,
    channelUsername: channel?.username || null,
    text: null,
    imageFileId: null,
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

async function getRaffle(id) {
  return rafflesCol.findOne({ _id: new ObjectId(id) });
}

// активные розыгрыши конкретного владельца (только "active")
async function getActiveRafflesByOwner(ownerId) {
  return rafflesCol
    .find({ ownerId, status: "active" })
    .sort({ createdAt: -1 })
    .toArray();
}

async function addParticipantDisplay(raffleId, display) {
  await rafflesCol.updateOne(
    { _id: new ObjectId(raffleId) },
    { $addToSet: { participants: display } }
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
      channels: [], // [{id, title, username}]
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
      $setOnInsert: { createdAt: new Date(), channels: [] },
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
const streamerConfig = {};

// состояние диалогов
// userState[uid] = { mode: 'connect_channel' | 'raffle', step: '...', draftId: '...' }
const userState = {};

const promoWaitingUsers = new Set();

// ===== /donate (привязка имени для доната) =====
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

// ===== /create промокод (только для владельца) =====
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

// ===== /da — авторизация DA (оставляем) =====
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

// ===== /balance (инфо по балансу, пока не используем для постов) =====
bot.onText(/\/balance/, async (msg) => {
  const user = await getOrCreateUser(msg.from.id);
  const bal = user.balance || 0;

  bot.sendMessage(msg.chat.id, `Ваш баланс: ${Math.round(bal)} ₽.`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Ввести промокод", callback_data: "promo_enter" }],
      ],
    },
  });
});

// ================== CALLBACK QUERY ==================
bot.on("callback_query", async (query) => {
  const { id, from, data, message } = query;
  const uid = from.id;
  const chatId = message?.chat?.id;

  try {
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

// ================== ВСПОМОГАТЕЛЬНОЕ: КАНАЛЫ ПОЛЬЗОВАТЕЛЯ ==================

async function addUserChannel(tgId, chat) {
  const user = await getOrCreateUser(tgId);
  const channels = user.channels || [];
  const exists = channels.some((c) => c.id === chat.id);
  if (!exists) {
    channels.push({
      id: chat.id,
      title: chat.title || "Без названия",
      username: chat.username || null,
    });
    await usersCol.updateOne(
      { tgId },
      {
        $set: { channels, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date(), balance: 0 },
      },
      { upsert: true }
    );
  }
  return channels;
}

// ================== ПУБЛИКАЦИЯ РОЗЫГРЫША В КАНАЛ ==================

async function publishRafflePost(raffle) {
  const channelId = raffle.channelId;
  if (!channelId) {
    throw new Error("У розыгрыша нет channelId");
  }

  const deepLink = `https://t.me/${BOT_USERNAME}?start=raffle_${raffle._id.toString()}`;

  const captionLines = [];
  captionLines.push("🎁 *Розыгрыш*");
  if (raffle.text) {
    captionLines.push("");
    captionLines.push(raffle.text);
  }
  captionLines.push("");
  captionLines.push("Нажмите кнопку ниже, чтобы участвовать.");
  const caption = captionLines.join("\n");

  const reply_markup = {
    inline_keyboard: [[{ text: "🎉 Участвовать", url: deepLink }]],
  };

  if (raffle.imageFileId) {
    await bot.sendPhoto(channelId, raffle.imageFileId, {
      caption,
      parse_mode: "Markdown",
      reply_markup,
    });
  } else {
    await bot.sendMessage(channelId, caption, {
      parse_mode: "Markdown",
      reply_markup,
    });
  }
}

// ================== ГЛАВНОЕ МЕНЮ /start ==================

function buildMainMenu() {
  return {
    keyboard: [
      [
        { text: "🎁 Создать розыгрыш" },
        { text: "📋 Мои розыгрыши" },
      ],
      [
        { text: "📣 Мои каналы" },
        { text: "🎥 Отправить стрим" },
      ],
      [
        { text: "⭐ Поддержать бота" },
        { text: "📘 Инструкция" },
      ],
    ],
    resize_keyboard: true,
  };
}

// ================== ОБРАБОТКА СООБЩЕНИЙ ==================

bot.on("message", async (msg) => {
  try {
    if (!msg.from || !msg.chat) return;
    const chatId = msg.chat.id;
    const uid = msg.from.id;
    const text = msg.text || "";
    const isPrivate = msg.chat.type === "private";

    // /start с payload (deep link, например raffle_<id>)
    if (text.startsWith("/start")) {
      const payload = text.split(" ").slice(1).join(" ").trim();
      userState[uid] = {}; // сбрасываем состояние

      if (payload && payload.startsWith("raffle_")) {
        const raffleId = payload.replace("raffle_", "");
        const raffle = await getRaffle(raffleId).catch(() => null);

        if (!raffle || raffle.status !== "active") {
          await bot.sendMessage(
            chatId,
            "Этот розыгрыш не найден или уже завершён.",
            { reply_markup: buildMainMenu() }
          );
          return;
        }

        await bot.sendMessage(
          chatId,
          `🎁 Вы перешли из поста с розыгрышем.\n\nНажмите кнопку ниже, чтобы открыть мини-приложение и участвовать:`,
          {
            reply_markup: {
              keyboard: [
                [
                  {
                    text: "🎉 Участвовать в розыгрыше",
                    web_app: {
                      url: `${RENDER_URL}/giveaway/?id=${encodeURIComponent(
                        raffleId
                      )}`,
                    },
                  },
                ],
              ],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          }
        );
        return;
      }

      // обычный /start без payload
      const name = msg.from.first_name || "друг";
      const textStart =
        `👋 Привет, *${name}*!\n\n` +
        `Этот бот помогает:\n` +
        `• публиковать стримы в канал\n` +
        `• создавать розыгрыши\n` +
        `• проверять подписки\n` +
        `• проводить честный выбор победителя\n\n` +
        `Выберите действие:`;

      await bot.sendMessage(chatId, textStart, {
        parse_mode: "Markdown",
        reply_markup: buildMainMenu(),
      });
      return;
    }

    // дальше работаем только в личке, остальное игнорим
    if (!isPrivate) return;

    const state = userState[uid] || null;

    // ===== 1. Промокоды =====
    if (promoWaitingUsers.has(uid) && text) {
      promoWaitingUsers.delete(uid);
      const res = await applyPromocode(uid, text);
      await bot.sendMessage(chatId, res.message);
      return;
    }

    // ===== 2. Подключение канала (mode: connect_channel) =====
    if (state?.mode === "connect_channel") {
      if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
        const ch = msg.forward_from_chat;
        const channels = await addUserChannel(uid, ch);

        userState[uid] = {}; // сбрасываем

        await bot.sendMessage(
          chatId,
          `📢 Канал подключён:\n${ch.title || ch.username || ch.id}`
        );

        let listText = "Ваши каналы:\n\n";
        for (const c of channels) {
          const line = c.username ? `• @${c.username}` : `• ${c.title} (${c.id})`;
          listText += line + "\n";
        }

        await bot.sendMessage(chatId, listText, {
          reply_markup: buildMainMenu(),
        });
        return;
      } else {
        await bot.sendMessage(
          chatId,
          "Это не похоже на пересланное сообщение из канала.\n" +
            "Пожалуйста, перешлите сюда любое сообщение из нужного канала."
        );
        return;
      }
    }

    // ===== 3. Создание розыгрыша (mode: raffle) =====
    if (state?.mode === "raffle") {
      const draftId = state.draftId;
      if (!draftId) {
        userState[uid] = {};
        await bot.sendMessage(
          chatId,
          "Черновик розыгрыша не найден. Попробуйте начать заново.",
          { reply_markup: buildMainMenu() }
        );
        return;
      }

      // шаг 1: текст/фото
      if (state.step === "wait_text_or_photo") {
        const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;

        if (hasPhoto) {
          const photo = msg.photo[msg.photo.length - 1];
          await updateRaffle(draftId, { imageFileId: photo.file_id });

          if (msg.caption && msg.caption.trim().length > 0) {
            await updateRaffle(draftId, { text: msg.caption.trim() });

            userState[uid].step = "wait_subs";
            await bot.sendMessage(
              chatId,
              "📌 Теперь отправьте список каналов, на которые нужно подписаться.\n\n" +
                "Формат: @channel1 @channel2 @channel3\n" +
                "Если подписки не нужны — отправьте «нет»."
            );
            return;
          } else {
            userState[uid].step = "wait_text_after_photo";
            await bot.sendMessage(
              chatId,
              "📸 Фото сохранено.\nТеперь пришлите текст розыгрыша."
            );
            return;
          }
        }

        // только текст, без фото
        if (text && text.trim().length > 0) {
          await updateRaffle(draftId, { text: text.trim() });
          userState[uid].step = "wait_subs";

          await bot.sendMessage(
            chatId,
            "📌 Теперь отправьте список каналов, на которые нужно подписаться.\n\n" +
              "Формат: @channel1 @channel2 @channel3\n" +
              "Если подписки не нужны — отправьте «нет»."
          );
          return;
        }

        await bot.sendMessage(
          chatId,
          "Отправьте, пожалуйста, текст розыгрыша (можно с одним фото)."
        );
        return;
      }

      // шаг 1.1: текст после фото
      if (state.step === "wait_text_after_photo") {
        if (!text || !text.trim()) {
          await bot.sendMessage(
            chatId,
            "Пришлите текст розыгрыша одним сообщением."
          );
          return;
        }
        await updateRaffle(draftId, { text: text.trim() });
        userState[uid].step = "wait_subs";

        await bot.sendMessage(
          chatId,
          "📌 Теперь отправьте список каналов, на которые нужно подписаться.\n\n" +
            "Формат: @channel1 @channel2 @channel3\n" +
            "Если подписки не нужны — отправьте «нет»."
        );
        return;
      }

      // шаг 2: список каналов для подписки
      if (state.step === "wait_subs") {
        if (!text || !text.trim()) {
          await bot.sendMessage(
            chatId,
            "Отправьте @юзернеймы каналов через пробел или «нет»."
          );
          return;
        }

        const lower = text.trim().toLowerCase();
        let requiredSubs = [];

        if (lower !== "нет") {
          const parts = text.split(/\s+/);
          requiredSubs = parts
            .map((p) => p.trim())
            .filter((p) => p.startsWith("@"))
            .map((p) => p.toLowerCase());
        }

        await updateRaffle(draftId, { requiredSubs });

        userState[uid].step = "wait_end_time";

        await bot.sendMessage(
          chatId,
          "⏳ Теперь укажите ВРЕМЯ ОКОНЧАНИЯ.\n\n" +
            "Формат:\n" +
            "дд.мм.гггг чч:мм\n\n" +
            "Например:\n" +
            "29.03.2025 13:00\n\n" +
            "Время считается по вашему часовому поясу (как в приложении Telegram)."
        );
        return;
      }

      // шаг 3: время окончания
      if (state.step === "wait_end_time") {
        if (!text || !text.trim()) {
          await bot.sendMessage(
            chatId,
            "Укажите дату и время окончания в формате дд.мм.гггг чч:мм."
          );
          return;
        }

        const pattern =
          /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/;
        const m = text.trim().match(pattern);
        if (!m) {
          await bot.sendMessage(
            chatId,
            "❌ Неверный формат даты.\nПример: 29.03.2025 13:00"
          );
          return;
        }

        const day = parseInt(m[1], 10);
        const month = parseInt(m[2], 10) - 1;
        const year = parseInt(m[3], 10);
        const hour = parseInt(m[4], 10);
        const minute = parseInt(m[5], 10);

        const endAt = new Date(year, month, day, hour, minute, 0);
        const now = new Date();
        if (endAt.getTime() <= now.getTime()) {
          await bot.sendMessage(
            chatId,
            "❌ Время окончания уже в прошлом. Укажите будущую дату."
          );
          return;
        }

        await updateRaffle(draftId, {
          endAt,
          status: "active",
        });

        const raffle = await getRaffle(draftId);

        try {
          await publishRafflePost(raffle);
          await bot.sendMessage(
            chatId,
            "✅ Розыгрыш опубликован в ваш канал.",
            { reply_markup: buildMainMenu() }
          );
        } catch (err) {
          console.error("Ошибка публикации розыгрыша:", err);
          await bot.sendMessage(
            chatId,
            "❌ Не удалось опубликовать розыгрыш. Проверьте, что бот всё ещё администратор канала и имеет право публиковать сообщения.",
            { reply_markup: buildMainMenu() }
          );
        }

        userState[uid] = {};
        return;
      }
    }

    // ===== 4. Кнопки главного меню =====

    if (text === "🎁 Создать розыгрыш") {
      const user = await getOrCreateUser(uid);
      const channels = user.channels || [];

      if (!channels.length) {
        await bot.sendMessage(
          chatId,
          "❌ У вас не подключён ни один канал.\n\nСначала нажмите «📣 Мои каналы», добавьте бота в канал как администратора и перешлите сообщение из этого канала."
        );
        return;
      }

      const channel = channels[0]; // пока берём первый канал пользователя
      const draft = await createDraftRaffle(uid, channel);

      userState[uid] = {
        mode: "raffle",
        step: "wait_text_or_photo",
        draftId: draft._id.toString(),
      };

      await bot.sendMessage(
        chatId,
        "Создание розыгрыша:\n\n" +
          "✏️ Отправьте текст для розыгрыша.\n" +
          "Можно приложить одно фото — оно будет в посте."
      );
      return;
    }

    if (text === "📋 Мои розыгрыши") {
      const active = await getActiveRafflesByOwner(uid);
      if (!active.length) {
        await bot.sendMessage(
          chatId,
          "У вас пока нет активных розыгрышей.",
          { reply_markup: buildMainMenu() }
        );
        return;
      }

      let msgText = "📋 Ваши активные розыгрыши:\n\n";
      for (const r of active) {
        const dt = r.endAt ? new Date(r.endAt) : null;
        const endStr = dt
          ? `${dt.toLocaleDateString()} ${dt
              .toTimeString()
              .slice(0, 5)}`
          : "без даты окончания";

        msgText += `• ID: ${r._id.toString()}\n  Канал: ${
          r.channelTitle || r.channelUsername || r.channelId
        }\n  Завершится: ${endStr}\n\n`;
      }

      await bot.sendMessage(chatId, msgText, {
        reply_markup: buildMainMenu(),
      });
      return;
    }

    if (text === "📣 Мои каналы") {
      const user = await getOrCreateUser(uid);
      const channels = user.channels || [];

      if (!channels.length) {
        await bot.sendMessage(
          chatId,
          "🗒 Добавленные вами каналы: пока ни одного.\n\n" +
            "Инструкция:\n\n" +
            "1️⃣ Добавьте бота в канал как администратора с правом публикации.\n" +
            "2️⃣ Перешлите сюда любое сообщение из этого канала.\n" +
            "Бот автоматически запомнит канал."
        );
      } else {
        let listText = "🗒 Добавленные вами каналы:\n\n";
        for (const c of channels) {
          const line = c.username ? `• @${c.username}` : `• ${c.title} (${c.id})`;
          listText += line + "\n";
        }
        listText +=
          "\nЧтобы добавить ещё канал, перешлите сюда любое сообщение из него.";
        await bot.sendMessage(chatId, listText);
      }

      userState[uid] = { mode: "connect_channel" };
      return;
    }

    if (text === "🎥 Отправить стрим") {
      await bot.sendMessage(
        chatId,
        "Отправьте ссылку на стрим YouTube или Twitch — бот опубликует её в вашем канале (который вы подключили ранее)."
      );
      return;
    }

    if (text === "⭐ Поддержать бота") {
      await bot.sendMessage(
        chatId,
        "Спасибо за поддержку!\n\n" + DA_DONATE_URL,
        { reply_markup: buildMainMenu() }
      );
      return;
    }

    if (text === "📘 Инструкция") {
      await bot.sendMessage(
        chatId,
        "📘 *Краткая инструкция по боту:*\n\n" +
          "• 🎁 Создавайте розыгрыши через меню — бот опубликует пост в канал и даст ссылку на участие\n" +
          "• 📣 Подключение канала — через «Мои каналы» (перешлите сообщение из канала)\n" +
          "• 🎥 Отправка стрима — просто пришлите ссылку на трансляцию\n" +
          "• ⭐ Поддержать — поможет содержать сервер\n\n" +
          "Если нужна помощь — просто напишите мне в этом чате.",
        { parse_mode: "Markdown", reply_markup: buildMainMenu() }
      );
      return;
    }

    // если дошли сюда и есть состояние raffle/connect — оно уже обработано выше
    // всё остальное можно игнорировать или дописать лог позже
  } catch (err) {
    console.error("message handler error:", err);
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
      title: raffle.text || "",
    });
  } catch (err) {
    console.error("api raffle error:", err);
    res.json({ ok: false });
  }
});

app.get("/api/join", async (req, res) => {
  try {
    const id = req.query.id;
    const userIdRaw = req.query.userId;
    const usernameRaw = req.query.username || "";

    if (!id || !userIdRaw) return res.json({ ok: false });

    const userId = parseInt(userIdRaw, 10);
    if (!Number.isFinite(userId)) return res.json({ ok: false });

    const raffle = await getRaffle(id);
    if (!raffle || raffle.status !== "active") {
      return res.json({ ok: false, error: "ENDED" });
    }

    const now = new Date();
    if (raffle.endAt && now.getTime() >= new Date(raffle.endAt).getTime()) {
      return res.json({ ok: false, error: "ENDED" });
    }

    const username = usernameRaw || "";
    const display = username ? `@${username}` : `id:${userId}`;

    // проверяем подписки: сначала канал самого розыгрыша
    const notSubs = [];

    try {
      const member = await bot.getChatMember(raffle.channelId, userId);
      if (["left", "kicked"].includes(member.status)) {
        if (raffle.channelUsername) {
          notSubs.push(`@${raffle.channelUsername}`);
        } else if (raffle.channelTitle) {
          notSubs.push(raffle.channelTitle);
        } else {
          notSubs.push("канал розыгрыша");
        }
      }
    } catch {
      if (raffle.channelUsername) {
        notSubs.push(`@${raffle.channelUsername}`);
      } else if (raffle.channelTitle) {
        notSubs.push(raffle.channelTitle);
      } else {
        notSubs.push("канал розыгрыша");
      }
    }

    // затем дополнительные обязательные подписки
    const subs = raffle.requiredSubs || [];
    for (const ch of subs) {
      try {
        const member = await bot.getChatMember(ch, userId);
        if (["left", "kicked"].includes(member.status)) {
          notSubs.push(ch);
        }
      } catch {
        notSubs.push(ch);
      }
    }

    if (notSubs.length > 0) {
      return res.json({
        ok: false,
        error: "NOT_SUBSCRIBED",
        notSubs,
      });
    }

    await addParticipantDisplay(id, display);

    return res.json({ ok: true });
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
