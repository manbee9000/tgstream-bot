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

// Скоупы согласно документации
const DA_SCOPES =
  process.env.DA_SCOPES || "oauth-user-show oauth-donation-subscribe";

// Redirect-URL для OAuth
const DA_REDIRECT_PATH = process.env.DA_REDIRECT_PATH || "/da-oauth";

// Админ
const ADMIN_TG_ID = 618072923;

// Parent domain
let PARENT_DOMAIN = "localhost";
try {
  if (RENDER_URL) PARENT_DOMAIN = new URL(RENDER_URL).host;
} catch (e) {
  console.error("Ошибка парсинга RENDER_URL:", e);
}

// ================== EXPRESS ==================
const app = express();
app.use(express.json());

// ================== TELEGRAM WEBHOOK ==================
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================== WEBAPP ==================
app.get("/webapp", (req, res) => {
  const src = req.query.src || "";
  res.send(`
    <html><body style="margin:0;background:#000">
      <iframe
        src="${src}"
        allowfullscreen
        allow="autoplay; encrypted-media; picture-in-picture"
        style="width:100%;height:100%;border:0;"
      ></iframe>
    </body></html>
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

  if (url.includes("vk.com/video")) return null;

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
    "💬 Чат — в комментариях под постом.\n" +
    "💸 Донат — по кнопке ниже.";

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
    mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 30000 });
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

// ================== USER HELPERS ==================
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

  await promoCol.updateOne({ code: normalized }, { $set: doc }, { upsert: true });
}

async function applyPromocode(tgId, code) {
  if (!promoCol || !usersCol) return { ok: false, message: "База недоступна." };

  const normalized = code.trim().toUpperCase();

  const promo = await promoCol.findOne({
    code: normalized,
    remainingPosts: { $gt: 0 },
  });

  if (!promo) {
    return {
      ok: false,
      message: "Промокод не найден или уже использован.",
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
      `Промокод активирован.\n` +
      `Начислено: ${amountRub} ₽ (${postsToAdd} публикаций).\n` +
      `Текущий баланс: ${Math.round(newBalance)} ₽.`,
  };
}

// ================== ORDERS (ORDER_xxx) ==================
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

// Формируем URL на DonationAlerts (но Мы УЖЕ НЕ используем автоматический message)
function buildDonateUrl(orderId, amount) {
  const params = new URLSearchParams();
  params.set("amount", String(amount));
  // message НЕ добавляем — пользователь вставит вручную!
  return `${DA_DONATE_URL}?${params.toString()}`;
}
// ================== CALLBACK-ЗАПРОСЫ ==================
const promoWaitingUsers = new Set();

bot.on("callback_query", async (query) => {
  const { id, from, data, message } = query;
  const chatId = message?.chat?.id;
  const userId = from.id;

  try {
    // ===================== КНОПКА "Пополнить баланс" =====================
    if (data === "topup") {
      const text =
        "Выберите сумму пополнения.\n\n" +
        "<b>ВАЖНО!</b>\n" +
        "После выбора суммы вы получите ваш уникальный код вида <b>ORDER_xxxxx</b>.\n" +
        "⛔ На странице DonationAlerts этот код нужно <b>вставить вручную</b> в поле «Комментарий».\n\n" +
        "Если удалить или изменить этот код — бот <b>не сможет</b> привязать оплату.";

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

      await bot.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }

    // ===================== КНОПКИ pay_XXX =====================
    else if (data && data.startsWith("pay_")) {
      const amount = parseInt(data.split("_")[1], 10);

      if (!amount || amount <= 0) {
        return bot.sendMessage(chatId, "Ошибка: не удалось определить сумму.");
      }

      const orderId = await createOrder(userId, amount);

      if (!orderId) {
        return bot.sendMessage(
          chatId,
          "Ошибка базы данных. Попробуйте позже."
        );
      }

      const payUrl = buildDonateUrl(orderId, amount);

      const txt =
        `Для пополнения баланса на <b>${amount} ₽</b> перейдите по ссылке ниже.\n\n` +
        `Ваш уникальный код:\n<b>ORDER_${orderId}</b>\n\n` +
        `🔸 <b>Скопируйте этот код</b> и вставьте его в поле «Комментарий» на сайте DonationAlerts.\n` +
        `🔸 Это обязательно — иначе бот не сможет зачислить оплату.\n\n` +
        `После доната баланс пополнится автоматически.`;

      await bot.sendMessage(chatId, txt, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Перейти к оплате",
                url: payUrl,
              },
            ],
          ],
        },
      });
    }

    // ===================== ПРОМОКОД =====================
    else if (data === "promo_enter") {
      promoWaitingUsers.add(userId);
      await bot.sendMessage(
        chatId,
        "Отправьте промокод одним сообщением (например: VOLNA100)."
      );
    }

    // ===================== AUTH DonationAlerts =====================
    else if (data === "da_auth") {
      if (userId !== ADMIN_TG_ID) {
        return bot.sendMessage(
          chatId,
          "Авторизовать DonationAlerts может только владелец бота."
        );
      }

      if (!DA_CLIENT_ID || !DA_CLIENT_SECRET) {
        return bot.sendMessage(
          chatId,
          "Переменные DA_CLIENT_ID и DA_CLIENT_SECRET не заданы на сервере."
        );
      }

      const redirectUri = `${RENDER_URL}${DA_REDIRECT_PATH}`;
      const scope = DA_SCOPES;

      const authUrl =
        "https://www.donationalerts.com/oauth/authorize" +
        `?client_id=${encodeURIComponent(DA_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(scope)}`;

      const txt =
        "Чтобы активировать автоучёт донатов, необходимо авторизовать DonationAlerts.\n\n" +
        "Нажмите кнопку ниже и подтвердите доступ.";

      await bot.sendMessage(chatId, txt, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Авторизовать DonationAlerts", url: authUrl }],
          ],
        },
      });
    }
  } catch (err) {
    console.error("Ошибка callback_query:", err.message);
  } finally {
    try {
      await bot.answerCallbackQuery(id);
    } catch {}
  }
});
// ================== ОБРАБОТКА сообщений (включая промокоды) ==================
bot.on("message", async (msg) => {
  try {
    const text = msg.text || "";
    const userId = msg.from.id;

    // === пользователь вводит промокод ===
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

    // === пользователь переслал сообщение из канала — подключаем канал ===
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      streamerConfig[userId] = streamerConfig[userId] || {};
      streamerConfig[userId].channelId = msg.forward_from_chat.id;

      return bot.sendMessage(
        msg.chat.id,
        `Канал успешно подключён: ${msg.forward_from_chat.title}\n\n` +
          "Теперь вы можете отправлять ссылку на стрим."
      );
    }

    // === игнорируем команды ===
    if (text.startsWith("/")) return;

    // === принимаем только ссылки ===
    if (!text.startsWith("http://") && !text.startsWith("https://")) return;

    // === проверяем, подключён ли канал ===
    const cfg = streamerConfig[userId];
    if (!cfg || !cfg.channelId) {
      return bot.sendMessage(
        msg.chat.id,
        "Перед публикацией стрима необходимо подключить ваш канал.\n\n" +
          "1. Добавьте бота администраторами канала.\n" +
          "2. Отправьте любое сообщение в канале.\n" +
          "3. Перешлите это сообщение сюда.\n\n" +
          "После подключения можно размещать ссылки на стрим."
      );
    }

    // === проверка баланса ===
    const enough = await ensureBalanceForPost(userId, msg.chat.id);
    if (!enough) return;

    // === формируем embed и thumbnail ===
    const embed = getEmbed(text);
    const thumb = await getThumbnail(text);

    // === публикуем пост ===
    await publishStreamPost(cfg.channelId, embed, thumb, cfg.donateName);

    // === списываем оплату за публикацию ===
    await chargeForPost(userId);

    const user = await getOrCreateUser(userId);
    const bal = user.balance || 0;

    bot.sendMessage(
      msg.chat.id,
      `Готово! Публикация успешно размещена.\n` +
        `С вашего баланса списано ${PRICE_PER_POST} ₽.\n` +
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
      console.error("Ошибка запуска DA realtime:", e.message)
    );
  } else {
    console.log(
      "DA OAuth токены не найдены. Нажмите в боте кнопку «Авторизовать DonationAlerts», чтобы включить автоучёт оплат."
    );
  }

  app.listen(PORT, () =>
    console.log("SERVER RUNNING ON PORT", PORT)
  );
}

start().catch((err) => {
  console.error("Fatal start error:", err);
  process.exit(1);
});
