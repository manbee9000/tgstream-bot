app.get("/webapp", (req, res) => {
  const raw = req.query.src || "";
  const DOMAIN = "tgstream-bot.onrender.com";

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Stream Viewer</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin:0; padding:0; height:100%; background:#000; }
  iframe { width:100%; height:100%; border:none; }
  #msg { color:white; text-align:center; margin-top:40vh; font-size:18px; }
</style>
</head>
<body>

<div id="msg"></div>
<iframe id="frame" allowfullscreen></iframe>

<script>
const rawUrl = ${JSON.stringify(raw)};
const frame = document.getElementById("frame");
const msg = document.getElementById("msg");

if (!rawUrl) {
  msg.innerText = "Нет ссылки";
} else {
  try {
    const url = decodeURIComponent(rawUrl);

    // ================= YOUTUBE =================
    if (url.includes("youtube.com") || url.includes("youtu.be")) {
      msg.innerHTML = "Открываю YouTube…";
      // В WebView iframe YouTube не работает — открываем напрямую
      window.location.href = url;
    }

    // ================= VK (конвертация в embed) =================
    else if (url.includes("vk.com/video")) {
      let embed = null;

      const match = url.match(/video(-?\d+)_(\d+)/);
      if (match) {
        embed = "https://vk.com/video_ext.php?oid=" + match[1] + "&id=" + match[2];
      }

      if (embed) {
        frame.src = embed;
      } else {
        msg.innerHTML = "Не удалось распознать VK видео";
      }
    }

    // ================= Twitch =================
    else if (url.includes("twitch.tv")) {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      const channel = parts[0];
      if (channel) {
        frame.src =
          "https://player.twitch.tv/?channel=" +
          encodeURIComponent(channel) +
          "&parent=${DOMAIN}";
      } else {
        msg.innerHTML = "Не удалось определить Twitch-канал";
      }
    }

    // ================= Fallback: просто открываем ссылку =================
    else {
      msg.innerHTML = "Открываю…";
      window.location.href = url;
    }

  } catch (e) {
    msg.innerHTML = "Ошибка загрузки";
  }
}
</script>

</body>
</html>`);
});
