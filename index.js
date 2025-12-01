import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import { MongoClient, ObjectId } from "mongodb";
import WebSocket from "ws";

// ================== CONFIG ==================
const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_URL || process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;

const DA_DONATE_URL =
  process.env.DA_DONATE_URL || "https://dalink.to/mystreambot";

const DA_CLIENT_ID = process.env.DA_CLIENT_ID || null;
const DA_CLIENT_SECRET = process.env.DA_CLIENT_SECRET || null;
const DA_SCOPES =
  process.env.DA_SCOPES || "oauth-user-show oauth-donation-subscribe";
const DA_REDIRECT_PATH = process.env.DA_REDIRECT_PATH || "/da-oauth";

const BOT_USERNAME = process.env.BOT_USERNAME;  // без @
const ADMIN_TG_ID = 618072923;

let PARENT_DOMAIN = "localhost";
try {
  if (RENDER_URL) PARENT_DOMAIN = new URL(RENDER_URL).host;
} catch {}

// ================== EXPRESS ==================
const app = express();
app.use(express.json());

// ================== TELEGRAM ==================
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

// ================== MONGODB ==================
let db;
let usersCol;
let ordersCol;
let promoCol;
let settingsCol;
let rafflesCol;

async function initMongo() {
  const mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  db = mongoClient.db();

  usersCol = db.collection("users");
  ordersCol = db.collection("orders");
  promoCol  = db.collection("promocodes");
  settingsCol = db.collection("settings");
  rafflesCol = db.collection("raffles");

  console.log("MongoDB connected");
}

// ================== STREAM HELPERS ==================
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
    } catch { return null; }
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
    } catch { return url; }
  }

  if (url.includes("youtu")) {
    const id = extractYouTubeId(url);
    if (id) return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
  }

  return url;
}

// ================== PUBLISH STREAM ==================
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

// ================== ROZYGryshi HELPERS ==================
function buildMainMenu() {
  return {
    keyboard: [
      [
        { text: "🎁 Создать розыгрыш" },
        { text: "📋 Мои розыгрыши" }
      ],
      [
        { text: "📣 Мои каналы" },
        { text: "🎥 Отправить стрим" }
      ],
      [
        { text: "⭐ Поддержать бота" },
        { text: "💸 Подключить донат к стриму" }
      ],
      [{ text: "📘 Инструкция" }]
    ],
    resize_keyboard: true
  };
}

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

    status: "draft",
    createdAt: new Date()
  };

  const res = await rafflesCol.insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

async function updateRaffle(id, update) {
  await rafflesCol.updateOne({ _id: new ObjectId(id) }, { $set: update });
}

async function getRaffle(id) {
  return rafflesCol.findOne({ _id: new ObjectId(id) });
}

async function addParticipantDisplay(id, display) {
  await rafflesCol.updateOne(
    { _id: new ObjectId(id) },
    { $addToSet: { participants: display } }
  );
}
// =============== ПУБЛИКАЦИЯ РОЗЫГРЫША ==================
async function publishRafflePost(raffle) {
  const channelId = raffle.channelId;
  if (!channelId) throw new Error("Нет channelId");

  const deepLink = `https://t.me/${BOT_USERNAME}?start=raffle_${raffle._id}`;

  const caption =
    "🎁 *Розыгрыш*\n\n" +
    (raffle.text ? raffle.text + "\n\n" : "") +
    "Чтобы участвовать, нажмите кнопку ниже.\n" +
    "Бот откроется автоматически.";

  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: "🎉 Участвовать",
          url: deepLink
        }
      ]
    ]
  };

  try {
    if (raffle.imageFileId) {
      await bot.sendPhoto(channelId, raffle.imageFileId, {
        caption,
        parse_mode: "Markdown",
        reply_markup
      });
    } else {
      await bot.sendMessage(channelId, caption, {
        parse_mode: "Markdown",
        reply_markup
      });
    }
    console.log("Розыгрыш опубликован");
  } catch (err) {
    console.error("Ошибка публикации:", err);
    throw err;
  }
}

// ================== STATE ==================
const userState = {};
const streamerConfig = {};  // тут хранится donateName и stream-channel

// ================== /donate (как раньше) ==================
bot.onText(/\/donate (.+)/, (msg, match) => {
  const uid = msg.from.id;
  const name = match[1].trim();

  streamerConfig[uid] = streamerConfig[uid] || {};
  streamerConfig[uid].donateName = name;

  bot.sendMessage(
    msg.chat.id,
    `Донат успешно подключён:\nhttps://www.donationalerts.com/r/${name}`
  );
});

// ================== /da — авторизация DonationAlerts ==================
bot.onText(/\/da/, async (msg) => {
  if (msg.from.id !== ADMIN_TG_ID)
    return bot.sendMessage(msg.chat.id, "Команда только для владельца.");

  if (!DA_CLIENT_ID || !DA_CLIENT_SECRET)
    return bot.sendMessage(msg.chat.id, "DA CLIENT_ID/SECRET не заданы.");

  const redirectUri = `${RENDER_URL}${DA_REDIRECT_PATH}`;

  const authUrl =
    "https://www.donationalerts.com/oauth/authorize" +
    `?client_id=${encodeURIComponent(DA_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(DA_SCOPES)}`;

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

// ================== /start ==================
bot.onText(/\/start/, async (msg) => {
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  const payload = msg.text.split(" ").slice(1).join(" ").trim();

  userState[uid] = {};

  // ====== Вход по deep-link розыгрыша ======
  if (payload.startsWith("raffle_")) {
    const raffleId = payload.replace("raffle_", "");
    const raffle = await getRaffle(raffleId);

    if (!raffle || raffle.status !== "active") {
      return bot.sendMessage(chatId, "Этот розыгрыш недоступен.");
    }

    return bot.sendMessage(chatId, "🎁 Розыгрыш:\nНажмите кнопку:", {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🎉 Участвовать",
              web_app: { url: `${RENDER_URL}/giveaway/?id=${raffleId}` }
            }
          ]
        ]
      }
    });
  }

  // ====== Обычный старт ======
  bot.sendMessage(chatId, "👋 Привет! Выберите действие:", {
    reply_markup: buildMainMenu()
  });
});

// ========================================================
//                      MESSAGE HANDLER
// ========================================================
bot.on("message", async (msg) => {
  try {
    const uid = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text || "";
    const isPrivate = msg.chat.type === "private";

    // Не повторять /start
    if (text.startsWith("/start")) return;

    // ====================== ПОДКЛЮЧЕНИЕ КАНАЛА ===================
    if (isPrivate && text === "📣 Мои каналы") {
      userState[uid] = { mode: "connect_channel" };
      return bot.sendMessage(
        chatId,
        "Перешлите любое сообщение из канала, который хотите подключить."
      );
    }

    if (isPrivate && userState[uid]?.mode === "connect_channel") {
      if (msg.forward_from_chat) {
        const ch = msg.forward_from_chat;

        await usersCol.updateOne(
          { tgId: uid },
          {
            $addToSet: {
              channels: {
                id: ch.id,
                title: ch.title || "",
                username: ch.username || null
              }
            }
          },
          { upsert: true }
        );

        userState[uid] = {};

        return bot.sendMessage(chatId, `Канал подключён: ${ch.title}`, {
          reply_markup: buildMainMenu()
        });
      }
    }

    // ======================= СОЗДАНИЕ РОЗЫГРЫША ====================
    const state = userState[uid] || {};

    if (isPrivate && text === "🎁 Создать розыгрыш") {
      const user = await usersCol.findOne({ tgId: uid });
      const channels = user?.channels || [];

      if (!channels.length) {
        return bot.sendMessage(
          chatId,
          "❌ Нет подключённых каналов.\nСначала подключите канал."
        );
      }

      const channel = channels[0];
      const draft = await createDraftRaffle(uid, channel);

      userState[uid] = {
        mode: "raffle",
        step: "wait_text",
        draftId: draft._id.toString()
      };

      return bot.sendMessage(
        chatId,
        "✏️ Пришлите текст розыгрыша. Можно приложить *одну* картинку.",
        { parse_mode: "Markdown" }
      );
    }

    // ===== Шаг 1: текст + фото =====
    if (isPrivate && state.mode === "raffle" && state.step === "wait_text") {
      const draftId = state.draftId;

      if (msg.photo?.length) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await updateRaffle(draftId, { imageFileId: fileId });
      }

      if (msg.caption) await updateRaffle(draftId, { text: msg.caption });
      else if (text.trim()) await updateRaffle(draftId, { text: text.trim() });

      userState[uid].step = "wait_subs";

      return bot.sendMessage(
        chatId,
        "📌 Теперь отправьте обязательные подписки (@channel1 ...). Если нет — напишите *нет*.",
        { parse_mode: "Markdown" }
      );
    }

    // ===== Шаг 2: обязательные подписки =====
    if (isPrivate && state.mode === "raffle" && state.step === "wait_subs") {
      const draftId = state.draftId;
      let required = [];

      if (text.trim().toLowerCase() !== "нет") {
        required = text
          .split(/\s+/)
          .map((x) => x.trim())
          .filter((x) => x.startsWith("@"));
      }

      await updateRaffle(draftId, { requiredSubs: required });
      userState[uid].step = "wait_end";

      return bot.sendMessage(
        chatId,
        "⏳ Укажите дату и время окончания\nФормат: *дд.мм.гггг чч:мм*",
        { parse_mode: "Markdown" }
      );
    }

    // ===== Шаг 3: дата окончания =====
    if (isPrivate && state.mode === "raffle" && state.step === "wait_end") {
      const m = text.match(
        /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/
      );

      if (!m)
        return bot.sendMessage(chatId, "Неверный формат. Пример: 01.12.2025 18:00");

      const draftId = state.draftId;
      const endAt = new Date(+m[3], m[2] - 1, +m[1], +m[4], +m[5]);

      await updateRaffle(draftId, { endAt, status: "active" });

      const raffle = await getRaffle(draftId);

      try {
        await publishRafflePost(raffle);
        bot.sendMessage(chatId, "✅ Розыгрыш опубликован!", {
          reply_markup: buildMainMenu()
        });
      } catch {
        bot.sendMessage(
          chatId,
          "❌ Ошибка публикации. Проверьте права администратора.",
          { reply_markup: buildMainMenu() }
        );
      }

      userState[uid] = {};
      return;
    }

    // ========================================================
    //                 ПУБЛИКАЦИЯ СТРИМА (БЕСПЛАТНО)
    // ========================================================

    if (!isPrivate) return;
    if (!text.startsWith("http://") && !text.startsWith("https://")) return;

    const user = await usersCol.findOne({ tgId: uid });
    const channels = user?.channels || [];

    if (!channels.length) {
      return bot.sendMessage(
        chatId,
        "Сначала подключите канал через «📣 Мои каналы»."
      );
    }

    const channel = channels[0];
    const embed = getEmbed(text);
    const thumb = await getThumbnail(text);
    const donateName = streamerConfig[uid]?.donateName || null;

    await publishStreamPost(channel.id, embed, thumb, donateName);

    return bot.sendMessage(
      chatId,
      "✔️ Стрим опубликован!",
      { reply_markup: buildMainMenu() }
    );
  } catch (err) {
    console.error("message error:", err);
  }
});
// ========================================================
//                 API для mini-app /giveaway
// ========================================================

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
  } catch (err) {
    res.json({ ok: false });
  }
});

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

    // Проверка основной подписки
    try {
      const m = await bot.getChatMember(raffle.channelId, userId);
      if (["left", "kicked"].includes(m.status)) {
        notSubs.push(raffle.channelUsername || "канал розыгрыша");
      }
    } catch {
      notSubs.push(raffle.channelUsername || "канал розыгрыша");
    }

    // Проверка доп. подписок
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
  } catch (e) {
    console.error("join error:", e);
    res.json({ ok: false });
  }
});

// ========================================================
//                 DonationAlerts REALTIME
// ========================================================

async function handleDonation(donation) {
  if (!ordersCol || !usersCol) return;

  console.log("Получен донат:", donation.message, donation.amount);

  const msg = donation.message || "";
  const match = msg.match(/ORDER_([a-zA-Z0-9]+)/);
  if (!match) return;

  const orderId = match[1];
  const order = await ordersCol.findOne({ orderId, status: "pending" });
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
        donationId: donation.id
      }
    }
  );

  if (user) {
    const notifyChatId = order.chatId || order.tgId;
    bot.sendMessage(
      notifyChatId,
      `Оплата ${amountRub} ₽ получена!\nНовый баланс: ${Math.round(
        user.balance
      )} ₽.`
    );
  }
}

function extractDonationFromWsMessage(node) {
  if (!node || typeof node !== "object") return null;

  const isDonation =
    node.hasOwnProperty("id") &&
    node.hasOwnProperty("amount") &&
    node.hasOwnProperty("currency");

  if (isDonation) return node;

  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const v of val) {
        const r = extractDonationFromWsMessage(v);
        if (r) return r;
      }
    } else if (typeof val === "object") {
      const r = extractDonationFromWsMessage(val);
      if (r) return r;
    }
  }

  return null;
}

async function startDonationAlertsRealtime() {
  if (!daAccessToken) {
    console.log("DA OAuth не выполнен. Запустите /da");
    return;
  }

  let userInfo;

  try {
    const resp = await axios.get(
      "https://www.donationalerts.com/api/v1/user/oauth",
      {
        headers: { Authorization: `Bearer ${daAccessToken}` }
      }
    );
    userInfo = resp.data?.data;
  } catch (err) {
    console.error("DA: user info error");
    return;
  }

  const daUserId = userInfo.id;
  const socketToken = userInfo.socket_connection_token;

  if (!socketToken) {
    console.error("Нет socket_connection_token");
    return;
  }

  const wsUrl = "wss://centrifugo.donationalerts.com/connection/websocket";
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        params: { token: socketToken },
        id: 1
      })
    );
  });

  ws.on("message", async (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.id === 1 && msg.result?.client) {
      const clientId = msg.result.client;

      // подписка
      try {
        const resp = await axios.post(
          "https://www.donationalerts.com/api/v1/centrifuge/subscribe",
          {
            channels: [`$alerts:donation_${daUserId}`],
            client: clientId
          },
          {
            headers: {
              Authorization: `Bearer ${daAccessToken}`,
              "Content-Type": "application/json"
            }
          }
        );

        const ch = resp.data.channels[0];

        ws.send(
          JSON.stringify({
            method: 1,
            params: { channel: ch.channel, token: ch.token },
            id: 2
          })
        );

        console.log("DA: подписан на донаты");
      } catch (err) {
        console.error("Ошибка подписки:", err.response?.data || err.message);
      }
      return;
    }

    if (msg.id === 2) return;

    const donation = extractDonationFromWsMessage(msg);
    if (donation) await handleDonation(donation);
  });

  ws.on("close", () => {
    console.log("DA WS закрыт. Перезапуск через 30 сек.");
    setTimeout(startDonationAlertsRealtime, 30000);
  });

  ws.on("error", (err) => {
    console.error("DA WS ERROR:", err.message);
  });
}

// ========================================================
//                 DonationAlerts OAuth callback
// ========================================================

app.get(DA_REDIRECT_PATH, async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Нет параметра code");

  try {
    const body = new URLSearchParams();
    body.set("client_id", DA_CLIENT_ID);
    body.set("client_secret", DA_CLIENT_SECRET);
    body.set("grant_type", "authorization_code");
    body.set("redirect_uri", `${RENDER_URL}${DA_REDIRECT_PATH}`);
    body.set("code", code);

    const resp = await axios.post(
      "https://www.donationalerts.com/oauth/token",
      body.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    daAccessToken = resp.data.access_token;
    daRefreshToken = resp.data.refresh_token;

    await saveDaTokensToDb();

    res.send("DonationAlerts успешно авторизован!");

    startDonationAlertsRealtime();
  } catch (err) {
    console.error("DA OAuth error:", err.response?.data || err.message);
    res.send("Ошибка авторизации");
  }
});

// ========================================================
//                       START SERVER
// ========================================================

async function start() {
  await initMongo();
  await loadDaTokensFromDb();

  if (daAccessToken) startDonationAlertsRealtime();
  else console.log("DA не авторизован. Используйте /da");

  app.listen(PORT, () => console.log("SERVER RUNNING ON PORT", PORT));
}

start().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
