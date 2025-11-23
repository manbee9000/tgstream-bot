import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

const app = express();
app.use(express.json());

// Создаём бота в режиме webhook
const bot = new TelegramBot(TOKEN, { webHook: true });

// Устанавливаем webhook
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);
console.log("Webhook set:", `${RENDER_URL}/webhook/${TOKEN}`);

// Принимаем обновления от Telegram
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Проверка, что сервер жив
app.get("/", (req, res) => {
  res.send("BOT OK");
});

// Логируем все входящие сообщения
bot.on("message", (msg) => {
  console.log("INCOMING MESSAGE:", JSON.stringify(msg, null, 2));
});

// Команда /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Бот работает. Пришли ссылку на стрим.");
});

// Основная логика: принимаем ссылку, постим в канал
bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (msg.chat.type === "channel") return;

  const text = msg.text.trim();

  // только ссылки
  if (!text.startsWith("http://") && !text.startsWith("https://")) return;

  // ссылка на наш webapp
  const webAppUrl = `${RENDER_URL}/webapp?src=${encodeURIComponent(text)}`;

  try {
    // постим в канал
    await bot.sendMessage(CHANNEL_ID, "🔴 Стрим сейчас!", {
      reply_markup: {
        inline_keyboard: [[
          {
            text: "🎥 Смотреть стрим",
            url: webAppUrl  // в канале можно только url-кнопки
          }
        ]]
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

// Страница webapp: встраиваем стрим внутрь iframe
app.get("/webapp", (req, res) => {
  const streamUrl = req.query.src || "";

  // Жёстко прописываем домен для Twitch parent-параметра
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
          // twitch embed: https://player.twitch.tv/?channel=CHANNEL&parent=DOMAIN
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
          // YouTube embed
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

// Запускаем сервер
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("SERVER RUNNING", PORT);
});
