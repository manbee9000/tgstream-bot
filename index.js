import express from "express";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

const app = express();
app.use(express.json());

const DATA_FILE = "./data.json";

// ===== Работа с файлом данных =====
function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

let DB = loadDB(); // структура: { [userId]: { channelId, donateName } }

// ===== Инициализация бота с webhook =====
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`, {
  allowed_updates: ["message", "channel_post"]
});

// Webhook endpoint
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Healthcheck
app.get("/", (req, res) => {
  res.send("TGSTREAM BOT IS RUNNING");
});

// ===== /start =====
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "👋 Привет! Я бот для стримеров.\n\n" +
      "1️⃣ Добавь меня админом в свой канал.\n" +
      "2️⃣ Перешли мне ЛЮБОЕ сообщение из этого канала — я запомню его.\n" +
      "3️⃣ Настрой донаты: `/donate ИМЯ_НА_DONATIONALERTS`.\n" +
      "4️⃣ Потом просто отправляй мне ссылку на стрим — я сделаю пост в твоём канале.",
    { parse_mode: "Markdown" }
  );
});

// ===== /donate ИМЯ =====
bot.onText(/\/donate (.+)/, (msg, match) => {
  const userId = msg.chat.id;
  const donateName = match[1].trim();

  if (!donateName) {
    bot.sendMessage(
      userId,
      "❗ Укажи имя DonationAlerts.\nПример: `/donate myusername`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (!DB[userId]) DB[userId] = {};
  DB[userId].donateName = donateName;
  saveDB(DB);

  bot.sendMessage(
    userId,
    `🎉 Готово!\nТеперь донаты будут идти на:\nhttps://www.donationalerts.com/r/${donateName}`
  );
});

// ===== /donate (без аргументов) — показать текущий =====
bot.onText(/\/donate$/, (msg) => {
  const userId = msg.chat.id;
  const userData = DB[userId];

  if (userData?.donateName) {
    bot.sendMessage(
      userId,
      `💁‍♂️ Твой DonationAlerts сейчас:\nhttps://www.donationalerts.com/r/${userData.donateName}\n\nЧтобы изменить:\n/donate НОВОЕ_ИМЯ`
    );
  } else {
    bot.sendMessage(
      userId,
      "Ты ещё не настроил DonationAlerts.\nОтправь:\n`/donate ИМЯ_НА_DONATIONALERTS`",
      { parse_mode: "Markdown" }
    );
  }
});

// ===== Обработка всех сообщений =====
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text || "";

    // 1) Если это пересланное сообщение из КАНАЛА — запоминаем канал
    if (
      msg.forward_from_chat &&
      msg.forward_from_chat.type === "channel" &&
      msg.chat.type === "private"
    ) {
      const channelId = msg.forward_from_chat.id;

      if (!DB[chatId]) DB[chatId] = {};
      DB[chatId].channelId = channelId;
      saveDB(DB);

      await bot.sendMessage(
        chatId,
        "✅ Я запомнил этот канал как твой.\nТеперь просто присылай мне ссылки на стрим — я буду постить туда."
      );
      return;
    }

    // 2) Остальное: работаем только с приватным чатом и ссылками
    if (msg.chat.type !== "private") return;

    const trimmed = text.trim();
    if (!trimmed) return;

    const isUrl =
      trimmed.startsWith("http://") || trimmed.startsWith("https://");
    if (!isUrl) return;

    const userData = DB[chatId];

    if (!userData?.channelId) {
      await bot.sendMessage(
        chatId,
        "❗ Я не знаю, в какой канал постить.\n\n" +
          "Сделай так:\n" +
          "1) Добавь меня админом в свой канал.\n" +
          "2) Перешли мне ЛЮБОЕ сообщение из этого канала.\n" +
          "После этого снова пришли ссылку на стрим."
      );
      return;
    }

    const channelId = userData.channelId;
    const donateName = userData.donateName;

    const streamUrl = trimmed;
    const encodedStreamUrl = encodeURIComponent(streamUrl);

    const watchUrl = `${RENDER_URL}/webapp?src=${encodedStreamUrl}`;

    const postText =
      "🔴 Стрим сейчас!\n\n" +
      "🎥 Нажми «Смотреть стрим», чтобы открыть трансляцию.\n" +
      "💬 Чат — в комментариях под этим постом.\n";

    // Кнопки
    const inline_keyboard = [
      [
        {
          text: "🎬 Смотреть стрим",
          url: watchUrl
        }
      ]
    ];

    if (donateName) {
      inline_keyboard.push([
        {
          text: "💰 Донат",
          url: `https://www.donationalerts.com/r/${donateName}`
        }
      ]);
    } else {
      // если донат не настроен — можно подсказать
      inline_keyboard.push([
        {
          text: "💰 Настроить донаты",
          url: "https://www.donationalerts.com/"
        }
      ]);
    }

    // Публикуем пост в КАНАЛ
    await bot.sendMessage(channelId, postText, {
      reply_markup: { inline_keyboard }
    });

    await bot.sendMessage(chatId, "✅ Стрим опубликован в твоём канале.");

  } catch (err) {
    console.error("ERROR in message handler:", err);
  }
});

// ===== WebApp со стримом (Twitch / YouTube / другие) =====
app.get("/webapp", (req, res) => {
  const streamUrl = req.query.src || "";
  const PARENT_DOMAIN = "tgstream-bot.onrender.com"; // домен Render

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
      background: #000;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    }
    #player {
      width: 100%;
      height: 100%;
      border: none;
      background: #000;
    }
    #message {
      color: #fff;
      text-align: center;
      margin-top: 40vh;
      font-size: 18px;
    }
  </style>
</head>
<body>
  <div id="message" style="display:none;"></div>
  <iframe id="player" allowfullscreen></iframe>

  <script>
    const rawSrc = ${JSON.stringify(streamUrl)};
    const msgEl = document.getElementById('message');
    const iframe = document.getElementById('player');

    if (!rawSrc) {
      msgEl.style.display = 'block';
      msgEl.innerText = 'Нет ссылки на стрим';
    } else {
      try {
        const src = decodeURIComponent(rawSrc);
        let embedUrl = src;

        if (src.includes('twitch.tv')) {
          try {
            const u = new URL(src);
            const parts = u.pathname.split('/').filter(Boolean);
            const channel = parts[0] || '';
            if (channel) {
              embedUrl = 'https://player.twitch.tv/?channel='
                + encodeURIComponent(channel)
                + '&parent=${PARENT_DOMAIN}';
            }
          } catch (e) {
            embedUrl = src;
          }
        } else if (src.includes('youtube.com') || src.includes('youtu.be')) {
          let videoId = '';
          if (src.includes('watch?v=')) {
            const u = new URL(src);
            videoId = u.searchParams.get('v') || '';
          } else if (src.includes('youtu.be/')) {
            const u = new URL(src);
            const parts = u.pathname.split('/').filter(Boolean);
            videoId = parts[0] || '';
          }
          if (videoId) {
            embedUrl = 'https://www.youtube.com/embed/' + videoId;
          }
        }

        iframe.src = embedUrl;
      } catch (e) {
        msgEl.style.display = 'block';
        msgEl.innerText = 'Ошибка загрузки стрима';
      }
    }
  </script>
</body>
</html>`);
});

// ===== Запуск сервера =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("SERVER RUNNING", PORT);
});
