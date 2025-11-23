import express from "express";
import TelegramBot from "node-telegram-bot-api";

// ========== CONFIG ==========
const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;

// Определяем parent-домен (для Twitch)
let PARENT_DOMAIN = "localhost";
try {
  if (RENDER_URL) {
    PARENT_DOMAIN = new URL(RENDER_URL).host;
  }
} catch (e) {
    console.error("Ошибка парсинга RENDER_URL:", e);
}

// ========================================
const app = express();
app.use(express.json());

if (!TOKEN) {
  console.error("Ошибка: BOT_TOKEN не задан!");
  process.exit(1);
}
if (!RENDER_URL) {
  console.error("Ошибка: RENDER_EXTERNAL_URL не задан!");
}

// Telegram Webhook
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// =====================================================================
// WEBAPP (встраиваемый iframe)
// =====================================================================
app.get("/webapp", (req, res) => {
  const src = req.query.src || "";
  res.send(`
    <html>
      <body style="margin:0;background:#000">
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

// =====================================================================
// HELPERS — извлечение ID / превью
// =====================================================================

// YouTube ID
function extractYouTubeId(url) {
  try {
    if (url.includes("watch?v=")) return url.split("v=")[1].split("&")[0];
    if (url.includes("youtu.be/")) return url.split("youtu.be/")[1].split("?")[0];
  } catch {}
  return null;
}

// Mini-thumbnail resolver
async function getThumbnail(url) {
  // Twitch
  if (url.includes("twitch.tv")) {
    try {
      const name = url.split("/").pop().split("?")[0];
      return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${name}-1280x720.jpg`;
    } catch {
      return null;
    }
  }

  // YouTube
  if (url.includes("youtu")) {
    const id = extractYouTubeId(url);
    if (!id) return null;
    return `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  }

  // VK video (thumbnail Telegram сам создаст)
  if (url.includes("vk.com/video")) {
    return null;
  }

  return null;
}

// =====================================================================
// EMBED URL BUILDER (Twitch, YouTube, VK)
// =====================================================================
function getEmbed(url) {
  // Twitch
  if (url.includes("twitch.tv")) {
    try {
      const name = url.split("/").pop().split("?")[0];
      return `https://player.twitch.tv/?channel=${name}&parent=${PARENT_DOMAIN}`;
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

  // VK
  if (url.includes("vk.com/video")) {
    try {
      const raw = url.split("video")[1]; // -123_456
      const [oid, vid] = raw.split("_");
      return `https://vk.com/video_ext.php?oid=${oid}&id=${vid}&hd=1`;
    } catch {
      return url;
    }
  }

  return url;
}

// =====================================================================
// ПУБЛИКАЦИЯ СТРИМА В КАНАЛ
// =====================================================================
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
    "💬 Чат находится в комментариях под постом.\n" +
    "💸 Донат — через соответствующую кнопку ниже.";

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

  // публикуем чат
  await bot.sendMessage(channelId, "💬 Чат стрима");
}

// =====================================================================
// КОМАНДЫ
// =====================================================================
const streamerConfig = {};

// команда /donate
bot.onText(/\/donate (.+)/, (msg, match) => {
  const userId = msg.from.id;
  streamerConfig[userId] = streamerConfig[userId] || {};
  streamerConfig[userId].donateName = match[1];

  bot.sendMessage(
    msg.chat.id,
    `Донат успешно подключён:\nhttps://www.donationalerts.com/r/${match[1]}`
  );
});

// команда /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Добро пожаловать!\n\n" +
      "Чтобы подключить Ваш канал:\n" +
      "1. Добавьте бота в администраторы канала.\n" +
      "2. Отправьте любое сообщение в канале.\n" +
      "3. Перешлите это сообщение сюда, в бот.\n\n" +
      "После подключения Вы сможете отправлять ссылки на трансляции."
  );
});

// =====================================================================
// ОСНОВНОЙ ОБРАБОТЧИК СООБЩЕНИЙ
// =====================================================================
bot.on("message", async (msg) => {
  try {
    const text = msg.text || "";
    const userId = msg.from.id;

    // Подключение канала
    if (msg.forward_from_chat && msg.forward_from_chat.type === "channel") {
      streamerConfig[userId] = streamerConfig[userId] || {};
      streamerConfig[userId].channelId = msg.forward_from_chat.id;

      return bot.sendMessage(
        msg.chat.id,
        `Канал успешно подключён: ${msg.forward_from_chat.title}\n\n` +
        "Теперь Вы можете отправить ссылку на стрим."
      );
    }

    // игнорируем команды
    if (text.startsWith("/")) return;

    // обрабатываем только ссылки
    if (!text.startsWith("http")) return;

    // проверяем подключение канала
    if (!streamerConfig[userId] || !streamerConfig[userId].channelId) {
      return bot.sendMessage(
        msg.chat.id,
        "Перед публикацией стрима необходимо подключить Ваш канал.\n\n" +
          "Пожалуйста, выполните следующие шаги:\n" +
          "1. Добавьте бота администраторами Вашего канала.\n" +
          "2. Отправьте любое сообщение в канале.\n" +
          "3. Перешлите это сообщение сюда.\n\n" +
          "После подключения Вы сможете размещать ссылки на трансляции."
      );
    }

    // формируем embed и thumbnail
    const embed = getEmbed(text);
    const thumb = await getThumbnail(text);

    // публикуем пост
    await publishStreamPost(
      streamerConfig[userId].channelId,
      embed,
      thumb,
      streamerConfig[userId].donateName
    );

    bot.sendMessage(msg.chat.id, "Готово! Публикация успешно размещена.");
  } catch (err) {
    console.error("MESSAGE ERROR:", err);
  }
});

// =====================================================================
app.listen(PORT, () => console.log("SERVER RUNNING ON PORT", PORT));
