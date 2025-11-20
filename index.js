import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;
const URL = `https://tgstream-bot.onrender.com`; // замени если другой URL

const app = express();
app.use(express.json());

// Создаём бота в режиме WEBHOOK
const bot = new TelegramBot(TOKEN, { webHook: { port: PORT } });

// Устанавливаем webhook для Telegram
bot.setWebHook(`${URL}/bot${TOKEN}`);

// Обработчик Telegram webhook
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Проверка, что сервер работает
app.get("/", (req, res) => {
  res.send("TGSTREAM BOT IS RUNNING (WEBHOOK MODE)");
});

// Команда /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Привет! Я бот для стримеров.\n\n" +
    "Отправь мне ссылку на стрим — и я создам пост для твоего Telegram-канала."
  );
});

// Получение ссылок
bot.on("message", async (msg) => {
  const text = msg.text;
  if (!text) return;

  if (text.startsWith("http://") || text.startsWith("https://")) {
    await bot.sendMessage(
      msg.chat.id,
      "🔗 Отлично! Ссылка получена.\n\n" +
      "⚠️ Постинг в каналы будет готов позже — пока функция тестовая."
    );
  }
});

// Запуск сервера (не обязателен для webhook, но пусть будет)
app.listen(PORT, () => console.log("Server running on port", PORT));
