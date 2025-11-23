import express from "express";
import TelegramBot from "node-telegram-bot-api";

// ========== CONFIG ==========
const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;

// вычисляем parent-домен
let PARENT_DOMAIN = "localhost";
try {
  if (RENDER_URL) {
    PARENT_DOMAIN = new URL(RENDER_URL).host;
  }
} catch (e) {
  console.error("Cannot parse RENDER_URL:", e);
}

// ========================================
const app = express();
app.use(express.json());

if (!TOKEN) {
  console.error("BOT_TOKEN is not set!");
  process.exit(1);
}

if (!RENDER_URL) {
  console.error("RENDER_EXTERNAL_URL is not set!");
}

// Telegram Webhook
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

const streamerConfig = {}; // { userId: { channelId, donateName } }

// =====================================================
// WEBAPP — iframe wrapper
// =====================================================
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

// =====================================================
// Platform Helpers
// =====================================================

// ===== YouTube ID extract =====
function extractYouTubeId(url) {
  let id = null;
  try {
    if (url.includes("watch?v=")) id = url.split("v=")[1].split("&")[0];
    else if (url.includes("youtu.be/")) id = url.split("youtu.be/")[1].split("?")[0];
  } catch {}
  return id;
}

// ===== Twitch Thumbnail =====
async function getTwitchThumbnail(url) {
  try {
    let name = url.split("/").pop().split("?")[0];
    return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${name}-1280x720.jpg`;
  } catch {
    return null;
  }
}

// ===== YouTube Thumbnail =====
async function getYouTubeThumbnail(url) {
  const id = extractYouTubeId(url);
  if (!id) return null;

  // HD сначала
  const hd = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  // fallback
  const hq = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  return hd || hq;
}

// ===== VK Thumbnail =====
// vk.com/video-123_456 → embed: https://vk.com/video_ext.php?oid=-123&id=456
async function getVkThumbnail(url) {
  try {
    const parts = url.split("video")[1]; // "-123_456"
    const [oid, id] = parts.split("_");
    // VK не даёт thumbnail API без токена → используем стандартный превью,
    // Telegram сам создаст маленький preview.
    return null;
  } catch {
    return null;
  }
}

// =====================================================
// Embed URL builder
// =====================================================
function getEmbedUrl(url) {
  // Twitch
  if (url.includes("twitch.tv")) {
    try {
      const end = url.split("/").pop().split("?")[0];
      return `https://player.twitch.tv/?channel=${encodeURIComponent(
        end
      )}&parent=${encodeURIComponent(PARENT_DOMAIN)}`;
    } catch {
      return url;
    }
  }

  // YouTube
  if (url.includes("youtu")) {
    const id = extractYouTubeId(url);
    if (id) {
      return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
    }
  }

  // VK video
  if (url.includes("vk.com/video")) {
    try {
      const raw = url.split("video")[1]; // -123_456
      const [oid, id] = raw.split("_");

      return `https://vk.com/video_ext.php?oid=${oid}&id=${id}&hd=1`;
    } catch {
      return url;
    }
  }

  return url;
}

// =====================================================
// Thumbnail selector
// =====================================================
async function getThumbnail(url) {
  if (url.includes("twitch.tv")) return getTwitchThumbnail(url);
  if (url.includes("youtu")) return getYouTubeThumbnail(url);
  if (url.includes("vk.com/video")) return getVkThumbnail(url);
  return null;
}

// =====================================================
// Publish Stream Post
// =====================================================
async function publishStreamPost(channelId, embedUrl, thumbnail, donateName) {
  const buttons = [
    [
      {
        text: "🎥 Смотреть стрим",
        url: `${RENDER_URL}/webapp?src=${encodeURIComponent(embedUrl)}`
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

// =====================================================
// Commands
// =====================================================

// /donate
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

// =====================================================
// Universal Message Handler
// =====================================================
bot.on("message", async (msg) => {
  try {
    const text = msg.text || "";
    const userId = msg.from.id;

    // подключение канала
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      const channelId = msg.forward_from_chat.id;

      streamerConfig[userId] = streamerConfig[userId] || {};
      streamerConfig[userId].channelId = channelId;

      return bot.sendMessage(
        msg.chat.id,
        `Канал подключён: ${msg.forward_from_chat.title}\nТеперь просто пришли ссылку на стрим.`
      );
    }

    if (text.startsWith("/")) return;
    if (msg.chat.type !== "private") return;

    if (!text.startsWith("http://") && !text.startsWith("https://")) return;

    const cfg = streamerConfig[userId];
    if (!cfg || !cfg.channelId) {
      return bot.sendMessage(
        msg.chat.id,
        "Сначала подключи канал:\nПерешли мне любое сообщение из него."
      );
    }

    const embedUrl = getEmbedUrl(text);
    const thumb = await getThumbnail(text);

    await publishStreamPost(cfg.channelId, embedUrl, thumb, cfg.donateName);

    bot.sendMessage(msg.chat.id, "Готово! Пост опубликован в твоём канале.");
  } catch (err) {
    console.error("MESSAGE ERROR", err);
  }
});

// =====================================================
app.listen(PORT, () => console.log("SERVER RUNNING:", PORT));
