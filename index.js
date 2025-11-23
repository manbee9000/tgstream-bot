import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";

const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

// Хранилище настроек стримеров
const streamerConfig = {}; 
// структура:
// streamerConfig[userId] = { channelId, donateName }

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ========== WEBAPP ==========
app.get("/webapp", (req, res) => {
  const src = req.query.src || "";
  res.send(`
    <html><body style="margin:0;background:#000">
      <iframe src="${src}" allowfullscreen style="width:100%;height:100%;border:0;"></iframe>
    </body></html>
  `);
});

// ======= THUMBNAILS ========
async function getTwitchThumbnail(url) {
  const name = url.split("/").pop();
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${name}-1280x720.jpg`;
}
async function getYouTubeThumbnail(url) {
  let id = null;
  if (url.includes("watch?v=")) id = url.split("v=")[1].split("&")[0];
  if (url.includes("youtu.be/")) id = url.split("youtu.be/")[1].split("?")[0];
  return id ? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` : null;
}
async function getThumbnail(url) {
  if (url.includes("twitch.tv")) return getTwitchThumbnail(url);
  if (url.includes("youtu")) return getYouTubeThumbnail(url);
  return null;
}

// ======= SEND STREAM POSTS ========
async function publishStreamPost(channelId, streamUrl, thumbnail, donateName) {
  const buttons = [
    [
      {
        text: "🎥 Смотреть стрим",
        web_app: {
          url: `${RENDER_URL}/webapp?src=${encodeURIComponent(streamUrl)}`
        }
      }
    ]
  ];

  if (donateName) {
    buttons.push([
      {
        text: "💸 Донат",
        url: `https://www.donationalerts.com/r/${donateName}`
      }
    ]);
  }

  const caption =
    "🔴 Не пропустите стрим!\n\n" +
    "🎥 Нажмите «Смотреть стрим», чтобы открыть трансляцию.\n" +
    "💬 Чат — в комментариях под постом ниже.\n" +
    "💸 Донат — через кнопку ниже.";

  if (thumbnail) {
    await bot.sendPhoto(channelId, thumbnail, {
      caption,
      reply_markup: { inline_keyboard: buttons }
    });
  } else {
    await bot.sendMessage(channelId, caption, {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  await bot.sendMessage(channelId, "💬 Чат стрима");
}

// ========= COMMANDS =========

// /donate name
bot.onText(/\/donate (.+)/, (msg, match) => {
  const userId = msg.from.id;
  const name = match[1].trim();

  streamerConfig[userId] = streamerConfig[userId] || {};
  streamerConfig[userId].donateName = name;

  bot.sendMessage(msg.chat.id, `Донат подключён:\nhttps://www.donationalerts.com/r/${name}`);
});

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Привет! Чтобы подключить канал:\n" +
      "1️⃣ Добавь меня админом в канал.\n" +
      "2️⃣ Напиши там любое сообщение.\n" +
      "3️⃣ Перешли это сообщение мне.\n\n" +
      "После этого — просто присылай ссылку на стрим!"
  );
});

// ======== FORWARDED CHANNEL MESSAGE — AUTO CHANNEL CONNECT ========
bot.on("message", async (msg) => {
  // если юзер переслал пост из канала — считаем это подключением
  if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
    const userId = msg.from.id;
    const channelId = msg.forward_from_chat.id;

    streamerConfig[userId] = streamerConfig[userId] || {};
    streamerConfig[userId].channelId = channelId;

    return bot.sendMessage(
      msg.chat.id,
      `Канал подключён: ${msg.forward_from_chat.title}\nТеперь просто пришли ссылку на стрим.`
    );
  }
});

// ======== STREAM LINKS ========
bot.on("message", async (msg) => {
  const text = msg.text;
  if (!text) return;
  if (msg.chat.type !== "private") return;
  if (text.startsWith("/")) return;

  if (!text.startsWith("http://") && !text.startsWith("https://")) return;

  const userId = msg.from.id;
  const cfg = streamerConfig[userId];

  if (!cfg || !cfg.channelId) {
    return bot.sendMessage(
      msg.chat.id,
      "Сначала подключи канал:\nПерешли мне любое сообщение из него."
    );
  }

  const streamUrl = text.trim();

  try {
    const thumb = await getThumbnail(streamUrl);
    await publishStreamPost(cfg.channelId, streamUrl, thumb, cfg.donateName);

    bot.sendMessage(msg.chat.id, "Готово! Пост опубликован в твоём канале.");
  } catch (err) {
    console.error("POST ERROR", err);
    bot.sendMessage(msg.chat.id, "Ошибка: я не могу отправить сообщение в канал.");
  }
});

// ========= SERVER =========
app.listen(PORT, () => console.log("SERVER RUNNING", PORT));
