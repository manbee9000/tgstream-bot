import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

const app = express();
app.use(express.json());

// Стартуем бота в режиме webhook
const bot = new TelegramBot(TOKEN, {
  webHook: {
    port: process.env.PORT || 10000
  }
});

// Устанавливаем webhook в Telegram
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

console.log("Webhook set:", `${RENDER_URL}/webhook/${TOKEN}`);

// Принимаем webhook от Telegram
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Проверка что сервер жив
app.get("/", (req, res) => {
  res.send("BOT OK");
});

// Логируем любые входящие сообщения
bot.on("message", (msg) => {
  console.log("INCOMING MESSAGE:", JSON.stringify(msg, null, 2));
});

// Команда /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Бот работает. Отправь ссылку на стрим.");
});

// Основная логика — ловим ссылку
bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (msg.chat.type === "channel") return;

  const text = msg.text.trim();

  // Проверяем, что это ссылка
  if (!text.startsWith("http://") && !text.startsWith("https://")) return;

  // Строим ссылку на WebApp
  const webAppUrl = `${RENDER_URL}/webapp?src=${encodeURIComponent(text)}`;

  try {
    // Отправка в канал
    await bot.sendMessage(CHANNEL_ID, "🔴 Стрим сейчас!", {
      reply_markup: {
        inline_keyboard: [[
          {
            text: "🎥 Смотреть стрим",
            url: webAppUrl   // ← правильно для каналов
          }
        ]]
      }
    });

    // Ответ пользователю
    await bot.sendMessage(msg.chat.id, "Опубликовано в канале.");
  } catch (e) {
    console.error("SEND ERROR:", e);

    await bot.sendMessage(
      msg.chat.id,
      "Ошибка: не могу отправить сообщение в канал. Проверь, что я админ."
    );
  }
});

// WebApp endpoint
app.get("/webapp", (req, res) => {
  const streamUrl = req.query.src || "";

  res.send(`
    <html>
      <body style="margin:0;background:#000;">
        <iframe
          src="${streamUrl}"
          style="width:100%;height:100%;border:0;"
          allowfullscreen>
        </iframe>
      </body>
    </html>
  `);
});
