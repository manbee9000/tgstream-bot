import express from "express";
import TelegramBot from "node-telegram-bot-api";

// ========== CONFIG ==========
const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;

// домен для Twitch embed (parent=)
// например из https://tgstream-bot.onrender.com возьмём tgstream-bot.onrender.com
let PARENT_DOMAIN = "localhost";
try {
  if (RENDER_URL) {
    PARENT_DOMAIN = new URL(RENDER_URL).host;
  }
} catch (e) {
  console.error("Cannot parse RENDER_URL, fallback parent domain:", e);
}

// =============================
const app = express();
app.use(express.json());

if (!TOKEN) {
  console.error("BOT_TOKEN is not set!");
  process.exit(1);
}

if (!RENDER_URL) {
  console.error("RENDER_EXTERNAL_URL is not set!");
}

const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

// Хранилище настроек стримеров
// streamerConfig[userId] = { channelId, donateName }
const streamerConfig = {};

// ========== WEBHOOK ==========
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ========== WEBAPP PAGE ==========
app.get("/webapp", (req, res) => {
  const src = (req.query.src || "").toString();
  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Stream</title>
      </head>
      <body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh;">
        <iframe
          src="${src}"
          allowfullscreen
          allow="autoplay; encrypted-media; picture-in-picture"
          style="width:100%;height:100%;border:0;"
        ></iframe>
      </body>
    </html>
  `);
});

// ========== HELPERS: YOUTUBE ID / EMBED / THUMBS ==========
function extractYouTubeId(url) {
  let id = null;
  try {
    if (url.includes("watch?v=")) {
      id = url.split("v=")[1].split("&")[0];
    } else if (url.includes("youtu.be/")) {
      id = url.split("youtu.be/")[1].split("?")[0];
    }
  } catch (e) {
    id = null;
  }
  return id || null;
}

async function getTwitchThumbnail(url) {
  try {
    let name = url.split("/").pop() || "";
    if (!name) return null;
    name = name.split("?")[0];
    return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${name}-1280x720.jpg`;
  } catch {
    return null;
  }
}

async function getYouTubeThumbnail(url) {
  try {
    const id = extractYouTubeId(url);
    if (!id) return null;
    return `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  } catch {
    return null;
  }
}

async function getThumbnail(url) {
  if (url.includes("twitch.tv")) return getTwitchThumbnail(url);
  if (url.includes("youtu")) return getYouTubeThumbnail(url);
  return null;
}

// ========== EMBED URL ДЛЯ IFRAME ==========
function getEmbedUrl(rawUrl) {
  // Twitch: https://www.twitch.tv/CHANNEL -> player.twitch.tv
  if (rawUrl.includes("twitch.tv")) {
    try {
      const parts = rawUrl.split("/");
      let name = parts.pop() || parts.pop() || ""; // на случай трейлинга /
      name = name.split("?")[0];
      if (!name) return rawUrl;

      return `https://player.twitch.tv/?channel=${encodeURIComponent(
        name
      )}&parent=${encodeURIComponent(PARENT_DOMAIN)}`;
    } catch {
      return rawUrl;
    }
  }

  // YouTube: обычные ссылки -> embed
  if (rawUrl.includes("youtu")) {
    const id = extractYouTubeId(rawUrl);
    if (id) {
      return `https://www.youtube.com/embed/${id}?autoplay=1`;
    }
  }

  // по умолчанию — как есть
  return rawUrl;
}

// ========== ОТПРАВКА ПОСТОВ СО СТРИМОМ ==========
async function publishStreamPost(channelId, streamUrlForEmbed, thumbnail, donateName) {
  const buttons = [
    [
      {
        text: "🎥 Смотреть стрим",
        url: `${RENDER_URL}/webapp?src=${encodeURIComponent(streamUrlForEmbed)}`
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

// ========== COMMANDS ==========

// /donate name
bot.onText(/\/donate (.+)/, (msg, match) => {
  const userId = msg.from.id;
  const name = match[1].trim();

  streamerConfig[userId] = streamerConfig[userId] || {};
  streamerConfig[userId].donateName = name;

  bot.sendMessage(
    msg.chat.id,
    `Донат подключён:\nhttps://www.donationalerts.com/r/${name}`
  );
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

// ========== UNIVERSAL MESSAGE HANDLER ==========
bot.on("message", async (msg) => {
  try {
    const text = msg.text || "";
    const userId = msg.from.id;

    // 1) Подключение канала через пересланное сообщение
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      const channelId = msg.forward_from_chat.id;

      streamerConfig[userId] = streamerConfig[userId] || {};
      streamerConfig[userId].channelId = channelId;

      return bot.sendMessage(
        msg.chat.id,
        `Канал подключён: ${msg.forward_from_chat.title}\nТеперь просто пришли ссылку на стрим.`
      );
    }

    // команды обрабатываются отдельно
    if (text.startsWith("/")) return;

    // 2) Нас интересуют только ссылки в личке
    if (msg.chat.type !== "private") return;
    if (!text.startsWith("http://") && !text.startsWith("https://")) return;

    const cfg = streamerConfig[userId];
    if (!cfg || !cfg.channelId) {
      return bot.sendMessage(
        msg.chat.id,
        "Сначала подключи канал:\nПерешли мне любое сообщение из него."
      );
    }

    const originalUrl = text.trim();
    const embedUrl = getEmbedUrl(originalUrl);
    const thumb = await getThumbnail(originalUrl);

    await publishStreamPost(cfg.channelId, embedUrl, thumb, cfg.donateName);

    bot.sendMessage(msg.chat.id, "Готово! Пост опубликован в твоём канале.");
  } catch (err) {
    console.error("MESSAGE ERROR", err);
    try {
      await bot.sendMessage(
        msg.chat.id,
        "Произошла ошибка при обработке сообщения. Попробуй ещё раз чуть позже."
      );
    } catch {}
  }
});

// ========== SERVER ==========
app.listen(PORT, () => console.log("SERVER RUNNING ON PORT", PORT));
