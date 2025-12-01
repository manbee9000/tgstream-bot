// ============================================================
// Получение параметров
// ============================================================
const params = new URLSearchParams(window.location.search);
const raffleId = params.get("id");

// Элементы UI
const list = document.getElementById("nickname-list");
const timerValue = document.getElementById("timer-value");
const joinBtn = document.getElementById("join-btn");

// ============================================================
// Telegram WebApp INIT
// ============================================================
let tg = window.Telegram?.WebApp || null;
let tgUser = null;

function initTelegram() {
  if (!tg) return;

  try {
    tg.expand();
    tg.ready();

    // Данные пользователя
    if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
      tgUser = tg.initDataUnsafe.user;
    }
  } catch (e) {
    console.warn("TG init error:", e);
  }
}

// Инициализация с задержкой (Telegram иногда отдает данные не сразу)
setTimeout(initTelegram, 30);

// ============================================================
// Участники + время
// ============================================================
let participants = [];
let endAt = null;
let myNickKey = null;

// ============================================================
// Рендер списка
// ============================================================
function renderList() {
  list.innerHTML = "";

  const arr = participants.length ? participants : ["Пока нет участников"];
  arr.forEach((nick) => {
    const item = document.createElement("div");
    item.className = "nickname";
    item.textContent = nick;
    list.appendChild(item);
  });
}

// ============================================================
// Таймер обратного отсчёта
// ============================================================
function updateTimer() {
  if (!endAt) return;

  const now = new Date();
  let diff = Math.floor((endAt.getTime() - now.getTime()) / 1000);

  if (diff <= 0) {
    timerValue.textContent = "00:00:00";
    joinBtn.disabled = true;
    if (!joinBtn.textContent.startsWith("✅")) {
      joinBtn.textContent = "Розыгрыш завершён";
    }
    return;
  }

  const h = String(Math.floor(diff / 3600)).padStart(2, "0");
  diff %= 3600;
  const m = String(Math.floor(diff / 60)).padStart(2, "0");
  const s = String(diff % 60).padStart(2, "0");

  timerValue.textContent = `${h}:${m}:${s}`;
}

setInterval(updateTimer, 1000);

// ============================================================
// Бесконечная прокрутка
// ============================================================
let position = 0;
const ITEM_HEIGHT = 48;

function animate() {
  if (!list.firstElementChild) {
    requestAnimationFrame(animate);
    return;
  }

  position -= 0.7;
  list.style.transform = `translateY(${position}px)`;

  const totalHeight = list.children.length * ITEM_HEIGHT;
  if (Math.abs(position) > totalHeight) {
    position = 0;
  }

  requestAnimationFrame(animate);
}
animate();

// ============================================================
// Загрузка розыгрыша
// ============================================================
async function loadRaffle() {
  if (!raffleId) return;

  try {
    const resp = await fetch(`/api/raffle?id=${encodeURIComponent(raffleId)}`);
    const data = await resp.json();
    if (!data.ok) return;

    participants = data.participants || [];
    endAt = data.endAt ? new Date(data.endAt) : null;

    renderList();
    updateTimer();

    if (tgUser) {
      const n = tgUser.username ? `@${tgUser.username}` : `id:${tgUser.id}`;
      if (participants.includes(n)) {
        joinBtn.textContent = "✅ Вы участвуете";
        joinBtn.disabled = true;
      }
    }
  } catch (e) {
    console.error("loadRaffle error:", e);
  }
}

// ============================================================
// Участвовать → API JOIN
// ============================================================
joinBtn.addEventListener("click", async () => {
  if (!raffleId) return;

  // Telegram не виден → юзер открыл в браузере
  if (!tg || !tgUser) {
    joinBtn.textContent = "Ошибка авторизации";
    joinBtn.disabled = true;
    console.warn("TG WebApp user not found");
    return;
  }

  const userId = tgUser.id;
  const username = tgUser.username || "";
  const display = username ? `@${username}` : `id:${userId}`;

  try {
    const url =
      `/api/join?id=${encodeURIComponent(raffleId)}` +
      `&userId=${encodeURIComponent(userId)}` +
      `&username=${encodeURIComponent(username)}`;

    const resp = await fetch(url);
    const data = await resp.json();

    if (data.ok) {
      joinBtn.textContent = "✅ Вы участвуете";
      joinBtn.disabled = true;
      myNickKey = display;
      await loadRaffle();
    } else {
      if (data.error === "NOT_SUBSCRIBED") {
        alert(
          "Чтобы участвовать, подпишитесь на каналы:\n" +
            data.notSubs.join("\n")
        );
      } else if (data.error === "ENDED") {
        alert("Розыгрыш уже завершён.");
        joinBtn.disabled = true;
        joinBtn.textContent = "Розыгрыш завершён";
      } else {
        alert("Ошибка, попробуйте позже.");
      }
    }
  } catch (e) {
    console.error("join error:", e);
    alert("Ошибка подключения к серверу.");
  }
});

// ============================================================
// Старт
// ============================================================
loadRaffle();
