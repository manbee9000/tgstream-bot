import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;       // токен бота из Render
const CHANNEL_ID = process.env.CHANNEL_ID; // id канала также из Render

// Важно: polling ОК, пока у нас нет вебхуков
const bot = new TelegramBot(TOKEN, { polling: true });

const app = express();
app.use(express.json());

// Проверка, что сервер жив
app.get("/", (req, res) => {
  res.send("TGSTREAM BOT IS RUNNING");
});

// Команда /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Привет! Я бот для стримеров.\n\n" +
    "Отправь мне ссылку на стрим (YouTube, Twitch), и я создам пост для твоего Telegram-канала."
  );
});

// Ловим события канала (чтобы узнать channel_id)
bot.on("channel_post", (msg) => {
  console.log("CHANNEL POST DETECTED:");
  console.log("chat.id =", msg.chat.id);
  console.log("title =", msg.chat.title);
});

// Ловим любые сообщения
bot.on("message", async (msg) => {
  const text = msg.text;

  // Игнорируем сообщения из каналов (кроме channel_post)
  if (!text || msg.chat.type === "channel") return;

  // Если это похоже на ссылку
  if (text.startsWith("http://") || text.startsWith("https://")) {
    await bot.sendMessage(msg.chat.id, "Создаю пост в канал…");

    try {
      await bot.sendMessage(
        CHANNEL_ID,
        `🔴 *СТРИМ СЕЙЧАС!*\n\n${text}`,
        { parse_mode: "Markdown" }
      );

      await bot.sendMessage(msg.chat.id, "Готово! Пост опубликован 🎉");
    } catch (err) {
      console.error("Ошибка публикации:", err);
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ Ошибка! Я не могу отправить сообщение в канал.\n" +
        "Проверь, что бот — администратор канала."
      );
    }
  }
});

// Запуск сервера (ВАЖНО: только process.env.PORT)
const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

