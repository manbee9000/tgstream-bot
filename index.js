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

// Хранилище настроек стримера
const streamerConfig = {}; // { userId: { channelId, donateName } }

// ---------------- WEBHOOK ----------------
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => res.send("BOT OK"));

// --------------- WEBAPP PAGE -------------
app.get("/webapp", (req, res) => {
  const src = req.query.src || "";
  res.send(`
    <html>
      <body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;">
        <iframe src="${src}" allowfullscreen style="width:100%;height:100%;border:0;"></iframe>
      </body>
    </html>
  `);
});

// ============ UTILS: THUMBNAILS ==========
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

// ============= SEND STREAM POSTS =========
async function publishStreamPost(channelId, streamUrl, thumbnail, donateName) {
  let inline_keyboard = [
    [
      {
        text: "🎥 Смотреть стрим",
        web_app: { url: `${RENDER_URL}/webapp?src=${encodeURIComponent(streamUrl)}` }
      }
    ]
  ];

  if (donateName) {
    inline_keyboard.push([
      {
        text: "💸 Донат",
        url: `https://www.donationalerts.com/r/${donateName}`
      }
    ]);
  }

  const messageText =
    "🔴 Не пропустите стрим!\n\n" +
    "🎥 Нажмите «Смотреть стрим».\n" +
    "💬 Чат — в комментариях под постом ниже.\n" +
    "💸 Донат — через кнопку ниже.";

  if (thumbnail) {
    await bot.sendPhoto(channelId, thumbnail, {
      caption: messageText,
      reply_markup: { inline_keyboard }
    });
  } else {
    await bot.sendMessage(channelId, messageText, {
      reply_markup: { inline_keyboard }
    });
  }

  await bot.sendMessage(channelId, "💬 Чат стрима");
}

// =============== COMMANDS =================

// /setchannel @name
bot.onText(/\/setchannel (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  let channel = match[1].trim();

  // Если юзер указал "@test" — нужно получить ID канала
  if (channel.startsWith("@")) {
    try {
      const chat = await bot.getChat(channel);
      channel = chat.id;
    } catch {
      return bot.sendMessage(msg.chat.id, "Не смог найти канал. Проверь @username.");
    }
  }

  streamerConfig[userId] = streamerConfig[userId] || {};
  streamerConfig[userId].channelId = Number(channel);

  bot.sendMessage(msg.chat.id, `Готово! Посты теперь будут публиковаться в канал: ${channel}`);
});

// /donate имя
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
    "Привет! Перед стримом выполни настройки:\n\n" +
      "1️⃣ Укажи свой канал:\n/setchannel @имя_канала\n\n" +
      "2️⃣ (Необязательно) Укажи донат:\n/donate имя\n\n" +
      "После этого просто отправляй ссылку на стрим!"
  );
});

// ------------ STREAM LINK HANDLER ----------

bot.on("message", async (msg) => {
  const text = msg.text;
  if (!text) return;
  if (msg.chat.type !== "private") return;

  // команды не трогаем
  if (text.startsWith("/")) return;

  // должна быть ссылка
  if (!text.startsWith("http://") && !text.startsWith("https://")) return;

  const userId = msg.from.id;
  const cfg = streamerConfig[userId];

  if (!cfg || !cfg.channelId) {
    return bot.sendMessage(
      msg.chat.id,
      "Сначала настрой канал:\n/setchannel @имя_канала"
    );
  }

  const streamUrl = text.trim();

  try {
    const thumb = await getThumbnail(streamUrl);
    const donateName = cfg.donateName || null;

    await publishStreamPost(cfg.channelId, streamUrl, thumb, donateName);

    bot.sendMessage(msg.chat.id, "Готово! Пост опубликован в твоём канале.");
  } catch (err) {
    console.error("STREAM POST ERROR:", err);
    bot.sendMessage(msg.chat.id, "Ошибка. Проверь, что я админ в твоём канале.");
  }
});

// ---------------- SERVER ----------------
app.listen(PORT, () => console.log("SERVER RUNNING", PORT));
