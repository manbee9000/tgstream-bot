import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";

const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;

// Память донатов
const donateNames = {};

const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

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

// Получаем превью Twitch канала
async function getTwitchThumbnail(url) {
  const name = url.split("/").pop();
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${name}-1280x720.jpg`;
}

// Получаем превью YouTube стрима
async function getYouTubeThumbnail(url) {
  let id = null;

  if (url.includes("watch?v=")) id = url.split("v=")[1].split("&")[0];
  if (url.includes("youtu.be/")) id = url.split("youtu.be/")[1].split("?")[0];

  return id ? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` : null;
}

// Определяем превью автоматически
async function getThumbnail(url) {
  if (url.includes("twitch.tv")) return getTwitchThumbnail(url);
  if (url.includes("youtu")) return getYouTubeThumbnail(url);
  return null; // для VK превью не используем
}

// ============= SEND STREAM POSTS =========

// Публикация
async function publishStreamPost(channelId, streamUrl, thumbnail, donateName) {
  // 1 — пост со стримом
  let inline_keyboard = [
    [
      {
        text: "🎥 Смотреть стрим",
        web_app: { url: `${RENDER_URL}/webapp?src=${encodeURIComponent(streamUrl)}` }
      }
    ]
  ];

  // Добавляем кнопку доната
  if (donateName) {
    inline_keyboard.push([
      {
        text: "💸 Донат",
        url: `https://www.donationalerts.com/r/${donateName}`
      }
    ]);
  }

  let messageText =
    "🔴 Не пропустите стрим!\n\n" +
    "🎥 Нажмите «Смотреть стрим», чтобы открыть трансляцию.\n" +
    "💬 Чат — в комментариях под постом ниже.\n" +
    "💸 Донат — через кнопку ниже.";

  // Если есть картинка — отправляем как фото
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

  // 2 — создаём пост для комментариев
  await bot.sendMessage(channelId, "💬 Чат стрима");
}

// =============== BOT HANDLERS ==============

// /donate xxxx
bot.onText(/\/donate (.+)/, (msg, match) => {
  const name = match[1].trim();
  donateNames[msg.chat.id] = name;

  bot.sendMessage(
    msg.chat.id,
    `Готово! Донат-страница настроена:\nhttps://www.donationalerts.com/r/${name}`
  );
});

// Простая проверка
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Отправь мне ссылку на стрим.");
});

// ОБРАБОТКА ЛЮБОГО СООБЩЕНИЯ
bot.on("message", async (msg) => {
  const text = msg.text;
  if (!text) return;

  // обрабатываем ссылки только в ЛИЧКЕ
  if (msg.chat.type !== "private") return;

  if (!text.startsWith("http://") && !text.startsWith("https://")) return;

  const streamUrl = text.trim();
  const channelId = msg.from.id; // Стример = владелец канала (персонально)

  try {
    const thumbnail = await getThumbnail(streamUrl);
    const donateName = donateNames[channelId] || null;

    await publishStreamPost(channelId, streamUrl, thumbnail, donateName);

    await bot.sendMessage(msg.chat.id, "Опубликовано!");
  } catch (err) {
    console.error("ERROR:", err);
    await bot.sendMessage(
      msg.chat.id,
      "Ошибка: я не могу отправить пост. Проверь, что я админ в канале."
    );
  }
});

// ---------------- START SERVER ----------------
app.listen(PORT, () => console.log("SERVER RUNNING", PORT));
