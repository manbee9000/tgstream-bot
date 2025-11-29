const params = new URLSearchParams(window.location.search);
const raffleId = params.get("id");

const list = document.getElementById("nickname-list");
const timerValue = document.getElementById("timer-value");
const joinBtn = document.getElementById("join-btn");

const tg = window.Telegram && window.Telegram.WebApp
  ? window.Telegram.WebApp
  : null;

let participants = [];
let endAt = null;
let myNickKey = null;

// немного «телеграмности»
if (tg) {
  tg.expand();
  tg.ready();
  const user = tg.initDataUnsafe && tg.initDataUnsafe.user;
  if (user) {
    myNickKey = user.username ? `@${user.username}` : `id:${user.id}`;
  }
}

// рендер списка
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

// таймер
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

// автозапуск таймера
setInterval(updateTimer, 1000);

// лёгкая бесконечная прокрутка
let position = 0;
const ITEM_HEIGHT = 48;

function animate() {
  if (!list.firstElementChild) {
    requestAnimationFrame(animate);
    return;
  }

  position -= 0.7; // скорость
  list.style.transform = `translateY(${position}px)`;

  const totalHeight = list.children.length * ITEM_HEIGHT;
  if (Math.abs(position) > totalHeight) {
    position = 0;
  }

  requestAnimationFrame(animate);
}
animate();

// загрузка данных розыгрыша
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

// клик по «Участвовать»
joinBtn.addEventListener("click", async () => {
  if (!raffleId) return;

  if (!tg || !tg.initDataUnsafe || !tg.initDataUnsafe.user) {
    alert("Откройте мини-приложение из Telegram, чтобы участвовать.");
    return;
  }

  const user = tg.initDataUnsafe.user;
  const userId = user.id;
  const username = user.username || "";

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
    } else {
      if (data.error === "NOT_SUBSCRIBED" && Array.isArray(data.notSubs)) {
        alert(
          "Чтобы участвовать, подпишитесь на каналы:\n" +
            data.notSubs.join("\n")
        );
      } else if (data.error === "ENDED") {
        alert("Розыгрыш уже завершён.");
        joinBtn.disabled = true;
        joinBtn.textContent = "Розыгрыш завершён";
      } else {
        alert("Не удалось добавить вас в участники. Попробуйте позже.");
      }
    }
  } catch (e) {
    console.error("join error:", e);
    alert("Ошибка подключения к серверу. Попробуйте позже.");
  }
});

// первый загрузочный запрос
loadRaffle();
