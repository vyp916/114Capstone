# 114Capstone 直播平台部署指南

本指南整合實際部署時遇到的所有問題與解決方案，適用於在全新 Azure VM (Ubuntu 24.04 LTS) 上完整部署此直播平台。

---

## 前置準備

### 1. 本機準備
確保程式碼已推送到 GitHub：
```powershell
# 在本機 Windows PowerShell
cd C:\Users\vyp11\OneDrive\Desktop\Capstone\main
git status
git add .
git commit -m "準備部署"
git push
```

### 2. VM 基本資訊
- **作業系統**: Ubuntu 24.04 LTS
- **VM IP**: 例如 `20.41.121.153`
- **使用者**: `azureuser`
- **GitHub Repo**: `https://github.com/vyp916/114Capstone.git`（確保為 public 或配置 SSH/PAT）

---

## 第一步：SSH 連線與系統更新

```bash
# 從本機連線到 VM
ssh azureuser@<your_vm_ip>

# 更新系統套件
sudo apt update && sudo apt upgrade -y
```

---

## 第二步：安裝基礎環境

### 2.1 安裝 Node.js (LTS)
```bash
# 安裝 Node.js 20.x LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 驗證安裝
node -v   # 應顯示 v20.x.x
npm -v
```

### 2.2 安裝 MySQL
```bash
# 安裝 MySQL 伺服器
sudo apt install -y mysql-server

# 啟動 MySQL
sudo systemctl start mysql
sudo systemctl enable mysql

# 驗證
sudo systemctl status mysql
```

### 2.3 安裝 PM2（進程管理器）
```bash
# 全域安裝 pm2
sudo npm install -g pm2

# 驗證
pm2 -v
```

### 2.4 安裝 Git（通常已預裝）
```bash
sudo apt install -y git
```

---

## 第三步：克隆專案

```bash
# 建立專案目錄
mkdir -p ~/Capstone
cd ~/Capstone

# 克隆 GitHub repo（確保 repo 為 public 或已設定 SSH/PAT）
git clone https://github.com/vyp916/114Capstone.git main

# 進入專案目錄
cd ~/Capstone/main

# 檢查檔案結構
ls -la
# 應該看到: server.js, package.json, db/init_db.sql, public/, uploads/, .gitignore
```

---

## 第四步：安裝專案依賴

```bash
# 安裝 npm 套件（包含 dotenv, express, socket.io, mysql2 等）
npm install

# 驗證 node_modules 已建立
ls -la node_modules
```

---

## 第五步：設定 MySQL 資料庫

### 5.1 建立資料庫與使用者
```bash
# 進入 MySQL（root 無密碼）
sudo mysql

# 在 MySQL prompt 中執行以下 SQL：
```

```sql
-- 建立資料庫
CREATE DATABASE IF NOT EXISTS live_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 建立專用使用者（使用 mysql_native_password 避免認證問題）
CREATE USER 'live_user'@'localhost' IDENTIFIED WITH mysql_native_password BY 'YourStrongPassword123!';

-- 授予權限
GRANT ALL PRIVILEGES ON live_platform.* TO 'live_user'@'localhost';
FLUSH PRIVILEGES;

-- 驗證使用者
SELECT user, host, plugin FROM mysql.user WHERE user='live_user';
-- 應顯示: live_user | localhost | mysql_native_password

-- 切換到資料庫
USE live_platform;

-- 退出 MySQL
EXIT;
```

### 5.2 匯入資料表結構
```bash
# 使用 live_user 匯入 init_db.sql
mysql -u live_user -p live_platform < ~/Capstone/main/db/init_db.sql
# 輸入密碼: YourStrongPassword123!

# 驗證資料表已建立
mysql -u live_user -p -e "USE live_platform; SHOW TABLES;"
# 應顯示: users, streams, hashtags
```

---

## 第六步：建立環境變數檔案

### ⚠️ 關鍵步驟：正確建立 .env

```bash
# 在專案根目錄（與 server.js 同層）建立 .env
cd ~/Capstone/main

# 使用 cat 或 nano 建立 .env（避免編碼問題）
cat > .env << 'EOF'
PORT=3000
SESSION_SECRET=Replace_With_Random_Strong_Secret_Key_123456789

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=live_user
DB_PASS=YourStrongPassword123!
DB_NAME=live_platform
EOF

# 驗證 .env 內容
cat .env

# 驗證編碼（應為 ASCII 或 UTF-8，不可有 BOM）
file -bi .env
# 應顯示: text/plain; charset=us-ascii 或 utf-8

# 驗證 dotenv 能讀取（測試載入）
node -e "require('dotenv').config(); console.log('DB_HOST:', process.env.DB_HOST, 'DB_USER:', process.env.DB_USER, 'hasPass:', !!process.env.DB_PASS)"
# 應輸出: DB_HOST: 127.0.0.1 DB_USER: live_user hasPass: true
```

### 常見錯誤排查
- **若仍讀不到 .env**：檢查是否在正確目錄（與 server.js 同層）
- **若出現權限問題**：`chmod 600 .env`
- **若編碼異常**：使用 `dos2unix .env`（需先安裝：`sudo apt install dos2unix`）

---

## 第七步：啟動應用（處理埠衝突）

### 7.1 檢查 3000 埠是否被占用
```bash
# 查看 3000 埠狀態
sudo ss -lptn | grep :3000

# 如果有輸出（表示被占用），找出 PID 並關閉
sudo fuser -k 3000/tcp
```

### 7.2 使用 PM2 啟動
```bash
cd ~/Capstone/main

# 啟動應用
pm2 start server.js --name capstone

# 查看狀態
pm2 status
# 應顯示: capstone | online

# 查看即時日誌（確認 .env 載入成功）
pm2 logs capstone --lines 20
# 應看到:
# [dotenv] injecting env (7) from .env
# [boot] DB env -> { host: '127.0.0.1', port: '3306', user: 'live_user', passLen: 21, name: 'live_platform' }
# Server running on http://localhost:3000

# 儲存 PM2 進程列表（重開機後自動恢復）
pm2 save

# 設定開機自動啟動
pm2 startup
# 複製輸出的 sudo 指令並執行，例如：
# sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u azureuser --hp /home/azureuser
```

### 7.3 驗證健康檢查
```bash
# 測試健康端點
curl http://localhost:3000/health

# 應回傳：
# {"ok":true,"env":{"host":"127.0.0.1","port":3306,"user":"live_user","name":"live_platform","hasPass":true}}
```

---

## 第八步：設定 HTTPS 對外存取（必需，用於 getUserMedia）

瀏覽器的 `getUserMedia` API 要求 HTTPS 或 localhost。以下提供兩種方案：

### 方案 A：使用 ngrok（快速測試，推薦）

#### 8.1 安裝 ngrok
```bash
# 下載最新版本
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
  | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \
  && echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
  | sudo tee /etc/apt/sources.list.d/ngrok.list \
  && sudo apt update \
  && sudo apt install ngrok
```

#### 8.2 設定 authtoken
前往 https://dashboard.ngrok.com/get-started/your-authtoken 取得 token
```bash
ngrok config add-authtoken <your_authtoken>
```

#### 8.3 啟動 HTTPS 隧道
```bash
# 基本啟動（無密碼保護）
ngrok http 3000

# 或加上基本驗證（推薦，避免濫用）
ngrok http --basic-auth "tester:password123" 3000
```

#### 8.4 測試
1. 複製 ngrok 顯示的 HTTPS URL（例如 `https://abc123.ngrok-free.app`）
2. 在瀏覽器開啟：
   - 註冊/登入：`https://abc123.ngrok-free.app/register.html`
   - 開播：`https://abc123.ngrok-free.app/broadcaster.html`
   - 觀看：`https://abc123.ngrok-free.app/viewer.html`

### 方案 B：使用 Nginx + Let's Encrypt（正式環境）

#### 8.1 開放防火牆
```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
sudo ufw status
```

#### 8.2 安裝 Nginx
```bash
sudo apt install -y nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

#### 8.3 設定反向代理
```bash
# 建立 Nginx 設定檔
sudo nano /etc/nginx/sites-available/capstone
```

貼入以下內容（替換 `your-domain.com`）：
```nginx
server {
    listen 80;
    server_name your-domain.com;  # 替換成你的域名或 VM 公網 IP

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
# 啟用設定
sudo ln -s /etc/nginx/sites-available/capstone /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

#### 8.4 安裝 SSL 憑證（需要域名）
```bash
# 安裝 Certbot
sudo apt install -y certbot python3-certbot-nginx

# 取得憑證（自動設定 HTTPS）
sudo certbot --nginx -d your-domain.com

# 測試自動續期
sudo certbot renew --dry-run
```

---

## 第九步：驗證完整功能

### 9.1 註冊與登入
1. 開啟 `https://<your_https_url>/register.html`
2. 註冊測試帳號
3. 登入後應跳轉到 `index.html`

### 9.2 測試直播
1. 開啟 `broadcaster.html`，允許攝影機/麥克風權限
2. 填寫直播標題、描述、標籤
3. 上傳封面（可選）
4. 點擊「開始直播」
5. 觀察日誌：`pm2 logs capstone`

### 9.3 測試觀看
1. 另開瀏覽器/無痕模式
2. 前往 `viewer.html?room=<roomId>`（roomId 在 broadcaster 頁面顯示）
3. 應該看到直播畫面與聊天室

### 9.4 測試 PK 功能
1. 開啟兩個 broadcaster 分頁
2. 在其中一個點擊「邀請 PK」
3. 輸入對方房間號
4. 對方接受邀請
5. 雙方與觀眾會自動跳轉到 PK 頁面

### 9.5 檢查資料庫
```bash
mysql -u live_user -p -e "USE live_platform; SELECT * FROM users; SELECT * FROM streams;"
# 應看到註冊的使用者與直播記錄
```

---

## 常見問題與解決方案

### Q1: `EADDRINUSE: address already in use :::3000`
**原因**：3000 埠被其他進程占用（通常是舊的 node 進程或 pm2）
**解決**：
```bash
sudo fuser -k 3000/tcp
pm2 delete all  # 清除所有 pm2 進程
pm2 start server.js --name capstone
```

### Q2: `Access denied for user 'root'@'localhost'`
**原因**：.env 未被載入或 DB 使用者未設定
**解決**：
1. 確認 .env 在正確位置：`ls -la ~/Capstone/main/.env`
2. 驗證內容：`cat ~/Capstone/main/.env`
3. 測試 dotenv 載入：參考「第六步」的驗證指令
4. 確認 MySQL 使用者存在且使用 `mysql_native_password`

### Q3: `.env` 檔案存在但讀不到
**原因**：編碼問題（CRLF、BOM）或權限問題
**解決**：
```bash
# 轉換編碼
dos2unix .env  # 需先安裝: sudo apt install dos2unix

# 檢查權限
chmod 600 .env

# 重新建立（使用 cat << EOF）
cd ~/Capstone/main
rm .env
cat > .env << 'EOF'
PORT=3000
SESSION_SECRET=your_secret
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=live_user
DB_PASS=your_password
DB_NAME=live_platform
EOF
```

### Q4: `getUserMedia` 被瀏覽器阻擋
**原因**：必須使用 HTTPS 或 localhost
**解決**：使用 ngrok 或 nginx+certbot（參考第八步）

### Q5: WebRTC 連線失敗（NAT 穿透問題）
**原因**：公網環境需要 TURN 伺服器
**解決**：安裝 coturn（選用，適用於跨網路連線）
```bash
sudo apt install -y coturn
sudo nano /etc/turnserver.conf
# 設定 listening-port, external-ip, realm, user 等
sudo systemctl restart coturn
```

### Q6: PM2 重啟後環境變數消失
**原因**：PM2 未使用 `--update-env`
**解決**：
```bash
pm2 restart capstone --update-env
pm2 save
```

### Q7: PK 合併後的直播間不會出現在熱門推薦列表
**原因**：
1. **時序問題**：舊版本先將原始直播間標記為 `status=FALSE`，導致後續查詢 `user_id` 時找不到記錄
2. **外鍵失敗**：如果 `user_id` 查詢失敗，插入合併直播時使用 null 或無效值，導致 JOIN 失敗
3. **資料庫查詢條件**：熱門列表使用 `JOIN users` 且要求 `status=TRUE`，任何一個條件不符都會過濾掉

**診斷步驟**：
```bash
# 在 VM 查看 PM2 日誌
pm2 logs capstone | grep -i "pk:"

# 檢查資料庫中的 PK 直播
mysql -u live_user -p -e "USE live_platform; SELECT room_id, user_id, title, status FROM streams WHERE room_id LIKE '%_PK_%';"
```

**已修復**（需更新程式碼）：
- 調整插入順序：先插入合併直播，成功後才標記原始直播為結束
- 增強查詢邏輯：先查詢 `status=TRUE` 的記錄，失敗時 fallback 到最新記錄
- 改善錯誤日誌：明確記錄每個步驟的成功/失敗狀態

**驗證修復**：
1. 開啟兩個直播間 A 和 B
2. A 向 B 發起 PK，B 接受
3. 前往首頁 `/index.html`，應該看到新的 PK 直播出現在列表頂部
4. 標題顯示為 `PK: userA vs userB`

---

## 效能優化建議（選用）

### 1. 啟用 Nginx Gzip 壓縮
```bash
sudo nano /etc/nginx/nginx.conf
# 取消註解或新增：
# gzip on;
# gzip_types text/plain text/css application/json application/javascript;
```

### 2. 設定 PM2 集群模式（多核心利用）
```bash
pm2 delete capstone
pm2 start server.js --name capstone -i max  # 使用所有 CPU 核心
pm2 save
```

### 3. 設定 MySQL 連線池
已在 `server.js` 使用 `mysql2.createConnection`，如需高並發可改用 `createPool`。

---

## 安全加固（生產環境必做）

### 1. 限制 SSH 存取
```bash
# 僅允許金鑰登入
sudo nano /etc/ssh/sshd_config
# 設定: PasswordAuthentication no
sudo systemctl restart ssh
```

### 2. 安裝 Fail2Ban
```bash
sudo apt install -y fail2ban
sudo systemctl enable fail2ban
```

### 3. 定期更新系統
```bash
sudo apt update && sudo apt upgrade -y
```

### 4. 備份資料庫
```bash
# 建立備份腳本
mkdir -p ~/backups
mysqldump -u live_user -p live_platform > ~/backups/live_platform_$(date +%Y%m%d).sql
```

---

## 維護指令速查

```bash
# PM2 相關
pm2 list                    # 列出所有進程
pm2 logs capstone           # 查看日誌
pm2 restart capstone        # 重啟應用
pm2 stop capstone           # 停止應用
pm2 delete capstone         # 刪除應用
pm2 monit                   # 監控面板

# 更新程式碼
cd ~/Capstone/main
git pull
npm install
pm2 restart capstone --update-env

# 查看系統資源
htop                        # 需安裝: sudo apt install htop
df -h                       # 磁碟使用率
free -h                     # 記憶體使用率

# 查看網路連線
sudo ss -tulpn              # 所有監聽埠
sudo ss -lptn | grep :3000  # 特定埠

# MySQL 相關
sudo systemctl status mysql
mysql -u live_user -p
```

---

## 結語

此部署指南整合了實際部署過程中遇到的所有問題與最佳實踐。遵循本指南可在全新 VM 上快速部署完整可用的直播平台。

如遇到本指南未涵蓋的問題，請檢查：
1. PM2 日誌：`pm2 logs capstone`
2. Nginx 日誌：`sudo tail -f /var/log/nginx/error.log`
3. MySQL 日誌：`sudo tail -f /var/log/mysql/error.log`
4. 系統日誌：`sudo journalctl -xe`

祝部署順利！🚀
