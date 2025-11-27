import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import { MongoClient } from "mongodb";

// ================== CONFIG ==================
const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;

const MONGODB_URI = process.env.MONGODB_URI;

// Стоимость одной публикации
const PRICE_PER_POST = parseInt(process.env.PRICE_PER_POST || "100", 10);

// Админ (для промокодов и обслуживания)
const ADMIN_TG_ID = 618072923;

// ---- YooMoney ----
// client_id приложения (тот длинный код на скрине)
const YOOMONEY_CLIENT_ID = process.env.YOOMONEY_CLIENT_ID;
// номер кошелька, например 4100119418762211
const YOOMONEY_WALLET = process.env.YOOMONEY_WALLET;

// путь редиректа, он ДОЛЖЕН совпадать с Redirect URI в приложении
const YOOMONEY_REDIRECT_PATH = "/yoomoney-oauth";
// страница запуска авторизации (мы её сами придумали, в приложении не нужна)
const YOOMONEY_AUTH_PATH = "/yoomoney-auth";

// как часто опрашивать историю, мс (по умолчанию 10 секунд)
const YOOMONEY_POLL_INTERVAL =
  parseInt(process.env.YOOMONEY_POLL_INTERVAL || "10000", 10);

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

// ================== ЗАКАЗЫ (через YooMoney) ==================
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

// Ссылка на оплату через YooMoney QuickPay
function buildYooMoneyPayUrl(orderId, amount) {
  const params = new URLSearchParams();
  params.set("receiver", YOOMONEY_WALLET);
  params.set("quickpay-form", "donate");
  params.set("sum", String(amount));
  params.set("label", `ORDER_${orderId}`);
  params.set(
    "targets",
    `Пополнение баланса в MyStreamingBot (ORDER_${orderId})`
  );
  params.set("paymentType", "AC"); // карта; можно PC для кошелька
  if (RENDER_URL) {
    params.set("successURL", RENDER_URL);
  }
  return `https://yoomoney.ru/quickpay/confirm.xml?${params.toString()}`;
}

// Проверка баланса перед постом
async function ensureBalanceForPost(tgId, chatId) {
  if (!usersCol) return true; // если нет Mongo — не блокируем

  const user = await getOrCreateUser(tgId);
  const currentBalance = user.balance || 0;

  if (currentBalance >= PRICE_PER_POST) {
    return true;
  }

  const text =
    `Для публикации стрима необходим баланс не менее ${PRICE_PER_POST} ₽.\n` +
    `Сейчас на Вашем счёте: ${Math.round(currentBalance)} ₽.\n\n` +
    `Пожалуйста, пополните баланс, чтобы разместить пост, или введите промокод.`;

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

// ================== YOOMONEY OAUTH + POLLING ==================
// В памяти
let ymAccessToken = null;
let ymTokenExpiresAt = null;
let ymLastHistoryTime = null; // Date

async function loadYooMoneyStateFromDb() {
  if (!settingsCol) return;
  const doc = await settingsCol.findOne({ _id: "yoomoney_oauth" });
  if (!doc) return;

  ymAccessToken = doc.accessToken || null;
  ymTokenExpiresAt = doc.expiresAt ? new Date(doc.expiresAt) : null;
  ymLastHistoryTime = doc.lastHistoryTime
    ? new Date(doc.lastHistoryTime)
    : null;
}

async function saveYooMoneyStateToDb() {
  if (!settingsCol) return;
  await settingsCol.updateOne(
    { _id: "yoomoney_oauth" },
    {
      $set: {
        accessToken: ymAccessToken,
        expiresAt: ymTokenExpiresAt,
        lastHistoryTime: ymLastHistoryTime,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

function hasValidYmToken() {
  if (!ymAccessToken) return false;
  if (!ymTokenExpiresAt) return true;
  return ymTokenExpiresAt.getTime() > Date.now() + 60 * 1000;
}

// Получение access_token по коду
async function exchangeCodeForYmToken(code) {
  if (!YOOMONEY_CLIENT_ID) {
    throw new Error("YOOMONEY_CLIENT_ID не задан.");
  }

  const redirectUri = `${RENDER_URL}${YOOMONEY_REDIRECT_PATH}`;

  const body = new URLSearchParams();
  body.set("code", code);
  body.set("client_id", YOOMONEY_CLIENT_ID);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", redirectUri);

  const resp = await axios.post(
    "https://yoomoney.ru/oauth/token",
    body.toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );

  const data = resp.data || {};
  ymAccessToken = data.access_token;
  const expiresIn = data.expires_in ? Number(data.expires_in) : 0;
  ymTokenExpiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000)
    : null;

  await saveYooMoneyStateToDb();
}

// Опрос истории операций
async function pollYooMoney() {
  if (!hasValidYmToken()) {
    return;
  }

  try {
    const params = new URLSearchParams();
    // Нас интересуют зачисления
    params.set("type", "deposition");
    params.set("records", "50");
    if (ymLastHistoryTime) {
      params.set("from", ymLastHistoryTime.toISOString());
    }

    const resp = await axios.get(
      "https://yoomoney.ru/api/operation-history",
      {
        headers: {
          Authorization: `Bearer ${ymAccessToken}`,
        },
        params,
      }
    );

    const data = resp.data || {};
    const ops = data.operations || [];

    let maxDate = ymLastHistoryTime || new Date(0);

    for (const op of ops) {
      if (!op.datetime) continue;
      const dt = new Date(op.datetime);
      if (dt > maxDate) maxDate = dt;

      const label = op.label || "";
      const details = op.details || "";
      const combined = `${label} ${details || ""}`;

      const match = combined.match(/ORDER_([a-zA-Z0-9]+)/);
      if (!match) continue;

      const orderId = match[1];

      if (!ordersCol || !usersCol) continue;

      const order = await ordersCol.findOne({ orderId });
      if (!order || order.status === "paid") continue;

      let amount = Number(op.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        amount = order.amount;
      }

      const user = await updateUserBalance(order.tgId, amount);

      await ordersCol.updateOne(
        { _id: order._id },
        {
          $set: {
            status: "paid",
            paidAt: new Date(),
            realAmount: amount,
            ymOperationId: op.operation_id,
          },
        }
      );

      if (user) {
        try {
          await bot.sendMessage(
            order.tgId,
            `Оплата ${amount} ₽ получена через YooMoney. Ваш новый баланс: ${Math.round(
              user.balance
            )} ₽.`
          );
        } catch (e) {
          console.error(
            "Не удалось отправить уведомление пользователю:",
            e.message
          );
        }
      }
    }

    ymLastHistoryTime = maxDate;
    await saveYooMoneyStateToDb();
  } catch (err) {
    console.error(
      "Ошибка при опросе YooMoney:",
      err.response?.data || err.message
    );
  }
}

// ================== TELEGRAM: конфиг стримера ==================
const streamerConfig = {}; // userId -> { channelId, donateName }

// команда /donate <имя_на_DA> (для кнопки доната СТРИМЕРУ)
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
    `Публикация стрима списывает с баланса ${PRICE_PER_POST} ₽. Баланс можно пополнить через YooMoney.`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "Пополнить баланс", callback_data: "topup" }],
      [{ text: "Ввести промокод", callback_data: "promo_enter" }],
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
        "Выберите сумму пополнения. После оплаты баланс будет пополнен автоматически в течение 10–20 секунд.\n\n" +
        "Важно: не меняйте комментарий и поля на странице YooMoney.";

      const keyboard = {
        inline_keyboard: [
          [
            { text: "100 ₽", callback_data: "pay_100" },
            { text: "200 ₽", callback_data: "pay_200" },
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
          const payUrl = buildYooMoneyPayUrl(orderId, amount);
          const txt =
            `Для пополнения баланса на ${amount} ₽ перейдите по ссылке ниже и завершите оплату.\n\n` +
            `Оплата проводится через YooMoney. Баланс в боте пополнится автоматически, как только платёж будет подтверждён.\n\n` +
            `Если оплата не отразилась в течение 1–2 минут, напишите администратору.`;

          await bot.sendMessage(chatId, txt, {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Оплатить через YooMoney",
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

// ================== YOOMONEY AUTH ROUTES ==================

// Стартовая страница авторизации YooMoney.
// Её нужно открыть ОДИН РАЗ в браузере, будучи залогиненным в кошелёк.
app.get(YOOMONEY_AUTH_PATH, (req, res) => {
  if (!YOOMONEY_CLIENT_ID || !RENDER_URL) {
    return res
      .status(500)
      .send("YOOMONEY_CLIENT_ID или RENDER_EXTERNAL_URL не заданы.");
  }

  const redirectUri = `${RENDER_URL}${YOOMONEY_REDIRECT_PATH}`;
  const scope = "account-info operation-history";

  // Делаем form POST, как в документации YooMoney
  res.send(`
    <html>
      <body>
        <form id="f" method="post" action="https://yoomoney.ru/oauth/authorize">
          <input type="hidden" name="client_id" value="${YOOMONEY_CLIENT_ID}" />
          <input type="hidden" name="response_type" value="code" />
          <input type="hidden" name="redirect_uri" value="${redirectUri}" />
          <input type="hidden" name="scope" value="${scope}" />
        </form>
        <script>document.getElementById('f').submit();</script>
      </body>
    </html>
  `);
});

// Redirect URI — сюда вернётся YooMoney с ?code=...
app.get(YOOMONEY_REDIRECT_PATH, async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send("Не передан параметр code.");
  }

  try {
    await exchangeCodeForYmToken(String(code));
    res.send(
      "YooMoney успешно авторизован. Можете вернуться в Telegram-бот. Баланс будет пополняться автоматически."
    );
  } catch (err) {
    console.error(
      "Ошибка в обработчике YooMoney OAuth:",
      err.response?.data || err.message
    );
    res
      .status(500)
      .send("Произошла ошибка при авторизации YooMoney. Попробуйте позже.");
  }
});

// ================== СТАРТ СЕРВЕРА ==================
async function start() {
  await initMongo();
  await loadYooMoneyStateFromDb();

  if (hasValidYmToken()) {
    console.log("YooMoney OAuth токен найден, запускаем опрос истории.");
  } else {
    console.log(
      `YooMoney токен не найден. После деплоя откройте ${RENDER_URL}${YOOMONEY_AUTH_PATH} в браузере, чтобы выдать доступ.`
    );
  }

  if (YOOMONEY_POLL_INTERVAL > 0) {
    setInterval(pollYooMoney, YOOMONEY_POLL_INTERVAL);
    console.log(
      `Запускаем опрос YooMoney каждые ${YOOMONEY_POLL_INTERVAL / 1000} секунд...`
    );
  }

  app.listen(PORT, () => console.log("SERVER RUNNING ON PORT", PORT));
}

start().catch((err) => {
  console.error("Fatal start error:", err);
  process.exit(1);
});
