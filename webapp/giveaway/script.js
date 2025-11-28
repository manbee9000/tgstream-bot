body {
  margin: 0;
  padding: 0;
  background: #0c0c0c;
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  overflow: hidden;
}

#roulette-container {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 300px;
  height: 400px;
}

#list-window {
  overflow: hidden;
  height: 100%;
  border-left: 1px solid #444;
  border-right: 1px solid #444;
}

#nickname-list {
  display: flex;
  flex-direction: column;
  position: relative;
  top: -300px; /* стартовая позиция */
}

.nickname {
  padding: 12px;
  font-size: 18px;
  text-align: center;
  color: #ccc;
}

#arrow {
  position: absolute;
  left: -40px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 40px;
  color: #fff;
}
