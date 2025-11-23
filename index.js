import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

// ВАЖНО: ссылку DonationAlerts ты вставишь сюда
// Пример: https://www.donationalerts.com/r/streamername
const DONATE_URL = process.env.DONATE_URL || "https://www.donationalerts.com/r/streamername";

const app = express();
app.use(express.json());

// Создаём бота в режиме webhook
const bot = new TelegramBot(TOKEN, { webHook: true });

// Устанавливаем webhook
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);
console.log("Webhook set:", `${RENDER_URL}/webhook/${TOKEN}`);

// Принимаем обновления
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Проверка сервера
app.get("/", (req, res) => {
  res.send("BOT OK");
});

// Лог входящих
bot.on("message", (msg) => {
  console.log("INCOMING MESSAGE:", JSON.stringify(msg, null, 2));
});

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Бот работает. Пришли ссылку на стрим.");
});

// Ловим ссылку от стримера
bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (msg.chat.type === "channel") return;

  const text = msg.text.trim();

  if (!text.startsWith("http://") && !text.startsWith("https://")) return;

  const webAppUrl = `${RENDER_URL}/webapp?src=${encodeURIComponent(text)}`;

  const postText =
    "🔴 **Стрим сейчас!**\n\n" +
    "🎥 Нажми «Смотреть стрим», чтобы открыть трансляцию.\n" +
    "💬 Чат — в комментариях под этим постом.\n" +
    "💸 Донаты с сообщением — через кнопку ниже.\n";

  try {
    await bot.sendMessage(CHANNEL_ID, postText, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🎥 Смотреть стрим", url: webAppUrl }
          ],
          [
            { text: "💸 Отправить донат", url: DONATE_URL }
          ]
        ]
      }
    });

    await bot.sendMessage(msg.chat.id, "Опубликовано в канале.");
  } catch (e) {
    console.error("SEND ERROR:", e);
    await bot.sendMessage(
      msg.chat.id,
      "Ошибка: не могу отправить сообщение в канал. Проверь, что я админ."
    );
  }
});

// WebApp — плеер + встраивание
app.get("/webapp", (req, res) => {
  const streamUrl = req.query.src || "";
  const PARENT_DOMAIN = "tgstream-bot.onrender.com";

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Stream Viewer</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      background:#000;
    }
    iframe {
      width:100%;
      height:100%;
      border:0;
      background:#000;
    }
  </style>
</head>
<body>
  <iframe id="player"></iframe>

  <script>
    const raw = ${JSON.stringify(streamUrl)};
    let src = "";
    try { src = decodeURIComponent(raw); } catch(e){ src = raw; }

    let embed = src;

    if (src.includes("twitch.tv")) {
      const url = new URL(src);
      const channel = url.pathname.split("/").filter(Boolean)[0];
      embed = "https://player.twitch.tv/?channel=" + channel + "&parent=${PARENT_DOMAIN}";
    }
    else if (src.includes("youtu")) {
      let id = "";
      if (src.includes("watch?v=")) id = new URL(src).searchParams.get("v");
      else id = src.split("/").pop();
      embed = "https://www.youtube.com/embed/" + id;
    }

    document.getElementById("player").src = embed;
  </script>
</body>
</html>`);
});

// Запуск
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("SERVER RUNNING", PORT));
