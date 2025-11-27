import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import { MongoClient } from "mongodb";

// ================== CONFIG ==================
const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;

const MONGODB_URI = process.env.MONGODB_URI;

// Стоимость одной публикации (в рублях)
const PRICE_PER_POST = parseInt(process.env.PRICE_PER_POST || "100", 10);

// YooMoney
const YOOMONEY_WALLET = process.env.YOOMONEY_WALLET;          // "4100...."
const YOOMONEY_ACCESS_TOKEN = process.env.YOOMONEY_ACCESS_TOKEN; // access_token с правами account-info + operation-history

// Админ для создания промокодов
const ADMIN_TG_ID = 618072923;

// Определяем parent-домен (для Twitch iframe)
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

  // Кнопка доната ДЛЯ СТРИМЕРА (мы к этим деньгам не имеем отношения)
  if (donateName) {
    buttons.push([
      {
        text: "💸 Донат стримеру",
        url: `https://www.donationalerts.com/r/${donateName}`,
      },
    ]);
  }

  const caption =
    "🔴 Не пропустите стрим!\n\n" +
    "🎥 Нажмите «Смотреть стрим», чтобы открыть трансляцию.\n" +
    "💬 Чат находится в комментариях под постом.\n" +
    "💸 Донат — через соответствующую кнопку ниже (если она есть).";

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

  const postsToAdd = promo.remainingPosts; // сколько бесплатных публикаций
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

// ================== ЗАКАЗЫ (оплата через YooMoney) ==================
function generateOrderId() {
  return "YM" + Math.random().toString(36).slice(2, 10);
}

async function createOrder(tgId, amount) {
  if (!ordersCol) return null;
  const orderId = generateOrderId();
  const doc = {
    orderId,
    tgId,
    amount,
    status: "pending", // pending / paid
    createdAt: new Date(),
    provider: "yoomoney",
  };
  await ordersCol.insertOne(doc);
  return orderId;
}

// Проверка баланса перед постом
async function ensureBalanceForPost(tgId, chatId) {
  // если нет Mongo — не блокируем
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

// ================== YooMoney: платёжная страница и опрос API ==================

// Страница, на которую ведут кнопки оплаты из бота
// /pay?order=YMxxxx
app.get("/pay", async (req, res) => {
  const orderId = String(req.query.order || "").trim();
  if (!orderId) {
    return res.status(400).send("Не указан номер заказа.");
  }

  if (!YOOMONEY_WALLET) {
    return res
      .status(500)
      .send("Платёж временно недоступен: кошелёк YooMoney не настроен.");
  }

  if (!ordersCol) {
    return res
      .status(500)
      .send("Сервер временно недоступен (нет подключения к базе данных).");
  }

  const order = await ordersCol.findOne({ orderId });
  if (!order) {
    return res.status(404).send("Заказ не найден.");
  }

  if (order.status === "paid") {
    return res.send(
      "Этот счёт уже оплачен. Можете вернуться в Telegram-бот."
    );
  }

  const amount = order.amount;
  const receiver = YOOMONEY_WALLET;
  const successUrl = `${RENDER_URL}/paid?order=${encodeURIComponent(orderId)}`;

  // Формируем HTML-страницу с автоотправкой формы в YooMoney QuickPay
  res.send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Оплата через YooMoney</title>
      </head>
      <body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
        <h2>Оплата баланса бота</h2>
        <p>Сейчас вы будете перенаправлены на страницу оплаты YooMoney.</p>
        <p>Сумма: <b>${amount} ₽</b></p>
        <p>Ничего не меняйте на странице YooMoney — все поля уже заполнены.</p>
        <form id="payForm" method="POST" action="https://yoomoney.ru/quickpay/confirm">
          <input type="hidden" name="receiver" value="${receiver}" />
          <input type="hidden" name="sum" value="${amount}" />
          <input type="hidden" name="quickpay-form" value="shop" />
          <input type="hidden" name="paymentType" value="AC" />
          <input type="hidden" name="label" value="${orderId}" />
          <input type="hidden" name="targets" value="Оплата публикаций в боте (заказ ${orderId})" />
          <input type="hidden" name="successURL" value="${successUrl}" />
          <noscript>
            <button type="submit">Перейти к оплате</button>
          </noscript>
        </form>
        <script>
          setTimeout(function () {
            document.getElementById("payForm").submit();
          }, 300);
        </script>
      </body>
    </html>
  `);
});

// Страница после успешной оплаты в YooMoney (чисто информационная)
app.get("/paid", (req, res) => {
  const orderId = String(req.query.order || "").trim();
  res.send(`
    <html>
      <head><meta charset="utf-8" /><title>Оплата принята</title></head>
      <body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
        <h2>Спасибо!</h2>
        <p>Если платёж прошёл успешно, бот автоматически зафиксирует его в течение 10–30 секунд.</p>
        <p>Теперь можно вернуться в Telegram-бот и проверить баланс командой <b>/balance</b>.</p>
        ${
          orderId
            ? `<p>Номер Вашего заказа: <b>${orderId}</b></p>`
            : ""
        }
      </body>
    </html>
  `);
});

// Периодический опрос YooMoney API по operation-history
async function pollYooMoneyPayments() {
  if (!YOOMONEY_ACCESS_TOKEN) {
    console.log(
      "YOOMONEY_ACCESS_TOKEN не задан. Автоучёт оплат через YooMoney отключён."
    );
    return;
  }
  if (!ordersCol || !usersCol) return;

  try {
    const pendingOrders = await ordersCol
      .find({ status: "pending", provider: "yoomoney" })
      .toArray();

    if (!pendingOrders.length) return;

    for (const order of pendingOrders) {
      try {
        const params = new URLSearchParams();
        // Фильтруем по label = orderId — YooMoney вернёт операции с этим label
        params.set("label", order.orderId);
        params.set("records", "10");

        const resp = await axios.post(
          "https://yoomoney.ru/api/operation-history",
          params.toString(),
          {
            headers: {
              Authorization: `Bearer ${YOOMONEY_ACCESS_TOKEN}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
          }
        );

        const data = resp.data || {};
        const operations = data.operations || [];

        const op = operations.find(
          (o) => o.status === "success" || o.status === "completed"
        );

        if (!op) {
          continue; // оплата по этому заказу ещё не найдена
        }

        const amountPaid = parseFloat(op.amount);
        if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
          continue;
        }

        // Отмечаем заказ как оплаченный
        await ordersCol.updateOne(
          { _id: order._id },
          {
            $set: {
              status: "paid",
              paidAt: new Date(),
              realAmount: amountPaid,
              providerOperationId: op.operation_id || op.operationId || null,
            },
          }
        );

        // Пополняем баланс пользователя
        const user = await updateUserBalance(order.tgId, amountPaid);

        try {
          await bot.sendMessage(
            order.tgId,
            `Платёж ${amountPaid} ₽ получен через YooMoney.\n` +
              `Ваш новый баланс: ${Math.round(user.balance || 0)} ₽.\n\n` +
              `Теперь вы можете публиковать стримы.`
          );
        } catch (err) {
          console.error(
            "Не удалось отправить уведомление пользователю:",
            err.message
          );
        }
      } catch (err) {
        console.error(
          "Ошибка при опросе YooMoney для заказа",
          order.orderId,
          ":",
          err.response?.data || err.message
        );
      }
    }
  } catch (err) {
    console.error(
      "Ошибка при общем опросе YooMoney:",
      err.response?.data || err.message
    );
  }
}

// ================== TELEGRAM: конфиг стримера ==================
const streamerConfig = {}; // userId -> { channelId, donateName }

// команда /donate <имя_на_DA или любой ник>
// НУЖНА ТОЛЬКО ДЛЯ КНОПКИ ДОНАТА СТРИМЕРУ
bot.onText(/\/donate (.+)/, (msg, match) => {
  const userId = msg.from.id;
  const name = match[1].trim();

  streamerConfig[userId] = streamerConfig[userId] || {};
  streamerConfig[userId].donateName = name;

  bot.sendMessage(
    msg.chat.id,
    `Кнопка доната будет вести на:\nhttps://www.donationalerts.com/r/${name}\n\n` +
      "Мы эти платежи не обрабатываем — они идут напрямую вам."
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
    "Как работает бот:\n" +
    "• Вы подключаете свой канал.\n" +
    "• Отправляете сюда ссылку на стрим (Twitch / YouTube / VK).\n" +
    `• За каждую публикацию стрима списывается ${PRICE_PER_POST} ₽ с внутреннего баланса.\n\n` +
    "Чтобы подключить канал:\n" +
    "1. Добавьте бота в администраторы вашего канала.\n" +
    "2. Отправьте любое сообщение в канале.\n" +
    "3. Перешлите это сообщение сюда, в бот.\n\n" +
    "Баланс можно пополнить через YooMoney (кнопка ниже) или промокодом.";

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

  const text =
    `Ваш текущий баланс: ${Math.round(bal)} ₽.\n\n` +
    "Чтобы пополнить баланс, используйте кнопку ниже.\n" +
    "После оплаты через YooMoney бот автоматически зафиксирует платёж в течение 10–30 секунд.";

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
        "Выберите сумму пополнения.\n\n" +
        "После нажатия откроется страница оплаты YooMoney.\n" +
        "Важно: ничего не меняйте на странице YooMoney — все поля уже заполнены.\n" +
        "После успешной оплаты баланс обновится автоматически (10–30 секунд).";

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
          const payUrl = `${RENDER_URL}/pay?order=${encodeURIComponent(
            orderId
          )}`;
          const txt =
            `Для пополнения баланса на ${amount} ₽ откроется страница оплаты YooMoney.\n\n` +
            `Важно: ничего не меняйте на странице оплаты — комментарий и поля уже заполнены.\n` +
            `После успешной оплаты бот автоматически зафиксирует платёж в течение 10–30 секунд.`;

          await bot.sendMessage(chatId, txt, {
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
          "Теперь вы можете отправить ссылку на стрим (Twitch / YouTube / VK)."
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
        "Перед публикацией стрима необходимо подключить ваш канал.\n\n" +
          "Пожалуйста, выполните следующие шаги:\n" +
          "1. Добавьте бота администраторами вашего канала.\n" +
          "2. Отправьте любое сообщение в канале.\n" +
          "3. Перешлите это сообщение сюда.\n\n" +
          "После подключения вы сможете размещать ссылки на трансляции."
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
        `С вашего баланса списано ${PRICE_PER_POST} ₽.\n` +
        `Текущий баланс: ${Math.round(bal)} ₽.`
    );
  } catch (err) {
    console.error("MESSAGE ERROR:", err);
  }
});

// ================== СТАРТ СЕРВЕРА ==================
async function start() {
  await initMongo();

  if (YOOMONEY_ACCESS_TOKEN) {
    console.log("Запускаем опрос YooMoney каждые 15 секунд...");
    setInterval(pollYooMoneyPayments, 15000);
  } else {
    console.log(
      "YOOMONEY_ACCESS_TOKEN не задан. Автоучёт оплат через YooMoney отключён."
    );
  }

  app.listen(PORT, () => console.log("SERVER RUNNING ON PORT", PORT));
}

start().catch((err) => {
  console.error("Fatal start error:", err);
  process.exit(1);
});
