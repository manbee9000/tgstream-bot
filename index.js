import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";

const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

const app = express();
app.use(express.json());

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("BOT OK"));

// WebApp endpoint (iframe player)
app.get("/webapp", (req, res) => {
  const src = req.query.src || "";
  res.send(`
    <html>
      <body style="margin:0;padding:0;background:#000;height:100vh;display:flex;align-items:center;justify-content:center;">
        <iframe 
          src="${src}"
          style="border:0;width:100%;height:100%;"
          allowfullscreen
          allow="autoplay"
        ></iframe>
      </body>
    </html>
  `);
});

// ============================
// Донаты (имя DonationAlerts)
// ============================
const donateNames = {};

bot.onText(/\/donate (.+)/, (msg, match) => {
  const donateName = match[1].trim();
  donateNames[msg.chat.id] = donateName;

  bot.sendMessage(msg.chat.id, `Донаты настроены: https://www.donationalerts.com/r/${donateName}`);
});

// ============================
// Получение превью стрима
// ============================
async function getThumbnail(url) {
  if (url.includes("twitch.tv")) {
    return "https://static-cdn.jtvnw.net/ttv-static/404_preview-640x360.jpg";
  }

  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    const id = url.match(/v=([^&]+)/)?.[1] || url.split("/").pop();
    return `https://img.youtube.com/vi/${id}/maxresdefault.jpg`;
  }

  if (url.includes("vk.com")) {
    return "https://vk.com/images/camera_200.png";
  }

  return "https://via.placeholder.com/640x360?text=Stream";
}

// ============================
// Публикация двух постов
// ============================
const WEBAPP_URL = `${RENDER_URL}/webapp`;

async function publishStreamPost(chatId, streamUrl, thumbnailUrl, donateName) {
  const text =
`🔴 Не пропустите стрим!

🎥 Нажмите «Смотреть стрим», чтобы открыть трансляцию.
💬 Чат — в комментариях под постом ниже.
💸 Донат — через кнопку ниже.`;

  const buttons = [
    [
      {
        text: "🎥 Смотреть стрим",
        web_app: { url: `${WEBAPP_URL}?src=${encodeURIComponent(streamUrl)}` }
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

  // 1️⃣ пост с картинкой
  const msg1 = await bot.sendPhoto(chatId, thumbnailUrl, {
    caption: text,
    reply_markup: { inline_keyboard: buttons }
  });

  // 2️⃣ пост для комментариев
  await bot.sendMessage(chatId, "💬 Чат стрима", {
    reply_to_message_id: msg1.message_id
  });
}

// ============================
// Основной обработчик URL
// ============================
bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (msg.chat.type === "private" && msg.text.startsWith("http")) {
    const streamUrl = msg.text.trim();
    const chatId = msg.chat.id;

    // проверяем, что бот админ в канале
    try {
      const canPost = await bot.getChatMember(chatId, (await bot.getMe()).id);
      if (!["administrator", "creator"].includes(canPost.status)) {
        await bot.sendMessage(chatId, "Ошибка: я не админ в канале.");
        return;
      }
    } catch (err) {}

    try {
      const thumbnail = await getThumbnail(streamUrl);
      const donate = donateNames[chatId] || null;

      await publishStreamPost(chatId, streamUrl, thumbnail, donate);

      await bot.sendMessage(chatId, "Опубликовано!");
    } catch (e) {
      await bot.sendMessage(chatId, "Ошибка публикации. Проверь, что я админ.");
    }
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("SERVER RUNNING", PORT));
