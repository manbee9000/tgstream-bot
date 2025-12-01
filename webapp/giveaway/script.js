// ===============================
// READ URL PARAM
// ===============================
const params = new URLSearchParams(window.location.search);
const raffleId = params.get("id");

const list = document.getElementById("nickname-list");
const timerValue = document.getElementById("timer-value");
const joinBtn = document.getElementById("join-btn");

let participants = [];
let endAt = null;
let myNickKey = null;

// ===============================
// TELEGRAM WEBAPP BASE
// ===============================
const tg = window.Telegram?.WebApp || null;

if (tg) {
  tg.expand();
  tg.ready();

  // здесь нормальный способ получить авторизованного юзера
  if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
    const u = tg.initDataUnsafe.user;
    myNickKey = u.username ? `@${u.username}` : `id:${u.id}`;
  }
}

// ===============================
// RENDER LIST
// ===============================
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

// ===============================
// TIMER
// ===============================
function updateTimer() {
  if (!endAt) return;

  const now = new Date();
  let diff = Math.floor((endAt - now) / 1000);

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

// ===============================
// SCROLL ANIMATION
// ===============================
let position = 0;
const ITEM_HEIGHT = 48;

function animate() {
  if (!list.firstElementChild) {
    requestAnimationFrame(animate);
    return;
  }

  position -= 0.5;
  list.style.transform = `translateY(${position}px)`;

  const totalHeight = list.children.length * ITEM_HEIGHT;
  if (Math.abs(position) > totalHeight) {
    position = 0;
  }

  requestAnimationFrame(animate);
}

animate();

// ===============================
// LOAD RAFFLE DATA
// ===============================
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

    if (myNickKey && participants.includes(myNickKey)) {
      joinBtn.textContent = "✅ Вы участвуете";
      joinBtn.disabled = true;
    }
  } catch (e) {
    console.error("loadRaffle error:", e);
  }
}

// ===============================
// JOIN
// ===============================
joinBtn.addEventListener("click", async () => {
  if (!raffleId) return;

  // НЕ ДЕЛАЕМ alert — просто меняем текст
  if (!tg || !tg.initDataUnsafe || !tg.initDataUnsafe.user) {
    joinBtn.textContent = "Ошибка авторизации";
    joinBtn.disabled = true;
    return;
  }

  const u = tg.initDataUnsafe.user;
  const userId = u.id;
  const username = u.username || "";

  try {
    const url =
      `/api/join?id=${encodeURIComponent(raffleId)}` +
      `&userId=${encodeURIComponent(userId)}` +
      `&username=${encodeURIComponent(username)}`;

    const resp = await fetch(url);
    const data = await resp.json();

    if (data.ok) {
      myNickKey = username ? `@${username}` : `id:${userId}`;

      joinBtn.textContent = "✅ Вы участвуете";
      joinBtn.disabled = true;

      await loadRaffle();
      return;
    }

    // если нет подписки
    if (data.error === "NOT_SUBSCRIBED" && Array.isArray(data.notSubs)) {
      joinBtn.textContent = "❗ Подпишитесь на каналы";
      joinBtn.disabled = false;

      setTimeout(() => {
        joinBtn.textContent = "🎉 Участвовать";
      }, 2500);

      return;
    }

    if (data.error === "ENDED") {
      joinBtn.textContent = "Розыгрыш завершён";
      joinBtn.disabled = true;
      return;
    }

    joinBtn.textContent = "Ошибка";
    setTimeout(() => {
      joinBtn.textContent = "🎉 Участвовать";
    }, 2000);

  } catch (e) {
    joinBtn.textContent = "Сеть недоступна";
    setTimeout(() => {
      joinBtn.textContent = "🎉 Участвовать";
    }, 2000);
  }
});

// ===============================
loadRaffle();
