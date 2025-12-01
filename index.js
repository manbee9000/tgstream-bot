import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import { MongoClient, ObjectId } from "mongodb";
import WebSocket from "ws";

// ================== CONFIG ==================
const TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_URL || process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;

const DA_DONATE_URL =
  process.env.DA_DONATE_URL || "https://dalink.to/mystreambot";

const ADMIN_TG_ID = 618072923;
const BOT_USERNAME = process.env.BOT_USERNAME; // ВАЖНО: БЕЗ @

// twitch parent domain
let PARENT_DOMAIN = "localhost";
try {
  if (RENDER_URL) PARENT_DOMAIN = new URL(RENDER_URL).host;
} catch {}

const app = express();
app.use(express.json());

// ================== TELEGRAM WEBHOOK ==================
if (!TOKEN) {
  console.error("BOT_TOKEN не задан");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_URL}/webhook/${TOKEN}`);

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================== STATIC WEBAPP ==================
app.use("/giveaway", express.static("webapp/giveaway"));

// ================== DB ==================
let db;
let usersCol;
let rafflesCol;

async function initMongo() {
  const mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  db = mongoClient.db();

  usersCol = db.collection("users");
  rafflesCol = db.collection("raffles");

  console.log("MongoDB connected");
}

// ================== HELPERS ==================
function buildMainMenu() {
  return {
    keyboard: [
      [
        { text: "🎁 Создать розыгрыш" },
        { text: "📋 Мои розыгрыши" }
      ],
      [
        { text: "📣 Мои каналы" },
        { text: "🎥 Отправить стрим" }
      ],
      [
        { text: "⭐ Поддержать бота" },
        { text: "💸 Подключить донат к стриму" }
      ],
      [{ text: "📘 Инструкция" }]
    ],
    resize_keyboard: true
  };
}

async function createDraftRaffle(ownerId, channel) {
  const doc = {
    ownerId,
    channelId: channel?.id || null,
    channelTitle: channel?.title || null,
    channelUsername: channel?.username || null,
    text: null,
    imageFileId: null,
    requiredSubs: [],
    endAt: null,
    participants: [],
    status: "draft",
    createdAt: new Date()
  };
  const res = await rafflesCol.insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

async function updateRaffle(id, update) {
  await rafflesCol.updateOne({ _id: new ObjectId(id) }, { $set: update });
}

async function getRaffle(id) {
  return rafflesCol.findOne({ _id: new ObjectId(id) });
}

async function addParticipantDisplay(id, display) {
  await rafflesCol.updateOne(
    { _id: new ObjectId(id) },
    { $addToSet: { participants: display } }
  );
}

// =============== ПУБЛИКАЦИЯ ПОСТА — ПОЧИНЕНО ===============
async function publishRafflePost(raffle) {
  const channelId = raffle.channelId;
  if (!channelId) throw new Error("Нет channelId");

  // deep-link → бот открывается и вызывает /start raffle_<id>
  const deepLink = `https://t.me/${BOT_USERNAME}?start=raffle_${raffle._id}`;

  const caption =
    "🎁 *Розыгрыш*\n\n" +
    (raffle.text ? raffle.text + "\n\n" : "") +
    "Чтобы участвовать, нажмите кнопку ниже.\n" +
    "Бот откроется автоматически.";

  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: "🎉 Участвовать",
          url: deepLink // <--- ТОЛЬКО URL, без web_app
        }
      ]
    ]
  };

  try {
    if (raffle.imageFileId) {
      await bot.sendPhoto(channelId, raffle.imageFileId, {
        caption,
        parse_mode: "Markdown",
        reply_markup
      });
    } else {
      await bot.sendMessage(channelId, caption, {
        parse_mode: "Markdown",
        reply_markup
      });
    }
    console.log("Розыгрыш опубликован в канал");
  } catch (err) {
    console.error("Ошибка публикации:", err);
    throw err;
  }
}

// ================== STATE ==================
const userState = {};

// ================== MESSAGE HANDLER ==================
bot.on("message", async (msg) => {
  try {
    if (!msg.from || !msg.chat) return;

    const uid = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text || "";
    const isPrivate = msg.chat.type === "private";

    // ======== /start + deep-link ========
    if (text.startsWith("/start")) {
      const payload = text.split(" ").slice(1).join(" ").trim();

      userState[uid] = {};

      // ================= /start raffle_<id> ==================
      if (payload.startsWith("raffle_")) {
        const raffleId = payload.replace("raffle_", "");
        const raffle = await getRaffle(raffleId);

        if (!raffle || raffle.status !== "active") {
          await bot.sendMessage(chatId, "Этот розыгрыш недоступен.");
          return;
        }

        await bot.sendMessage(
          chatId,
          "🎁 Розыгрыш открыт!\nНажмите кнопку ниже:",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🎉 Участвовать",
                    web_app: {
                      url: `${RENDER_URL}/giveaway/?id=${raffleId}`
                    }
                  }
                ]
              ]
            }
          }
        );

        return;
      }

      // обычный старт
      await bot.sendMessage(
        chatId,
        "👋 Привет! Выберите действие:",
        { reply_markup: buildMainMenu() }
      );

      return;
    }

    // ================= PRIVATE ONLY ==================
    if (!isPrivate) return;
    
    const state = userState[uid] || {};
    // ================ СОЗДАНИЕ РОЗЫГРЫША ================
    if (text === "🎁 Создать розыгрыш") {
      const user = await usersCol.findOne({ tgId: uid });
      const channels = user?.channels || [];

      if (!channels.length) {
        await bot.sendMessage(
          chatId,
          "❌ Не подключён ни один канал.\nПерейдите в «📣 Мои каналы» и перешлите любое сообщение из канала."
        );
        return;
      }

      const channel = channels[0];
      const draft = await createDraftRaffle(uid, channel);

      userState[uid] = {
        mode: "raffle",
        step: "wait_text",
        draftId: draft._id.toString()
      };

      await bot.sendMessage(
        chatId,
        "✏️ Пришлите текст розыгрыша.\nМожно приложить *одно* фото.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (state.mode === "raffle") {
      const draftId = state.draftId;

      // ===== ШАГ 1: текст / фото =====
      if (state.step === "wait_text") {
        if (msg.photo?.length) {
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          await updateRaffle(draftId, { imageFileId: fileId });
        }

        if (msg.caption) {
          await updateRaffle(draftId, { text: msg.caption });
        } else if (text.trim()) {
          await updateRaffle(draftId, { text: text.trim() });
        }

        userState[uid].step = "wait_subs";

        await bot.sendMessage(
          chatId,
          "📌 Теперь отправьте список обязательных подписок:\n\n@channel1 @channel2\n\nЕсли подписок *нет* — напишите: нет",
          { parse_mode: "Markdown" }
        );
        return;
      }

      // ===== ШАГ 2: обязательные подписки =====
      if (state.step === "wait_subs") {
        let required = [];

        if (text.trim().toLowerCase() !== "нет") {
          required = text
            .split(/\s+/)
            .map((x) => x.trim())
            .filter((x) => x.startsWith("@"));
        }

        await updateRaffle(draftId, { requiredSubs: required });
        userState[uid].step = "wait_end";

        await bot.sendMessage(
          chatId,
          "⏳ Укажите дату и время окончания.\nФормат: *дд.мм.гггг чч:мм*\nНапример: 01.12.2025 18:00",
          { parse_mode: "Markdown" }
        );
        return;
      }

      // ===== ШАГ 3: дата окончания =====
      if (state.step === "wait_end") {
        const m = text.match(
          /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/
        );

        if (!m) {
          await bot.sendMessage(chatId, "❌ Неверный формат. Пример: 01.12.2025 18:00");
          return;
        }

        const endAt = new Date(+m[3], m[2] - 1, +m[1], +m[4], +m[5], 0);
        await updateRaffle(draftId, { endAt, status: "active" });

        const raffle = await getRaffle(draftId);

        try {
          await publishRafflePost(raffle);
          await bot.sendMessage(chatId, "✅ Розыгрыш опубликован!", {
            reply_markup: buildMainMenu()
          });
        } catch (e) {
          await bot.sendMessage(
            chatId,
            "❌ Не удалось опубликовать. Проверьте, что бот — админ канала.",
            { reply_markup: buildMainMenu() }
          );
        }

        userState[uid] = {};
        return;
      }
    }

    // ================ ПОДКЛЮЧЕНИЕ КАНАЛА ================
    if (text === "📣 Мои каналы") {
      await bot.sendMessage(
        chatId,
        "Перешлите любое сообщение из канала, который хотите подключить."
      );
      userState[uid] = { mode: "connect_channel" };
      return;
    }

    if (state.mode === "connect_channel" && msg.forward_from_chat) {
      const ch = msg.forward_from_chat;

      await usersCol.updateOne(
        { tgId: uid },
        {
          $addToSet: {
            channels: {
              id: ch.id,
              title: ch.title || "",
              username: ch.username || null
            }
          }
        },
        { upsert: true }
      );

      userState[uid] = {};
      await bot.sendMessage(chatId, `Канал подключён: ${ch.title}`, {
        reply_markup: buildMainMenu()
      });
      return;
    }

    // ================ ПРОЧЕЕ ================
    if (text === "⭐ Поддержать бота") {
      await bot.sendMessage(chatId, `Спасибо ❤️\n${DA_DONATE_URL}`);
      return;
    }

    if (text === "📘 Инструкция") {
      await bot.sendMessage(
        chatId,
        "📘 Инструкция:\n\n• Подключите канал\n• Создайте розыгрыш\n• Участвуйте через мини-приложение",
        { reply_markup: buildMainMenu() }
      );
      return;
    }

  } catch (err) {
    console.error("message error:", err);
  }
});

// ================== API для mini-app ==================
app.get("/api/raffle", async (req, res) => {
  try {
    const raffle = await getRaffle(req.query.id);
    if (!raffle) return res.json({ ok: false });

    res.json({
      ok: true,
      participants: raffle.participants || [],
      endAt: raffle.endAt,
      title: raffle.text || ""
    });
  } catch {
    res.json({ ok: false });
  }
});

app.get("/api/join", async (req, res) => {
  try {
    const id = req.query.id;
    const userId = parseInt(req.query.userId, 10);
    const username = req.query.username || "";

    const raffle = await getRaffle(id);
    if (!raffle || raffle.status !== "active") {
      return res.json({ ok: false, error: "ENDED" });
    }

    // Проверка подписки на основной канал
    const notSubs = [];

    try {
      const m = await bot.getChatMember(raffle.channelId, userId);
      if (["left", "kicked"].includes(m.status)) notSubs.push(raffle.channelUsername || "канал розыгрыша");
    } catch {
      notSubs.push(raffle.channelUsername || "канал розыгрыша");
    }

    // Проверка дополнительных подписок
    for (const ch of raffle.requiredSubs) {
      try {
        const m = await bot.getChatMember(ch, userId);
        if (["left", "kicked"].includes(m.status)) notSubs.push(ch);
      } catch {
        notSubs.push(ch);
      }
    }

    if (notSubs.length) {
      return res.json({
        ok: false,
        error: "NOT_SUBSCRIBED",
        notSubs
      });
    }

    const display = username ? `@${username}` : `id:${userId}`;
    await addParticipantDisplay(id, display);

    res.json({ ok: true });

  } catch (e) {
    res.json({ ok: false });
  }
});

// ================== START ==================
async function start() {
  await initMongo();
  app.listen(PORT, () => console.log("SERVER RUNNING ON PORT", PORT));
}

start().catch(console.error);
