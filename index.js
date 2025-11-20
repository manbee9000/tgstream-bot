import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const app = express();
app.use(express.json());

// Создаём бота через WEBHOOK (НЕ polling!)
const bot = new TelegramBot(TOKEN, { webHook: true });

// Webhook URL от Render
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

// Ручка, куда Telegram будет слать обновления
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Проверка работоспособности сервера
app.get("/", (req, res) => {
  res.send("TGSTREAM BOT IS RUNNING");
});

// Логируем канальные посты
bot.on("channel_post", (msg) => {
  console.log("CHANNEL POST DETECTED:", msg.chat.id, msg.chat.title);
});

// Команда /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Привет! Я бот для стримеров.\n\n" +
    "Отправь мне ссылку на стрим — и я создам пост в твоём канале."
  );
});

// Ловим ссылки
bot.on("message", async (msg) => {
  const text = msg.text;

  if (!text || msg.chat.type === "channel") return;

  if (text.startsWith("http://") || text.startsWith("https://")) {
    await bot.sendMessage(msg.chat.id, "Создаю пост…");

    try {
      await bot.sendMessage(
        CHANNEL_ID,
        `🔴 *Стрим сейчас!*\n${text}`,
        { parse_mode: "Markdown" }
      );

      bot.sendMessage(msg.chat.id, "Готово! Пост опубликован 🎉");
    } catch (err) {
      bot.sendMessage(
        msg.chat.id,
        "⚠️ Не могу отправить в канал. Проверь, что я админ."

