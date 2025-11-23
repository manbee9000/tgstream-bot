import express from "express";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

const app = express();
app.use(express.json());

// ----------------------
//  Загрузка data.json
// ----------------------
const DATA_FILE = "./data.json";

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

let DB = loadData();

// ----------------------
//  Инициализация бота
// ----------------------
const bot = new TelegramBot(TOKEN, { webHook: true });

bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`, {
  allowed_updates: ["message", "channel_post"]
});

// ----------------------
//  Webhook endpoint
// ----------------------
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ----------------------
//  Основной маршрут
// ----------------------
app.get("/", (req, res) => {
  res.send("TGSTREAM BOT WORKING");
});

// =======================================================
//  Команда /donate username
// =======================================================
bot.onText(/\/donate (.+)/, (msg, match) => {
  const userId = msg.chat.id;
  const username = match[1].trim();

  if (!username) {
    bot.sendMessage(userId, "❗ Укажи имя DonationAlerts\nПример: `/donate myname`", {
      parse_mode: "Markdown"
    });
    return;
  }

  if (!DB[userId]) DB[userId] = {};
  DB[userId].donate = username;
  saveData(DB);

  bot.sendMessage(
    userId,
    `🎉 Готово!\nТеперь твоя кнопка доната ведёт на:\nhttps://www.donationalerts.com/r/${username}`
  );
});

// =======================================================
//  Команда /donate (без параметров) — показать текущие
// =======================================================
bot.onText(/\/donate$/, (msg) => {
  const userId = msg.chat.id;

  if (DB[userId]?.donate) {
    bot.sendMessage(
      userId,
      `💁‍♂️ Твой DonationAlerts: https://www.donationalerts.com/r/${DB[userId].donate}\n\nЧтобы изменить: /donate ИМЯ`
    );
  } else {
    bot.sendMessage(
      userId,
      "Ты пока не настроил донаты.\nОтправь:\n`/donate ИМЯ_НА_DA`",
      { parse_mode: "Markdown" }
    );
  }
});

// =======================================================
//  Команда /start
// =======================================================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "👋 Привет! Отправь мне ссылку на стрим.\n\n" +
      "Я опубликую её в твоём канале с кнопками:\n🎥 Смотреть стрим\n💰 Донат\n\n" +
      "Чтобы настроить донаты:\n/donate ИМЯ"
  );
});

// =======================================================
//  Обработка ссылок
// =======================================================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || msg.chat.type === "channel") return;

  // проверка ссылки
  const isUrl = text.startsWith("http://") || text.startsWith("https://");
  if (!isUrl) return;

  const streamUrl = text.trim();
  const encoded = encodeURIComponent(streamUrl);

  const donateName = DB[chatId]?.donate;
  const donateUrl = donateName
    ? `https://www.donationalerts.com/r/${donateName}`
    : null;

  // Кнопки
  const buttons = [
    [
      {
        text: "🎬 Смотреть стрим",
        url: `${RENDER_URL}/webapp?src=${encoded}`
      }
    ]
  ];

  if (donateUrl) {
    buttons.push([
      {
        text: "💰 Донат",
        url: donateUrl
      }
    ]);
  }

  try {
    await bot.sendMessage(CHANNEL_ID, "🔴 Стрим сейчас!", {
      reply_markup: {
        inline_keyboard: buttons
      }
    });

    bot.sendMessage(chatId, "✅ Опубликовано.");
  } catch (err) {
    console.error("SEND ERROR:", err);
    bot.sendMessage(chatId, "❌ Ошибка: не могу отправить сообщение в канал. Проверь, что я админ.");
  }
});

// =======================================================
//  WebApp endpoint
// =======================================================
app.get("/webapp", (req, res) => {
  const src = req.query.src || "";

  res.send(`
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Stream Viewer</title>
    <style>
      body { margin:0; background:#000; }
      iframe {
        width: 100vw;
        height: 100vh;
        border: none;
      }
    </style>
  </head>
  <body>
    <iframe src="${src}" allowfullscreen allow="autoplay"></iframe>
  </body>
</html>
  `);
});

// =======================================================
//  Запуск сервера
// =======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("SERVER RUNNING", PORT));
