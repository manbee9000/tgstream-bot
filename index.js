import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const app = express();
app.use(express.json());

// Telegram Webhook
const bot = new TelegramBot(TOKEN, { webHook: true });
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Healthcheck
app.get("/", (req, res) => {
  res.send("BOT OK");
});

// =======================
// WEBAPP VIEWER
// =======================
app.get("/webapp", (req, res) => {
  const raw = req.query.src || "";
  const DOMAIN = "tgstream-bot.onrender.com";

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Stream Viewer</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html, body { margin:0; padding:0; height:100%; background:#000; }
iframe { width:100%; height:100%; border:none; }
#msg { color:white; text-align:center; margin-top:40vh; font-size:18px; }
</style>
</head>
<body>

<div id="msg"></div>
<iframe id="frame" allowfullscreen></iframe>

<script>
const rawUrl = ${JSON.stringify(raw)};
const frame = document.getElementById("frame");
const msg = document.getElementById("msg");

if (!rawUrl) {
  msg.innerText = "Нет ссылки";
} else {
  try {
    const url = decodeURIComponent(rawUrl);

    // YouTube
    if (url.includes("youtube.com") || url.includes("youtu.be")) {
      msg.innerHTML = "Открываю YouTube…";
      window.location.href = url;
    }

    // VK
    else if (url.includes("vk.com/video")) {
      let embed = null;
      const match = url.match(/video(-?\\d+)_(\\d+)/);
      if (match) {
        embed = "https://vk.com/video_ext.php?oid=" + match[1] + "&id=" + match[2];
      }
      if (embed) frame.src = embed;
      else msg.innerHTML = "Не удалось распознать VK видео";
    }

    // Twitch
    else if (url.includes("twitch.tv")) {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      const channel = parts[0];
      if (channel) {
        frame.src =
          "https://player.twitch.tv/?channel=" +
          encodeURIComponent(channel) +
          "&parent=${DOMAIN}";
      } else msg.innerHTML = "Не удалось определить Twitch-канал";
    }

    // fallback
    else {
      msg.innerHTML = "Открываю…";
      window.location.href = url;
    }

  } catch (e) {
    msg.innerHTML = "Ошибка загрузки";
  }
}
</script>

</body>
</html>`);
});

// =======================
// Команды /start, /donate
// =======================

let donateMap = {}; 

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Бот работает.\nОтправь ссылку на стрим — я опубликую его в твоём канале."
  );
});

bot.onText(/\/donate (.+)/, async (msg, match) => {
  donateMap[msg.chat.id] = match[1].trim();

  await bot.sendMessage(
    msg.chat.id,
    `Донаты настроены: https://www.donationalerts.com/r/${match[1].trim()}`
  );
});

// =======================
// ПРИЁМ ССЫЛКИ НА СТРИМ
// =======================

bot.on("message", async (msg) => {
  const text = msg.text;

  if (!text) return;
  if (msg.chat.type === "channel") return;

  if (text.startsWith("http://") || text.startsWith("https://")) {

    const donateUser = donateMap[msg.chat.id] || null;

    const webappUrl =
      `${RENDER_URL}/webapp?src=` +
      encodeURIComponent(text);

    // ключевое отличие: ТОЛЬКО url кнопки
    let keyboard = [
      [{ text: "🎥 Смотреть стрим", url: webappUrl }]
    ];

    if (donateUser) {
      keyboard.push([
        { text: "💸 Сделать донат", url: `https://www.donationalerts.com/r/${donateUser}` }
      ]);
    }

    try {
      // 1 пост — основной
      await bot.sendMessage(
        CHANNEL_ID,
        "🔴 Стрим сейчас!\n\n🎥 Нажми «Смотреть стрим», чтобы открыть трансляцию.\n💬 Чат — в комментариях под постом ниже.\n💸 Донаты — через кнопку ниже.",
        {
          reply_markup: {
            inline_keyboard: keyboard
          }
        }
      );

      // 2 пост — чат
      await bot.sendMessage(CHANNEL_ID, "💬 Чат стрима");

      await bot.sendMessage(msg.chat.id, "Опубликовано.");
    } catch (e) {
      console.log("SEND ERROR:", e);
      await bot.sendMessage(
        msg.chat.id,
        "Ошибка: не могу отправить сообщение в канал. Проверь, что я админ."
      );
    }
  }
});

// =======================
// SERVER START
// =======================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("SERVER RUNNING", PORT));
