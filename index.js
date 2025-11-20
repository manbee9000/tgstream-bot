import TelegramBot from "node-telegram-bot-api";
import express from "express";

const TOKEN = "8219924590:AAGPMxkGczrZeXw1H772plfJAuwfIE8X988"; 

// Создаём бота
const bot = new TelegramBot(TOKEN, { polling: true });

// Express сервер для Render
const app = express();
app.get("/", (req, res) => res.send("Bot is running"));
app.listen(3000, () => console.log("Server running"));

// Реакция на /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Бот работает! необходимо отправить ссылку на стрим.");
});

// Ловим ссылки на стримы
bot.on("message", (msg) => {
  const text = msg.text || "";
  
  if (text.includes("youtube.com") || text.includes("twitch.tv")) {
    bot.sendMessage(
      msg.chat.id,
      "Ссылка принята. Скоро будет готова автоматическая публикацию в канал 🔥"
    );
  }
});
