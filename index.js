import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import { MongoClient, ObjectId } from "mongodb";
import WebSocket from "ws";

// ================== CONFIG ==================
const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;

const DA_DONATE_URL =
  process.env.DA_DONATE_URL || "https://dalink.to/mystreambot";

const DA_CLIENT_ID = process.env.DA_CLIENT_ID || null;
const DA_CLIENT_SECRET = process.env.DA_CLIENT_SECRET || null;
const DA_SCOPES =
  process.env.DA_SCOPES ||
  "oauth-user-show oauth-donation-subscribe";
const DA_REDIRECT_PATH =
  process.env.DA_REDIRECT_PATH || "/da-oauth";

const ADMIN_TG_ID = 618072923;
const BOT_USERNAME = process.env.BOT_USERNAME; // важно: без @

// Twitch domain
let PARENT_DOMAIN = "localhost";
try {
  if (RENDER_URL) PARENT_DOMAIN = new URL(RENDER_URL).host;
} catch {}

// ================== EXPRESS ==================
const app = express();
app.use(express.json());

// ================== TELEGRAM WEBHOOK ==================
if (!TOKEN) {
  console.error("BOT_TOKEN не задан");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { webHook: true });

bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================== STATIC WEBAPP ==================
app.use("/giveaway", express.static("webapp/giveaway"));

// ================== DB ==================
let db;
let usersCol;
let rafflesCol;
let ordersCol;
let promoCol;
let settingsCol;

async function initMongo() {
  const mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  db = mongoClient.db();

  usersCol = db.collection("users");
  rafflesCol = db.collection("raffles");

  ordersCol = db.collection("orders");
  promoCol = db.collection("promocodes");
  settingsCol = db.collection("settings");

  console.log("MongoDB connected");
}

// ================== STREAM HELPERS ==================
function extractYouTubeId(url) {
  try {
    if (url.includes("watch?v="))
      return url.split("v=")[1].split("&")[0];
    if (url.includes("youtu.be/"))
      return url.split("youtu.be/")[1].split("?")[0];
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

  return url;
}

// ================== ПУБЛИКАЦИЯ СТРИМА ==================
async function publishStreamPost(channelId, embedUrl, thumbnail, donateName) {
  const buttons = [
    [
      {
        text: "🎥 Смотреть стрим",
        url: `${RENDER_URL}/webapp?src=${encodeURIComponent(embedUrl)}`
      }
    ]
  ];

  if (donateName) {
    buttons.push([
      {
        text: "💸 Донат",
        url: `https://www.donationalerts.com/r/${donateName}`
      }
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
      reply_markup: { inline_keyboard: buttons }
    });
  } else {
    await bot.sendMessage(channelId, caption, {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  await bot.sendMessage(channelId, "💬 Чат стрима");
}

// ================== DONATIONALERTS (BALANCE) ==================
let daAccessToken = null;
let daRefreshToken = null;
let daTokenExpiresAt = null;
let daUserId = null;

let daWs = null;
let daWsClientId = null;
let daReconnectTimer = null;

// LOADING TOKENS
async function loadDaTokensFromDb() {
  if (!settingsCol) return;
  const doc = await settingsCol.findOne({ _id: "da_oauth" });
  if (!doc) return;

  daAccessToken = doc.accessToken || null;
  daRefreshToken = doc.refreshToken || null;
  daTokenExpiresAt = doc.expiresAt
    ? new Date(doc.expiresAt)
    : null;
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
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );
}

// EXCHANGE TOKEN
async function exchangeCodeForToken(code) {
  if (!DA_CLIENT_ID || !DA_CLIENT_SECRET) {
    throw new Error("DA CLIENT_ID или DA_CLIENT_SECRET не заданы.");
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
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  const data = resp.data || {};

  daAccessToken = data.access_token;
  daRefreshToken = data.refresh_token || null;
  daTokenExpiresAt = new Date(
    Date.now() +
      (data.expires_in
        ? data.expires_in * 1000
        : 3600 * 1000)
  );

  await saveDaTokensToDb();
}

// REFRESH TOKEN
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
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    const data = resp.data || {};

    daAccessToken = data.access_token;
    daRefreshToken = data.refresh_token || daRefreshToken;
    daTokenExpiresAt = new Date(
      Date.now() +
        (data.expires_in
          ? data.expires_in * 1000
          : 3600 * 1000)
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
// FETCH DA USER INFO
async function fetchDaUserInfo() {
  if (!daAccessToken) return null;

  const resp = await axios.get(
    "https://www.donationalerts.com/api/v1/user/oauth",
    { headers: { Authorization: `Bearer ${daAccessToken}` } }
  );

  const data = resp.data?.data || resp.data || {};
  return data;
}

// FIND DONATION IN WS PAYLOAD
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
    message: donation.message
  });

  const msg = donation.message || "";
  const match = msg.match(/ORDER_([a-zA-Z0-9]+)/);

  if (!match) return;

  const orderId = match[1];
  const order = await ordersCol.findOne({
    orderId,
    status: "pending"
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
        donationId: donation.id
      }
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

// ================== START DA REALTIME ==================
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

    const wsUrl =
      "wss://centrifugo.donationalerts.com/connection/websocket";

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
          id: 1
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
              client: daWsClientId
            },
            {
              headers: {
                Authorization: `Bearer ${daAccessToken}`,
                "Content-Type": "application/json"
              }
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
              id: 2
            })
          );

          console.log("Подписка:", ch.channel);
        } catch (err) {
          console.error(
            "Ошибка подписки:",
            err.response?.data || err.message
          );
        }

        return;
      }

      if (msg.id === 2) return;

      const donation = extractDonationFromWsMessage(msg);
      if (donation) await handleDonation(donation);
    });

    daWs.on("close", () => {
      console.log("DA WS закрыт. Переподключение…");
      scheduleDaReconnect();
    });

    daWs.on("error", (err) => {
      console.error("DA WS ERROR:", err.message);
    });
  } catch (err) {
    console.error(
      "Realtime error:",
      err.response?.data || err.message
    );
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

// ================= TELEGRAM COMMANDS ==================
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

bot.onText(/\/da/, async (msg) => {
  if (msg.from.id !== ADMIN_TG_ID) {
    return bot.sendMessage(
      msg.chat.id,
      "Команда доступна только владельцу."
    );
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
          [{ text: "Авторизовать DonationAlerts", url: authUrl }]
        ]
      }
    }
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
// ================== /start ==================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(
    chatId,
    "👋 Добро пожаловать!\n\n" +
      "Этот бот умеет:\n" +
      "• публиковать стримы в канал\n" +
      "• подключать донаты DonationAlerts (/donate)\n" +
      "• создавать розыгрыши с мини-приложением\n" +
      "• поддерживать баланс через промокоды и оплату\n\n" +
      "Выберите действие:",
    { reply_markup: buildMainMenu() }
  );
});

// ================== CALLBACKS ==================
const promoWaitingUsers = new Set();

bot.on("callback_query", async (query) => {
  const { id, from, data, message } = query;
  const chatId = message?.chat?.id;
  const userId = from.id;

  try {
    if (data === "topup") {
      const text =
        "💳 Выберите сумму пополнения.\n" +
        "После доната баланс обновится автоматически.\n\n" +
        "**Важно:** в комментарии доната должен быть код `ORDER_xxx`.";

      await bot.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "100 ₽", callback_data: "pay_100" },
              { text: "300 ₽", callback_data: "pay_300" }
            ],
            [
              { text: "500 ₽", callback_data: "pay_500" },
              { text: "1000 ₽", callback_data: "pay_1000" }
            ],
            [{ text: "10000 ₽", callback_data: "pay_10000" }]
          ]
        },
        parse_mode: "Markdown"
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
        `Для пополнения баланса на ${amount} ₽ перейдите по ссылке:\n\n` +
        `\`ORDER_${orderId}\` — вставьте этот код в комментарий к донату.\n\n` +
        `Ссылка на оплату ниже.`;

      await bot.sendMessage(chatId, txt, {
        reply_markup: {
          inline_keyboard: [[{ text: "Оплатить", url: payUrl }]]
        },
        parse_mode: "Markdown"
      });
    }

    else if (data === "promo_enter") {
      promoWaitingUsers.add(userId);
      bot.sendMessage(chatId, "Введите промокод одним сообщением:");
    }

  } catch (err) {
    console.error("callback error:", err);
  } finally {
    try {
      await bot.answerCallbackQuery(id);
    } catch {}
  }
});

// ================== /balance ==================
bot.onText(/\/balance/, async (msg) => {
  const user = await getOrCreateUser(msg.from.id);
  const bal = user.balance || 0;

  await bot.sendMessage(
    msg.chat.id,
    `Ваш баланс: ${Math.round(bal)} ₽.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Пополнить баланс", callback_data: "topup" }],
          [{ text: "Ввести промокод", callback_data: "promo_enter" }]
        ]
      }
    }
  );
});

// ================== STREAM POST HANDLER ==================
bot.on("message", async (msg) => {
  try {
    const text = msg.text || "";
    const userId = msg.from.id;

    // активация промокода
    if (
      promoWaitingUsers.has(userId) &&
      text &&
      !text.startsWith("/") &&
      !msg.forward_from_chat
    ) {
      promoWaitingUsers.delete(userId);
      const res = await applyPromocode(userId, text.trim());
      return bot.sendMessage(msg.chat.id, res.message);
    }

    // подключение канала
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      streamerConfig[userId] = streamerConfig[userId] || {};
      streamerConfig[userId].channelId = msg.forward_from_chat.id;

      return bot.sendMessage(
        msg.chat.id,
        `Канал подключён: ${msg.forward_from_chat.title}.\nТеперь отправьте ссылку на стрим.`
      );
    }

    // стрим: только ссылки
    if (text.startsWith("/") || !text.startsWith("http")) return;

    const cfg = streamerConfig[userId];
    if (!cfg || !cfg.channelId) {
      return bot.sendMessage(
        msg.chat.id,
        "Сначала подключите канал:\n1) добавьте бота в админы\n2) перешлите сообщение из канала"
      );
    }

    // проверка баланса
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
    console.error("message error:", err);
  }
});

// =============== РОЗЫГРЫШИ — ПОЛНОЕ СЛИЯНИЕ ===============

// GET /api/raffle
app.get("/api/raffle", async (req, res) => {
  try {
    const raffle = await getRaffle(req.query.id);
    if (!raffle) return res.json({ ok: false });

    res.json({
      ok: true,
      participants: raffle.participants || [],
      endAt: raffle.endAt,
      title: raffle.text || ""
    });
  } catch {
    res.json({ ok: false });
  }
});

// GET /api/join
app.get("/api/join", async (req, res) => {
  try {
    const id = req.query.id;
    const userId = parseInt(req.query.userId, 10);
    const username = req.query.username || "";

    const raffle = await getRaffle(id);
    if (!raffle || raffle.status !== "active") {
      return res.json({ ok: false, error: "ENDED" });
    }

    const notSubs = [];

    // проверка подписки на основной канал
    try {
      const m = await bot.getChatMember(raffle.channelId, userId);
      if (["left", "kicked"].includes(m.status))
        notSubs.push(raffle.channelUsername || "канал розыгрыша");
    } catch {
      notSubs.push(raffle.channelUsername || "канал розыгрыша");
    }

    // проверка дополнительных
    for (const ch of raffle.requiredSubs) {
      try {
        const m = await bot.getChatMember(ch, userId);
        if (["left", "kicked"].includes(m.status)) notSubs.push(ch);
      } catch {
        notSubs.push(ch);
      }
    }

    if (notSubs.length) {
      return res.json({
        ok: false,
        error: "NOT_SUBSCRIBED",
        notSubs
      });
    }

    const display = username ? `@${username}` : `id:${userId}`;
    await addParticipantDisplay(id, display);

    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

// ================== OAUTH CALLBACK ==================
app.get(DA_REDIRECT_PATH, async (req, res) => {
  const code = req.query.code;

  if (!code) return res.status(400).send("Нет code.");

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
      console.error("DA realtime:", e.message)
    );
  } else {
    console.log("DA OAuth не выполнен. Используйте /da");
  }

  app.listen(PORT, () =>
    console.log("SERVER RUNNING ON PORT", PORT)
  );
}

start().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
