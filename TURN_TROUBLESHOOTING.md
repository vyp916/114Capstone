# TURN 伺服器故障排除指南

## 當前配置
- **STUN 伺服器**: Google 的 STUN (用於發現公共 IP)
  - stun.l.google.com:19302
  - stun1.l.google.com:19302
  - stun2.l.google.com:19302

- **TURN 伺服器**: openrelay.metered.ca (免費但可能不穩定)
  - 80/TCP (HTTP)
  - 443/TCP (HTTPS)
  - 443/TCP (TLS)

## 問題症狀
- ❌ 同一網絡內可以通信
- ❌ 跨越不同 ISP/網絡時無法通信
- ✅ 只有聊天室（Socket.IO）正常工作
- ✅ 聲音/視頻無法傳輸

## 根本原因分析

### 1. ICE Candidate 類型檢查
瀏覽器開發者工具中，查看以下日誌：
```
🎤 ICE candidate (host): ...      ← 本地 IP
🎤 ICE candidate (srflx): ...     ← 通過 STUN 發現的外部 IP
🎤 ICE candidate (relay): ...     ← 通過 TURN 的中繼
```

**問題跡象**:
- 如果只出現 `host` candidates → STUN 伺服器不可達
- 如果只出現 `host` + `srflx` 但沒有 `relay` → TURN 伺服器不可達
- 如果出現 `relay` 但連接仍失敗 → TURN 認證或配置問題

### 2. ICE 連接狀態
```
🌐 ICE connection: checking
🌐 ICE connection: connected      ← 成功！
🌐 ICE connection: failed         ← TURN 伺服器問題
```

### 3. 點對點連接狀態
```
🔗 Peer connection: connecting
🔗 Peer connection: connected     ← 成功！
🔗 Peer connection: failed        ← 致命問題
```

## 診斷步驟

### 步驟 1: 測試同一網絡
1. 在同一 WiFi 下，用兩個瀏覽器打開直播
2. 查看控制台日誌
3. 應該看到 `🎤 ICE candidate (host):` 的日誌
4. 連接應該成功

### 步驟 2: 測試跨網絡（手機+電腦）
1. 一個在 WiFi，一個在 4G/5G
2. 查看控制台日誌
3. 關鍵: 應該看到 `🎤 ICE candidate (relay):` 的日誌
4. 如果沒有 `relay` candidates → **TURN 伺服器問題**

### 步驟 3: 檢查 TURN 伺服器可達性
在瀏覽器開發者工具 Network 分頁查看：
- 如果有 `TURN` 連接失敗 → 服務器不可達
- 如果有認證錯誤 → 認證信息有誤

## 解決方案

### 選項 A: 使用更穩定的免費 TURN 服務
```javascript
const config = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // Twilio TURN
    {
      urls: "turn:numb.viagenie.ca",
      username: "webrtc@example.com",
      credential: "webrtcpassword"
    },
    // Xirsys TURN (需要註冊並獲取認證)
    // {
    //   urls: "turn:your-xirsys-url",
    //   username: "your-username",
    //   credential: "your-credential"
    // }
  ]
};
```

### 選項 B: 部署自己的 TURN 伺服器
推薦使用 `coturn`:
```bash
# 安裝
sudo apt-get install coturn

# 配置 /etc/coturn/turnserver.conf
listening-port=3478
listening-ip=0.0.0.0
external-ip=YOUR_PUBLIC_IP
realm=example.com
username=user
password=pass

# 啟動
sudo systemctl start coturn
```

### 選項 C: 使用商業 TURN 服務
- **Xirsys** - $5/月起
- **Twilio** - $0.015 per GB
- **AWS AppSync** - 按使用量計費

## 改進的 ICE 配置

```javascript
const config = {
  iceServers: [
    // 多個 STUN 伺服器確保冗餘
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
    // 主 TURN 伺服器
    {
      urls: ["turn:primary-turn-server:3478"],
      username: "user",
      credential: "password"
    },
    // 備份 TURN 伺服器
    {
      urls: ["turn:backup-turn-server:3478"],
      username: "user",
      credential: "password"
    }
  ],
  iceCandidatePoolSize: 10,
  // 放寬超時設定
  iceTransportPolicy: "all" // 允許 relay 候選項
};

// 添加連接監控
pc.addEventListener("icecandidate", (event) => {
  if (event.candidate) {
    console.log(`ICE (${event.candidate.type}): ${event.candidate.candidate}`);
  }
});

pc.addEventListener("iceconnectionstatechange", () => {
  console.log(`ICE state: ${pc.iceConnectionState}`);
});

pc.addEventListener("connectionstatechange", () => {
  console.log(`Connection state: ${pc.connectionState}`);
});
```

## 性能監控

在 server.js 中可以添加日誌記錄：
```javascript
socket.on("candidate", (id, candidate) => {
  const type = candidate.type; // host, srflx, relay
  console.log(`[${socket.id}→${id}] Sending ${type} ICE candidate`);
  socket.to(id).emit("candidate", socket.id, candidate);
});
```

## 建議行動

1. **立即**: 查看當前的 ICE candidate 日誌，確認 TURN 伺服器是否被使用
2. **短期**: 嘗試更換 TURN 伺服器或使用多個備份
3. **長期**: 部署自己的 TURN 伺服器以確保可靠性

## 相關資源
- [WebRTC 統計信息 API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_Statistics_API)
- [coturn 文檔](https://github.com/coturn/coturn)
- [ICE 候選項類型](https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidate/type)
