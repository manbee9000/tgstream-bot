import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { MongoClient } from "mongodb";

// ========== CONFIG ==========
const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI;
const BOOSTY_URL = "https://boosty.to/mystreambot/donate";
const ADMIN_ID = 618072923; // твой Telegram ID

// Определяем parent-домен (для Twitch)
let PARENT_DOMAIN = "localhost";
try {
  if (RENDER_URL) {
    PARENT_DOMAIN = new URL(RENDER_URL).host;
  }
} catch (e) {
  console.error("Ошибка парсинга RENDER_URL:", e);
}

// ========== CHECK ENV ==========
if (!TOKEN) {
  console.error("Ошибка: BOT_TOKEN не задан!");
  process.exit(1);
}
if (!RENDER_URL) {
  console.error("Ошибка: RENDER_EXTERNAL_URL не задан!");
}
if (!MONGO_URI) {
  console.error("Ошибка: MONGO_URI не задан!");
  process.exit(1);
}

// ========== MONGODB ==========
const mongoClient = new MongoClient(MONGO_URI);
await mongoClient.connect();
const db = mongoClient.db("tgstream");

const usersCol = db.collection("users");      // { userId, channelId, channelTitle, donateName, balance }
const promosCol = db.collection("promocodes"); // { code, credits, used, usedBy, createdAt, createdBy }

// вспомогательные функции по пользователям
async function getOrCreateUser(userId) {
  let user = await usersCol.findOne({ userId });
  if (!user) {
    user = { userId, balance: 0, createdAt: new Date() };
    await usersCol.insertOne(user);
  }
  return user;
}

async function getUserBalance(userId) {
  const user = await getOrCreateUser(userId);
  return user.balance || 0;
}

async function addUserCredits(userId, credits) {
  if (!credits || credits <= 0) return;
  await usersCol.updateOne(
    { userId },
    { $inc: { balance: credits }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
}

async function useUserCredit(userId) {
  await usersCol.updateOne(
    { userId, balance: { $gt: 0 } },
    { $inc: { balance: -1 } }
  );
}

// ========== EXPRESS ==========
const app = express();
app.use(express.json());

// Telegram Webhook
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// =====================================================================
// WEBAPP (встраиваемый iframe)
// =====================================================================
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

// =====================================================================
// HELPERS — извлечение ID / превью
// =====================================================================

// YouTube ID
function extractYouTubeId(url) {
  try {
    if (url.includes("watch?v=")) return url.split("v=")[1].split("&")[0];
    if (url.includes("youtu.be/")) return url.split("youtu.be/")[1].split("?")[0];
  } catch {}
  return null;
}

// Mini-thumbnail resolver
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

// =====================================================================
// EMBED URL BUILDER (Twitch, YouTube, VK)
// =====================================================================
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

// =====================================================================
// ПУБЛИКАЦИЯ СТРИМА В КАНАЛ
// =====================================================================
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

  // публикуем чат
  await bot.sendMessage(channelId, "💬 Чат стрима");
}

// =====================================================================
// СОСТОЯНИЯ ДЛЯ ПЛАТЕЖЕЙ И ПРОМОКОДОВ (в памяти)
// =====================================================================
const pendingStreams = {}; // userId -> url, если ждем оплаты/промокода
const promoState = {};    // userId -> { awaitingPromo: true }
const paymentState = {};  // userId -> { awaitingAmount: true }

// =====================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ОПЛАТЫ / ПРОМО
// =====================================================================

async function sendBalance(chatId, userId) {
  const balance = await getUserBalance(userId);
  await bot.sendMessage(
    chatId,
    `На Вашем счёте: ${balance} публикаций.\n` +
      "1 публикация соответствует одному посту со стримом в Ваш канал.\n" +
      "1 публикация = 100 ₽."
  );
}

async function offerTopUpOrPromo(chatId, userId) {
  const balance = await getUserBalance(userId);

  await bot.sendMessage(
    chatId,
    "Для публикации стрима необходима хотя бы одна доступная публикация.\n\n" +
      `Сейчас на Вашем счёте: ${balance} публикаций.\n\n` +
      "1 публикация = 100 ₽.\n\n" +
      "Вы можете пополнить баланс или активировать промокод.",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💳 Пополнить баланс", callback_data: "pay_enter_amount" }],
          [{ text: "🎁 Ввести промокод", callback_data: "enter_promo" }],
          [{ text: "💼 Посмотреть баланс", callback_data: "show_balance" }]
        ]
      }
    }
  );
}

async function processPendingStreamIfAny(userId, chatId) {
  const url = pendingStreams[userId];
  if (!url) return;

  const balance = await getUserBalance(userId);
  if (balance <= 0) return;

  delete pendingStreams[userId];
  await processStreamForUser(userId, chatId, url);
}

// =====================================================================
// ЛОГИКА ПУБЛИКАЦИИ СТРИМА С УЧЁТОМ БАЛАНСА
// =====================================================================
async function processStreamForUser(userId, chatId, url) {
  const user = await getOrCreateUser(userId);

  if (!user.channelId) {
    await bot.sendMessage(
      chatId,
      "Перед публикацией стрима необходимо подключить Ваш канал.\n\n" +
        "Пожалуйста, выполните следующие шаги:\n" +
        "1. Добавьте бота администраторами Вашего канала.\n" +
        "2. Отправьте любое сообщение в канале.\n" +
        "3. Перешлите это сообщение сюда.\n\n" +
        "После подключения Вы сможете размещать ссылки на трансляции."
    );
    return;
  }

  const balance = user.balance || 0;
  if (balance <= 0) {
    pendingStreams[userId] = url;
    await offerTopUpOrPromo(chatId, userId);
    return;
  }

  const embed = getEmbed(url);
  const thumb = await getThumbnail(url);

  await publishStreamPost(user.channelId, embed, thumb, user.donateName);
  await useUserCredit(userId);
  const newBalance = await getUserBalance(userId);

  await bot.sendMessage(
    chatId,
    "Готово! Публикация успешно размещена.\n" +
      `Оставшийся баланс: ${newBalance} публикаций.`
  );
}

// =====================================================================
// КОМАНДЫ
// =====================================================================

// команда /donate — сохранить DonationAlerts
bot.onText(/\/donate (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  const donateName = match[1].trim();

  await usersCol.updateOne(
    { userId },
    {
      $set: {
        donateName,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );

  await bot.sendMessage(
    msg.chat.id,
    `Донат успешно подключён:\nhttps://www.donationalerts.com/r/${donateName}`
  );
});

// команда /start
bot.onText(/\/start/, async (msg) => {
  await getOrCreateUser(msg.from.id);

  await bot.sendMessage(
    msg.chat.id,
    "Добро пожаловать!\n\n" +
      "Чтобы подключить Ваш канал:\n" +
      "1. Добавьте бота в администраторы канала.\n" +
      "2. Отправьте любое сообщение в канале.\n" +
      "3. Перешлите это сообщение сюда, в бот.\n\n" +
      "После подключения Вы сможете отправлять ссылки на трансляции.\n\n" +
      "Оплата работы бота осуществляется по принципу «за публикацию».\n" +
      "1 публикация = 100 ₽.\n" +
      "Пополнить баланс можно через /pay."
  );
});

// команда /balance — показать баланс
bot.onText(/\/balance/, async (msg) => {
  await sendBalance(msg.chat.id, msg.from.id);
});

// команда /pay — запустить сценарий пополнения
bot.onText(/\/pay/, async (msg) => {
  const userId = msg.from.id;
  paymentState[userId] = { awaitingAmount: true };

  await bot.sendMessage(
    msg.chat.id,
    "Для пополнения баланса отправьте сумму в рублях одним числом.\n\n" +
      "1 публикация = 100 ₽.\n" +
      "Пример: 100, 200, 500.\n\n" +
      "Сейчас бот не может автоматически проверить факт оплаты — " +
      "мы доверяем Вам. Пожалуйста, оплатите ту же сумму на Boosty " +
      `после начисления публикаций: ${BOOSTY_URL}`
  );
});

// команда /createpromo CODE CREDITS — только для администратора
bot.onText(/\/createpromo (\S+)\s+(\d+)/, async (msg, match) => {
  const userId = msg.from.id;
  if (userId !== ADMIN_ID) {
    await bot.sendMessage(
      msg.chat.id,
      "Эта команда доступна только администратору."
    );
    return;
  }

  const code = match[1].trim().toUpperCase();
  const credits = parseInt(match[2], 10);

  if (!credits || credits <= 0) {
    await bot.sendMessage(
      msg.chat.id,
      "Количество публикаций должно быть положительным числом."
    );
    return;
  }

  await promosCol.updateOne(
    { code },
    {
      $set: {
        code,
        credits,
        used: false,
        usedBy: null,
        createdAt: new Date(),
        createdBy: userId
      }
    },
    { upsert: true }
  );

  await bot.sendMessage(
    msg.chat.id,
    `Промокод ${code} создан.\n` +
      `Он даёт ${credits} бесплатных публикаций и может быть использован один раз.`
  );
});

// =====================================================================
// CALLBACK-КНОПКИ: оплата и промокоды
// =====================================================================
bot.on("callback_query", async (query) => {
  try {
    const data = query.data;
    const userId = query.from.id;
    const chatId = query.message.chat.id;

    if (data === "pay_enter_amount") {
      paymentState[userId] = { awaitingAmount: true };
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(
        chatId,
        "Введите сумму пополнения в рублях одним числом.\n\n" +
          "1 публикация = 100 ₽.\n" +
          "Пример: 100, 200, 500.\n\n" +
          "Сейчас бот не может автоматически проверять факт оплаты — " +
          "пожалуйста, внесите эту же сумму на Boosty после начисления публикаций:\n" +
          BOOSTY_URL
      );
    } else if (data === "enter_promo") {
      promoState[userId] = { awaitingPromo: true };
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(
        chatId,
        "Пожалуйста, отправьте промокод одним сообщением."
      );
    } else if (data === "show_balance") {
      await bot.answerCallbackQuery(query.id);
      await sendBalance(chatId, userId);
    } else {
      await bot.answerCallbackQuery(query.id);
    }
  } catch (err) {
    console.error("CALLBACK ERROR:", err);
  }
});

// =====================================================================
// ОСНОВНОЙ ОБРАБОТЧИК СООБЩЕНИЙ
// =====================================================================
bot.on("message", async (msg) => {
  try {
    const text = msg.text || "";
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    // 1) Подключение канала (пересланное сообщение из канала)
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      const channelId = msg.forward_from_chat.id;
      const title = msg.forward_from_chat.title || "";

      await usersCol.updateOne(
        { userId },
        {
          $set: {
            channelId,
            channelTitle: title,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );

      await bot.sendMessage(
        chatId,
        `Канал успешно подключён: ${title}\n\n` +
          "Теперь Вы можете отправить ссылку на стрим."
      );
      return;
    }

    // 2) Обработка режима ожидания промокода
    if (promoState[userId] && promoState[userId].awaitingPromo) {
      promoState[userId].awaitingPromo = false;

      const code = text.trim().toUpperCase();
      const promo = await promosCol.findOne({ code });

      if (!promo || promo.used) {
        await bot.sendMessage(
          chatId,
          "Промокод не найден или уже был использован."
        );
        return;
      }

      await promosCol.updateOne(
        { code },
        {
          $set: {
            used: true,
            usedBy: userId,
            usedAt: new Date()
          }
        }
      );

      await addUserCredits(userId, promo.credits);
      const balance = await getUserBalance(userId);

      await bot.sendMessage(
        chatId,
        `Промокод принят. Начислено ${promo.credits} публикаций.\n` +
          `Текущий баланс: ${balance} публикаций.`
      );

      await processPendingStreamIfAny(userId, chatId);
      return;
    }

    // 3) Обработка режима ожидания суммы пополнения
    if (paymentState[userId] && paymentState[userId].awaitingAmount) {
      // ждем число
      const sumStr = text.replace(/\s+/g, "");
      const amount = parseInt(sumStr, 10);

      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(
          chatId,
          "Пожалуйста, отправьте сумму пополнения цифрами, без текста.\n" +
            "Пример: 100, 200, 500."
        );
        return;
      }

      if (amount < 100) {
        await bot.sendMessage(
          chatId,
          "Минимальная сумма пополнения — 100 ₽ (1 публикация)."
        );
        return;
      }

      paymentState[userId].awaitingAmount = false;

      const credits = Math.floor(amount / 100);
      await addUserCredits(userId, credits);
      const balance = await getUserBalance(userId);

      await bot.sendMessage(
        chatId,
        `Я начислил Вам ${credits} публикаций (1 публикация = 100 ₽).\n` +
          `Текущий баланс: ${balance} публикаций.\n\n` +
          "Пожалуйста, оплатите эту сумму на Boosty:\n" +
          `${BOOSTY_URL}\n\n` +
          "Сейчас бот не проверяет оплату автоматически, поэтому важно " +
          "внести ту же сумму, которую Вы указали здесь."
      );

      await processPendingStreamIfAny(userId, chatId);
      return;
    }

    // 4) Игнорируем команды — они обрабатываются отдельно
    if (text.startsWith("/")) return;

    // 5) Обрабатываем только ссылки
    if (!text.startsWith("http://") && !text.startsWith("https://")) return;

    // 6) Пытаемся опубликовать стрим
    await processStreamForUser(userId, chatId, text);
  } catch (err) {
    console.error("MESSAGE ERROR:", err);
  }
});

// =====================================================================
app.listen(PORT, () => console.log("SERVER RUNNING ON PORT", PORT));
