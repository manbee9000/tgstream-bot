import express from "express";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL;

const app = express();
app.use(express.json());

// Webhook bot
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${PUBLIC_URL}/webhook/${TOKEN}`);

// Загрузка донат-ссылок
let donateLinks = {};
try {
  if (fs.existsSync("data.json")) {
    donateLinks = JSON.parse(fs.readFileSync("data.json"));
  }
} catch (e) {
  console.error("Ошибка чтения data.json", e);
}

// Функция сохранения в файл
function saveDonateLinks() {
  fs.writeFileSync("data.json", JSON.stringify(donateLinks, null, 2));
}

// Webhook endpoint
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health check
app.get("/", (req, res) => res.send("BOT ONLINE OK"));

// ====== ОБРАБОТКА КОМАНД ======

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Привет! Отправь ссылку на стрим, и я опубликую её в канале.\n\n" +
      "Для настройки DonationAlerts используй:\n" +
      "`/donate https://donationalerts.com/r/имя`",
    { parse_mode: "Markdown" }
  );
});

// /donate <url>
bot.onText(/\/donate (.+)/, (msg, match) => {
  const userId = msg.from.id;
  const url = match[1].trim();

  if (!url.startsWith("http")) {
    bot.sendMessage(msg.chat.id, "Некорректная ссылка.");
    return;
  }

  donateLinks[userId] = url;
  saveDonateLinks();

  bot.sendMessage(msg.chat.id, "Ссылка DonationAlerts сохранена!");
});

// ====== ОБРАБОТКА ЛЮБОГО СООБЩЕНИЯ СО ССЫЛКОЙ ======
bot.on("message", async (msg) => {
  try {
    console.log("INCOMING:", msg.text);

    // пропускаем канал
    if (msg.chat.type === "channel") return;

    const text = msg.text?.trim();
    if (!text) return;

    // ссылка?
    if (!(text.startsWith("http://") || text.startsWith("https://"))) return;

    const userId = msg.from.id;
    const streamUrl = encodeURIComponent(text);

    // ссылка DonationAlerts?
    const donateUrl = donateLinks[userId]
      ? donateLinks[userId]
      : "https://donationalerts.com";

    const watchUrl = `${PUBLIC_URL}/webapp?src=${streamUrl}`;

    // КНОПКИ
    const buttons = {
      inline_keyboard: [
        [
          {
            text: "🎥 Смотреть стрим",
            web_app: { url: watchUrl }
          }
        ],
        [
          {
            text: "💰 Donat",
            url: donateUrl
          }
        ]
      ]
    };

    // Постим в канал
    await bot.sendMessage(CHANNEL_ID, "🔴 Стрим сейчас!", {
      reply_markup: buttons
    });

    bot.sendMessage(msg.chat.id, "Готово! Стрим опубликован.");

  } catch (err) {
    console.error("ERROR:", err);
    bot.sendMessage(
      msg.chat.id,
      "Ошибка: не могу отправить сообщение в канал. Проверь, что я админ."
    );
  }
});

// ====== WEBAPP ======
app.get("/webapp", (req, res) => {
  const src = req.query.src;
  if (!src) {
    return res.send("<h2>Ссылка не передана</h2>");
  }

  res.send(`
    <html>
      <body style="margin:0; padding:0; background:#000;">
        <iframe 
          src="${src}"
          style="border:0; width:100vw; height:100vh;"
          allow="autoplay; encrypted-media; fullscreen"
          allowfullscreen>
        </iframe>
      </body>
    </html>
  `);
});

// Запуск
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("SERVER RUNNING", PORT));
