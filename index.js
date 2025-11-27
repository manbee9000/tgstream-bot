import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import { MongoClient } from "mongodb";
import WebSocket from "ws";

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

const app = express();
app.use(express.json());

if (!TOKEN) {
  console.error("Ошибка: BOT_TOKEN не задан!");
  process.exit(1);
}
if (!RENDER_URL) {
  console.error("Нет RENDER_EXTERNAL_URL");
}

const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

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
    if (id) return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
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
      { text: "💸 Донат", url: `https://www.donationalerts.com/r/${donateName}` },
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

let mongoClient;
let db;
let usersCol;
let ordersCol;
let promoCol;
let settingsCol;

async function initMongo() {
  if (!MONGODB_URI) {
    console.error("MONGODB_URI не задан");
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
    console.error("Ошибка Mongo:", err.message);
  }
}

async function getUser(tgId) {
  if (!usersCol) return null;
  return usersCol.findOne({ tgId });
}

async function getOrCreateUser(tgId) {
  if (!usersCol) return { tgId, balance: 0 };

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

  if (!promo)
    return { ok: false, message: "Промокод не найден или уже израсходован." };

  const postsToAdd = promo.remainingPosts;
  const amountRub = postsToAdd * PRICE_PER_POST;

  const user = await updateUserBalance(tgId, amountRub);

  await promoCol.updateOne(
    { _id: promo._id },
    { $set: { remainingPosts: 0, usedAt: new Date(), usedBy: tgId } }
  );

  return {
    ok: true,
    message:
      `Промокод активирован.\n` +
      `Начислено ${amountRub} ₽ (${postsToAdd} публикаций).\n` +
      `Баланс: ${Math.round(user.balance)} ₽.`,
  };
}

function generateOrderId() {
  return Math.random().toString(36).slice(2, 10);
}

async function createOrder(tgId, amount, chatId) {
  if (!ordersCol) return null;

  const orderId = generateOrderId();

  const doc = {
    orderId,
    tgId,
    chatId,   // █████ ВАЖНО: теперь сохраняем chatId
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
  const bal = user.balance || 0;

  if (bal >= PRICE_PER_POST) return true;

  const text =
    `Для публикации нужен баланс минимум ${PRICE_PER_POST} ₽.\n` +
    `Сейчас на счету: ${Math.round(bal)} ₽.\n\n` +
    `Пополните баланс или введите промокод.`;

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
  await updateUserBalance(tgId, -PRICE_PER_POST);
}

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
  if (!DA_CLIENT_ID || !DA_CLIENT_SECRET)
    throw new Error("Нет DA_CLIENT_ID/SECRET");

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
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  daAccessToken = resp.data.access_token;
  daRefreshToken = resp.data.refresh_token || null;
  daTokenExpiresAt = new Date(Date.now() + resp.data.expires_in * 1000);

  await saveDaTokensToDb();
}

async function ensureDaAccessToken() {
  if (!daAccessToken) return false;
  if (!daTokenExpiresAt) return true;

  if (daTokenExpiresAt.getTime() - Date.now() > 60000) return true;
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

    daAccessToken = resp.data.access_token;
    daRefreshToken = resp.data.refresh_token || daRefreshToken;
    daTokenExpiresAt = new Date(Date.now() + resp.data.expires_in * 1000);

    await saveDaTokensToDb();
    return true;
  } catch (e) {
    console.error("Ошибка refresh:", e.message);
    return false;
  }
}

async function fetchDaUserInfo() {
  if (!daAccessToken) return null;

  const resp = await axios.get(
    "https://www.donationalerts.com/api/v1/user/oauth",
    { headers: { Authorization: `Bearer ${daAccessToken}` } }
  );

  const data = resp.data?.data || resp.data || {};
  return data;
}

function findDonationObject(node) {
  if (!node || typeof node !== "object") return null;

  const hasFields =
    "id" in node && "message" in node && "amount" in node && "currency" in node;

  if (hasFields) return node;

  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = findDonationObject(item);
        if (found) return found;
      }
    } else if (typeof v === "object" && v !== null) {
      const found = findDonationObject(v);
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
    console.log("ORDER не найден:", orderId);
    return;
  }

  let amountRub = parseFloat(donation.amount);
  if (!Number.isFinite(amountRub) || amountRub <= 0) amountRub = order.amount;

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

  if (!user) return;

  const chatToSend = order.chatId || order.tgId;

  try {
    await bot.sendMessage(
      chatToSend,
      `Оплата ${amountRub} ₽ получена!\nВаш новый баланс: ${Math.round(
        user.balance
      )} ₽.`
    );
  } catch (err) {
    console.error("Ошибка отправки уведомления:", err.message);
  }
}

async function startDonationAlertsRealtime() {
  if (!DA_CLIENT_ID || !DA_CLIENT_SECRET) {
    console.log("Нет DA OAuth");
    return;
  }
  if (!daAccessToken) {
    console.log("DA OAuth не выполнен");
    return;
  }

  const ok = await ensureDaAccessToken();
  if (!ok) return;

  try {
    const userInfo = await fetchDaUserInfo();
    if (!userInfo) {
      console.error("DA: user info пустой");
      return;
    }

    daUserId = userInfo.id;
    const socketToken = userInfo.socket_connection_token;

    if (!daUserId || !socketToken) {
      console.error("Нет userId/socketToken");
      return;
    }

    await saveDaTokensToDb();

    const wsUrl = "wss://centrifugo.donationalerts.com/connection/websocket";

    if (daWs) {
      try {
        daWs.close();
      } catch {}
      daWs = null;
    }

    console.log("Подключаемся к DA WebSocket...");
    daWs = new WebSocket(wsUrl);

    daWs.on("open", () => {
      try {
        daWs.send(
          JSON.stringify({ params: { token: socketToken }, id: 1 })
        );
      } catch {}
    });

    daWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.id === 1 && msg.result?.client) {
        daWsClientId = msg.result.client;
        console.log("DA WebSocket client =", daWsClientId);

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
          if (!ch) return;

          daWs.send(
            JSON.stringify({
              params: { channel: ch.channel, token: ch.token },
              method: 1,
              id: 2,
            })
          );

          console.log("DA WebSocket: подписка на", ch.channel);
        } catch (e) {
          console.error("Ошибка подписки:", e.message);
        }

        return;
      }

      if (msg.id === 2) return;

      const donation = extractDonationFromWsMessage(msg);
      if (donation) {
        try {
          await handleDonation(donation);
        } catch (e) {
          console.error("Ошибка handleDonation:", e.message);
        }
      }
    });

    daWs.on("close", () => {
      console.log("DA WebSocket закрыт");
      scheduleDaReconnect();
    });

    daWs.on("error", (e) => console.error("DA WebSocket error:", e.message));
  } catch (e) {
    console.error("Ошибка DA realtime:", e.message);
    scheduleDaReconnect();
  }
}

function scheduleDaReconnect(delay = 30000) {
  if (daReconnectTimer) return;
  daReconnectTimer = setTimeout(() => {
    daReconnectTimer = null;
    console.log("Переподключение к DA...");
    startDonationAlertsRealtime();
  }, delay);
}

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

bot.onText(/\/create\s+(\S+)\s+(\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_TG_ID)
    return bot.sendMessage(msg.chat.id, "Недостаточно прав.");

  const code = match[1];
  const postsCount = parseInt(match[2], 10);

  if (!postsCount || postsCount <= 0)
    return bot.sendMessage(msg.chat.id, "Некорректное число.");

  await createPromocode(code, postsCount, msg.from.id);

  bot.sendMessage(
    msg.chat.id,
    `Промокод «${code}» создан (${postsCount} публикаций).`
  );
});

bot.onText(/\/start/, (msg) => {
  const text =
    "Добро пожаловать!\n\n" +
    "Чтобы подключить Ваш канал:\n" +
    "1. Добавьте бота в администраторы канала.\n" +
    "2. Отправьте любое сообщение в канале.\n" +
    "3. Перешлите его сюда.\n\n" +
    `Публикация стрима стоит ${PRICE_PER_POST} ₽.`;

  bot.sendMessage(msg.chat.id, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Авторизовать DonationAlerts", callback_data: "da_auth" }],
      ],
    },
  });
});

bot.onText(/\/balance/, async (msg) => {
  const user = await getOrCreateUser(msg.from.id);

  bot.sendMessage(msg.chat.id, `Баланс: ${Math.round(user.balance)} ₽.`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Пополнить баланс", callback_data: "topup" }],
        [{ text: "Авторизовать DonationAlerts", callback_data: "da_auth" }],
      ],
    },
  });
});

const promoWaitingUsers = new Set();

bot.on("callback_query", async (query) => {
  const { id, from, data, message } = query;
  const chatId = message?.chat?.id;
  const userId = from.id;

  try {
    if (data === "topup") {
      const text =
        "Выберите сумму пополнения.\n\n" +
        "ВАЖНО: на странице оплаты DonationAlerts вам нужно вручную вставить ваш ORDER_xxxxx в комментарий к донату.\n" +
        "Не меняйте и не удаляйте его.";

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
      });
    } else if (data.startsWith("pay_")) {
      const amount = parseInt(data.split("_")[1], 10);
      const orderId = await createOrder(userId, amount, chatId);

      const payUrl = buildDonateUrl(orderId, amount);

      const t =
        `Для пополнения на ${amount} ₽ перейдите по ссылке:\n\n` +
        `Ваш код:\nORDER_${orderId}\n\n` +
        `ВСТАВЬТЕ этот код в комментарий на странице оплаты.\n\n` +
        `Ссылка на оплату — кнопка ниже.`;

      await bot.sendMessage(chatId, t, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Оплатить через DonationAlerts", url: payUrl }],
          ],
        },
      });
    } else if (data === "promo_enter") {
      promoWaitingUsers.add(userId);
      await bot.sendMessage(chatId, "Введите промокод одним сообщением.");
    } else if (data === "da_auth") {
      if (userId !== ADMIN_TG_ID)
        return bot.sendMessage(chatId, "Недостаточно прав.");

      if (!DA_CLIENT_ID || !DA_CLIENT_SECRET) {
        return bot.sendMessage(chatId, "DA_CLIENT_ID/SECRET не заданы.");
      }

      const redirectUri = `${RENDER_URL}${DA_REDIRECT_PATH}`;
      const scope = DA_SCOPES;

      const url =
        "https://www.donationalerts.com/oauth/authorize" +
        `?client_id=${encodeURIComponent(DA_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(scope)}`;

      await bot.sendMessage(
        chatId,
        "Нажмите кнопку ниже для авторизации DonationAlerts:",
        {
          reply_markup: {
            inline_keyboard: [[{ text: "Авторизовать DA", url }]],
          },
        }
      );
    }
  } catch (e) {
    console.error("callback error:", e.message);
  } finally {
    try {
      await bot.answerCallbackQuery(id);
    } catch {}
  }
});

bot.on("message", async (msg) => {
  try {
    const text = msg.text || "";
    const userId = msg.from.id;

    if (promoWaitingUsers.has(userId) && text && !text.startsWith("/")) {
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
        `Канал подключён: ${msg.forward_from_chat.title}`
      );
    }

    if (text.startsWith("/")) return;

    if (!text.startsWith("http://") && !text.startsWith("https://")) return;

    const cfg = streamerConfig[userId];
    if (!cfg || !cfg.channelId) {
      return bot.sendMessage(
        msg.chat.id,
        "Подключите канал: перешлите сюда сообщение из канала, где бот — админ."
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
  } catch (e) {
    console.error("MESSAGE ERROR:", e);
  }
});

app.get(DA_REDIRECT_PATH, async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Нет code");

  try {
    await exchangeCodeForToken(String(code));
    await startDonationAlertsRealtime();
    res.send("DonationAlerts успешно авторизован. Вернитесь в Telegram-бот.");
  } catch (e) {
    res.status(500).send("Ошибка авторизации DonationAlerts");
  }
});

async function start() {
  await initMongo();
  await loadDaTokensFromDb();

  if (daAccessToken) startDonationAlertsRealtime();

  app.listen(PORT, () => console.log("SERVER RUNNING ON PORT", PORT));
}

start().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
