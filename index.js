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

const PRICE_PER_POST = parseInt(process.env.PRICE_PER_POST || "100", 10);

const DA_CLIENT_ID = process.env.DA_CLIENT_ID || null;
const DA_CLIENT_SECRET = process.env.DA_CLIENT_SECRET || null;

const DA_SCOPES =
  process.env.DA_SCOPES || "oauth-user-show oauth-donation-subscribe";

const DA_REDIRECT_PATH = process.env.DA_REDIRECT_PATH || "/da-oauth";

const ADMIN_TG_ID = 618072923;

// ---- Parent domain for Twitch
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
  console.error("Внимание: RENDER_EXTERNAL_URL не задан!");
}

// ================== WEBHOOK ==================
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================== WEBAPP PLAYER ==================
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

// =========================================================
// ================== YouTube & Twitch helpers =============
// =========================================================

function extractYouTubeId(url) {
  try {
    if (url.includes("watch?v=")) return url.split("v=")[1].split("&")[0];
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
    if (id) return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
  }

  return url;
}

// =========================================================
// ================== MONGODB INIT =========================
// =========================================================
let mongoClient;
let db;
let usersCol;
let ordersCol;
let promoCol;
let settingsCol;
let rafflesCol;

async function initMongo() {
  if (!MONGODB_URI) {
    console.error("MONGODB_URI не задан!");
    return;
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();

    db = mongoClient.db();
    usersCol = db.collection("users");
    ordersCol = db.collection("orders");
    promoCol = db.collection("promocodes");
    settingsCol = db.collection("settings");
    rafflesCol = db.collection("raffles");

    console.log("MongoDB подключен");
  } catch (err) {
    console.error("Ошибка подключения Mongo:", err);
  }
}

// =========================================================
// ================== RAFFLE FUNCTIONS =====================
// =========================================================

async function createDraftRaffle(ownerId) {
  const doc = {
    ownerId,
    channelId: null,
    title: null,      // текст розыгрыша
    imageUrl: null,
    requiredSubs: [],
    endAt: null,      // только время окончания
    participants: [],
    status: "draft",
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
  return rafflesCol.findOne({ ownerId, status: "draft" });
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

// =========================================================
// ================== SUPPORT BUTTON =======================

function supportKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "❤️ Поддержать бота",
          url: DA_DONATE_URL,
        },
      ],
    ],
  };
}

// =========================================================
// ================== STREAM PUBLISH =======================

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
    "🎥 Нажмите «Смотреть стрим».\n" +
    "💬 Чат — в комментариях под постом.";

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
// ================== MENU /start ==========================
// =========================================================

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        ["🎁 Создать розыгрыш"],
        ["📢 Подключить канал", "📊 Отправить стрим"],
        ["💳 Пополнить баланс", "ℹ️ Инструкции"],
      ],
      resize_keyboard: true,
    },
  };
}

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    "Добро пожаловать!\n\n" +
      "Этот бот помогает:\n" +
      "• публиковать стримы в канал\n" +
      "• создавать розыгрыши\n" +
      "• проверять подписки\n" +
      "• проводить честный выбор победителя\n\n" +
      "Выберите действие:",
    mainMenu()
  );
});

// =========================================================
// ================== MENU HANDLERS ========================
// =========================================================

bot.on("message", async (msg) => {
  const text = msg.text;
  const uid = msg.from.id;

  // --- Подключить канал ---
  if (text === "📢 Подключить канал") {
    return bot.sendMessage(
      uid,
      "Чтобы подключить канал:\n\n" +
        "1️⃣ Добавьте бота в ваш канал как администратора\n" +
        "2️⃣ Перешлите сюда любое сообщение из канала\n\n" +
        "Бот автоматически запомнит ID канала."
    );
  }

  // --- Отправить стрим ---
  if (text === "📊 Отправить стрим") {
    return bot.sendMessage(
      uid,
      "Отправьте ссылку на стрим (YouTube или Twitch)."
    );
  }

  // --- Пополнить баланс ---
  if (text === "💳 Пополнить баланс") {
    return bot.sendMessage(
      uid,
      "Стоимость публикации розыгрыша: 100 ₽.\n\n" +
        "Вы можете пополнить баланс по ссылке:",
      supportKeyboard()
    );
  }

  // --- Инструкции ---
  if (text === "ℹ️ Инструкции") {
    return bot.sendMessage(
      uid,
      "📘 Инструкция по использованию:\n\n" +
        "• «Подключить канал» — привязывает канал\n" +
        "• «Создать розыгрыш» — запускает мастер создания\n" +
        "• «Отправить стрим» — публикация стрима в канал\n" +
        "• «Пополнить баланс» — покупка публикаций розыгрышей\n"
    );
  }

  // --- Создать розыгрыш ---
  if (text === "🎁 Создать розыгрыш") {
    const channel = await settingsCol.findOne({ ownerId: uid, type: "channel" });

    if (!channel) {
      return bot.sendMessage(
        uid,
        "❌ У вас не подключён ни один канал.\n\n" +
          "Сначала нажмите «📢 Подключить канал».",
        mainMenu()
      );
    }

    const draft = await getActiveDraft(uid);
    if (draft) {
      await rafflesCol.deleteOne({ _id: draft._id });
    }

    const raffle = await createDraftRaffle(uid);
    return bot.sendMessage(
      uid,
      "✏️ Введите описание розыгрыша (можете приложить фото)."
    );
  }

  // ======================================================
  // ===== ОБРАБОТКА СООБЩЕНИЙ ПОШАГОВОГО МАСТЕРА =========
  // ======================================================

  const draft = await getActiveDraft(uid);

  if (draft) {
    // Если фото + текст — сохранить фото
    if (msg.photo) {
      const file = await bot.getFile(msg.photo[msg.photo.length - 1].file_id);
      const imageUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

      await updateRaffle(draft._id, { imageUrl });
      return bot.sendMessage(uid, "📸 Фото сохранено.\nТеперь пришлите текст розыгрыша.");
    }

    // 1) Текст розыгрыша
    if (!draft.title) {
      await updateRaffle(draft._id, { title: text });

      return bot.sendMessage(
        uid,
        "📌 Теперь отправьте список каналов, на которые нужно подписаться.\n\n" +
          "Формат: @channel1 @channel2 @channel3\n" +
          "Если подписки не нужны — отправьте «нет»."
      );
    }

    // 2) Каналы для проверки подписки
    if (draft.title && draft.requiredSubs.length === 0) {
      if (text.toLowerCase() === "нет") {
        await updateRaffle(draft._id, { requiredSubs: [] });
      } else {
        const channels = text
          .split(/\s+/)
          .map((c) => c.trim())
          .filter((c) => c.startsWith("@"));

        await updateRaffle(draft._id, { requiredSubs: channels });
      }

      return bot.sendMessage(
        uid,
        "⏳ Теперь укажите ВРЕМЯ ОКОНЧАНИЯ.\n\nФормат:\n" +
          "`дд.мм.гггг чч:мм`\n\n" +
          "Например:\n" +
          "`29.03.2025 13:00`",
        { parse_mode: "Markdown" }
      );
    }

    // 3) Время окончания
    if (draft.endAt === null) {
      const parsed = parseDate(text);

      if (!parsed) {
        return bot.sendMessage(
          uid,
          "❌ Неверный формат времени.\nИспользуйте: `дд.мм.гггг чч:мм`",
          { parse_mode: "Markdown" }
        );
      }

      await updateRaffle(draft._id, { endAt: parsed });

      return bot.sendMessage(
        uid,
        "📢 Всё готово!\n\n" +
          "Теперь нажмите «Опубликовать розыгрыш».\nЦена: 100 ₽",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📢 Опубликовать", callback_data: "publish_raffle" }],
            ],
          },
        }
      );
    }
  }
});

// =========================================================
// ====================== КНОПКИ CALLBACK ==================
// =========================================================

bot.on("callback_query", async (query) => {
  const uid = query.from.id;
  const data = query.data;

  if (data === "publish_raffle") {
    const draft = await getActiveDraft(uid);
    if (!draft) return;

    // Проверяем канал
    const channel = await settingsCol.findOne({ ownerId: uid, type: "channel" });
    if (!channel) {
      return bot.sendMessage(uid, "❌ Нет подключённого канала.");
    }

    // Проверяем баланс — (здесь можно дополнить)
    // пока разрешаем бесплатно
    // потом подключим списание

    // Формируем текст
    const text =
      `🎁 *Розыгрыш!*\n\n${draft.title}\n\n` +
      `⏳ Итоги: *${formatDate(draft.endAt)}*\n`;

    const markup = {
      inline_keyboard: [
        [
          {
            text: "🎉 Участвовать",
            url: `${RENDER_URL}/giveaway/?id=${draft._id}`,
          },
        ],
      ],
    };

    if (draft.imageUrl) {
      await bot.sendPhoto(channel.channelId, draft.imageUrl, {
        caption: text,
        parse_mode: "Markdown",
        reply_markup: markup,
      });
    } else {
      await bot.sendMessage(channel.channelId, text, {
        parse_mode: "Markdown",
        reply_markup: markup,
      });
    }

    await updateRaffle(draft._id, { status: "active" });

    await bot.sendMessage(uid, "✅ Розыгрыш опубликован!", mainMenu());
  }
});

// =========================================================
// ====================== DATE PARSER ======================
// =========================================================

function parseDate(str) {
  // формат: 29.03.2025 13:00
  const regex = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/;

  const m = str.match(regex);
  if (!m) return null;

  const [_, dd, mm, yyyy, hh, min] = m;

  const d = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00+03:00`);
  if (isNaN(d.getTime())) return null;

  return d;
}

function formatDate(date) {
  return date.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// =========================================================
// ====================== CHANNEL LINK ======================
// =========================================================

bot.on("message", async (msg) => {
  if (!msg.forward_from_chat) return;

  const chat = msg.forward_from_chat;
  const uid = msg.from.id;

  if (chat.type === "channel") {
    await settingsCol.updateOne(
      { ownerId: uid, type: "channel" },
      { $set: { ownerId: uid, type: "channel", channelId: chat.id } },
      { upsert: true }
    );

    return bot.sendMessage(
      uid,
      `📢 Канал подключён:\n${chat.title || chat.username || chat.id}`,
      mainMenu()
    );
  }
});

// =========================================================
// ============== OAUTH DonationAlerts CALLBACK =============
// =========================================================

app.get(DA_REDIRECT_PATH, async (req, res) => {
  res.send("DonationAlerts успешно авторизован!");
});

// =========================================================
// ====================== START SERVER ======================
// =========================================================

initMongo().then(() => {
  app.listen(PORT, () =>
    console.log(`SERVER RUNNING ON PORT ${PORT}`)
  );
});
