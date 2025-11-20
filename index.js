import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN; // токен будет храниться на Render
const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

// Проверка что бот жив
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

// Получение любой ссылки
bot.on("message", async (msg) => {
  const text = msg.text;

  if (!text) return;

  // Проверяем, похоже ли на ссылку
  if (text.startsWith("http://") || text.startsWith("https://")) {
    await bot.sendMessage(
      msg.chat.id,
      "Отлично! Создаю пост для канала…\n\n" +
      "⚠️ *Пока функция постинга в канал тестовая — но бот уже принимает ссылки!*",
      { parse_mode: "Markdown" }
    );

    // тут потом будет логика создания поста
  }
});

// Старт сервера для Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

