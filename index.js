import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

const app = express();
app.use(express.json());

// Создаём бота через WebHook
const bot = new TelegramBot(TOKEN, { webHook: true });

// Устанавливаем webhook URL
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

// Webhook endpoint — Telegram отправляет сюда обновления
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Проверка сервера
app.get("/", (req, res) => {
  res.send("BOT OK");
});

// WebApp endpoint — HTML плеер
app.get("/webapp", (req, res) => {
  res.sendFile("/opt/render/project/src/webapp.html");
});

// Ловим канальные посты (для определения channel_id)
bot.on("channel_post", (msg) => {
  console.log("CHANNEL_POST:", msg.chat.id, msg.chat.title);
});

// Команда /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Бот работает. Пришли ссылку на стрим.");
});

// Ловим ссылки
bot.on("message", async (msg) => {
  const text = msg.text;
  if (!text || msg.chat.type === "channel") return;

  if (!(text.startsWith("http://") || text.startsWith("https://"))) return;

  const url = text.trim();

  // Проверяем YouTube
  const isYouTube =
    url.includes("youtube.com") ||
    url.includes("youtu.be");

  let button;

  if (isYouTube) {
    // YouTube встроится нативно в Telegram
    button = {
      inline_keyboard: [
        [{ text: "🎥 Смотреть стрим", url: url }]
      ]
    };
  } else {
    // Все другие платформы — WebApp страница
    const webappUrl = `${RENDER_URL}/webapp?src=${encodeURIComponent(url)}`;

    button = {
      inline_keyboard: [
        [{
          text: "🎥 Смотреть стрим",
          web_app: { url: webappUrl }
        }]
      ]
    };
  }

  try {
    // публкуем пост в канале
    await bot.sendMessage(
      CHANNEL_ID,
      `🔴 Стрим сейчас!`,
      { reply_markup: button }
    );

    await bot.sendMessage(msg.chat.id, "Опубликовано.");
  } catch (err) {
    await bot.sendMessage(
      msg.chat.id,
      "Ошибка: не могу отправить сообщение в канал. Проверь, что я админ."
    );
  }
});

// Запуск сервера
const PORT = process.env.PORT;
app.listen(PORT, () => console.log("SERVER RUNNING", PORT));
