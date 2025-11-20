import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN, { webHook: true });

const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("BOT OK");
});

bot.on("channel_post", (msg) => {
  console.log("CHANNEL_POST", msg.chat.id, msg.chat.title);
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Бот работает. Отправь ссылку.");
});

bot.on("message", async (msg) => {
  const text = msg.text;

  if (!text || msg.chat.type === "channel") return;

  if (text.startsWith("http://") || text.startsWith("https://")) {
    try {
      await bot.sendMessage(CHANNEL_ID, "СТРИМ: " + text);
      await bot.sendMessage(msg.chat.id, "Опубликовано.");
    } catch (e) {
      await bot.sendMessage(msg.chat.id, "Ошибка. Добавь меня админом в канал.");
    }
  }
});

const PORT = process.env.PORT;
app.listen(PORT, () => console.log("SERVER RUNNING", PORT));
