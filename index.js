import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;

// вычисляем parent-домен (для Twitch)
let PARENT_DOMAIN = "localhost";
try {
  if (RENDER_URL) PARENT_DOMAIN = new URL(RENDER_URL).host;
} catch (e) {
  console.error("PARENT_DOMAIN ERROR:", e);
}

const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN, { webHook: true });

// ВАЖНО: webhook устанавливаем после инициализации
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ======================================
// WEBAPP (iframe)
// ======================================
app.get("/webapp", (req, res) => {
  const src = req.query.src || "";
  res.send(`
    <html><body style="margin:0;background:#000">
      <iframe src="${src}" allowfullscreen allow="autoplay" style="width:100%;height:100%;border:0;"></iframe>
    </body></html>
  `);
});

// ======================================
// HELPERS
// ======================================

function extractYouTubeId(url) {
  if (url.includes("watch?v=")) return url.split("v=")[1].split("&")[0];
  if (url.includes("youtu.be/")) return url.split("youtu.be/")[1].split("?")[0];
  return null;
}

async function getThumbnail(url) {
  if (url.includes("twitch.tv")) {
    const name = url.split("/").pop().split("?")[0];
    return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${name}-1280x720.jpg`;
  }

  if (url.includes("youtu")) {
    const id = extractYouTubeId(url);
    if (!id) return null;
    return `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  }

  if (url.includes("vk.com/video")) {
    return null; // VK без API — оставим без thumbnail
  }

  return null;
}

function getEmbed(url) {
  if (url.includes("twitch.tv")) {
    const ch = url.split("/").pop().split("?")[0];
    return `https://player.twitch.tv/?channel=${ch}&parent=${PARENT_DOMAIN}`;
  }

  if (url.includes("youtu")) {
    const id = extractYouTubeId(url);
    return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
  }

  if (url.includes("vk.com/video")) {
    const raw = url.split("video")[1];
    const [oid, id] = raw.split("_");
    return `https://vk.com/video_ext.php?oid=${oid}&id=${id}&hd=1`;
  }

  return url;
}

// ======================================
// STREAM POST
// ======================================
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

// ======================================
// COMMANDS
// ======================================
const streamerConfig = {};

bot.onText(/\/donate (.+)/, (msg, match) => {
  const userId = msg.from.id;
  streamerConfig[userId] = streamerConfig[userId] || {};
  streamerConfig[userId].donateName = match[1];

  bot.sendMessage(msg.chat.id, `Донат подключён: https://www.donationalerts.com/r/${match[1]}`);
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Привет! Чтобы подключить канал:\n1️⃣ Добавь меня админом.\n2️⃣ Напиши там сообщение.\n3️⃣ Перешли его мне."
  );
});

// ======================================
// MAIN MESSAGE HANDLER
// ======================================
bot.on("message", async (msg) => {
  const text = msg.text || "";
  const userId = msg.from.id;

  // подключение канала
  if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
    streamerConfig[userId] = streamerConfig[userId] || {};
    streamerConfig[userId].channelId = msg.forward_from_chat.id;

    return bot.sendMessage(
      msg.chat.id,
      `Канал подключён: ${msg.forward_from_chat.title}\nТеперь пришли ссылку.`
    );
  }

  // игнор команд
  if (text.startsWith("/")) return;

  // только ссылки
  if (!text.startsWith("http")) return;

  if (!streamerConfig[userId] || !streamerConfig[userId].channelId) {
    return bot.sendMessage(msg.chat.id, "Сначала подключи канал.");
  }

  const embed = getEmbed(text);
  const thumb = await getThumbnail(text);

  await publishStreamPost(streamerConfig[userId].channelId, embed, thumb, streamerConfig[userId].donateName);

  bot.sendMessage(msg.chat.id, "Готово!");
});

// ======================================
app.listen(PORT, () => console.log("SERVER RUNNING:", PORT));
