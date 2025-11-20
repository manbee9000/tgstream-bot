import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

const app = express();
app.use(express.json());

// создаём бота через Webhook
const bot = new TelegramBot(TOKEN, { webHook: true });

// Webhook URL
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

// Webhook обработчик
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Проверка сервера
app.get("/", (req, res) => {
  res.send("BOT OK");
});

// Лог канальных сообщений
bot.on("channel_post", (msg) => {
  console.log("CHANNEL_POST:", msg.chat.id, msg.chat.title);
});

// команда /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Бот работает. Пришли ссылку на стрим.");
});

// обработка сообщений
bot.on("message", async (msg) => {
  const text = msg.text;
  if (!text || msg.chat.type === "channel") return;

  // проверяем, это ли ссылка
  if (!(text.startsWith("http://") || text.startsWith("https://"))) return;

  const url = text.trim();

  // определяем YouTube
  const isYouTube =
    url.includes("youtube.com") ||
    url.includes("youtu.be");

  let button;

  if (isYouTube) {
    // YouTube — Telegram встроит плеер автоматически
    button = {
      inline_keyboard: [
        [{ text: "🎥 Смотреть стрим", url: url }]
      ]
    };
  } else {
    // другие платформы — WebView
    const webview = `${RENDER_URL}/view?src=${encodeURIComponent(url)}`;

    button = {
      inline_keyboard: [
        [{ text: "🎥 Смотреть стрим", url: webview }]
      ]
    };
  }

  try {
    // пост в канал
    await bot.sendMessage(
      CHANNEL_ID,
      `🔴 Стрим сейчас!`,
      { reply_markup: button }
    );

    // ответ стримеру
    await bot.sendMessage(msg.chat.id, "Опубликовано.");
  } catch (err) {
    await bot.sendMessage(
      msg.chat.id,
      "Ошибка: я не могу отправить пост в канал. Проверь, что я админ."
    );
  }
});

// запуск сервера
const PORT = process.env.PORT;
app.listen(PORT, () => console.log("SERVER RUNNING", PORT));
