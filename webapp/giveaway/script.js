// 50 тестовых участников
const nicknames = Array.from({ length: 50 }, (_, i) => "@user_" + (i + 1));

const list = document.getElementById("nickname-list");

// Добавляем элементы в DOM
nicknames.forEach(nick => {
  const item = document.createElement("div");
  item.className = "nickname";
  item.textContent = nick;
  list.appendChild(item);
});

// Размер одного элемента (на глаз)
const ITEM_HEIGHT = 48;

// Стартовая позиция (список уходит вниз за пределы экрана)
let position = -nicknames.length * ITEM_HEIGHT;

// Анимация движения
function animate() {
  position += 2; // скорость движения
  list.style.top = position + "px";

  // Когда весь список прокрутился — начинаем заново
  if (position > 500) {
    position = -nicknames.length * ITEM_HEIGHT;
  }

  requestAnimationFrame(animate);
}

animate();
