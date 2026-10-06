# Bản sửa lỗi (fixed3)

## 1. Lỗi `Parse error for play.toClient ... array size is abnormally large`
Lỗi nghĩa là `minecraft-protocol` đọc 1 gói server→client mà trường "số phần tử mảng" ra số vô lý (210986572) → cấu trúc gói không khớp định nghĩa. Lỗi này **không làm đứt kết nối**, chỉ làm rơi 1 gói.

Nguyên nhân khả dĩ nhất trong code: `_afkNoise()` gửi `tab_complete "/"` ngẫu nhiên (~1 lần/24s mỗi bot ở chế độ walk-AFK) → server trả về **toàn bộ danh sách lệnh** (mảng rất lớn kèm tooltip) → đúng loại gói hay bị lệch định nghĩa ở các bản MC mới. Health-probe cũng dùng gói này.

Đã làm:
- `tab_complete` nhiễu AFK **tắt mặc định** (bật lại bằng `"afkTabNoise": true`; khi bật dùng đúng trường `transactionId` cho MC ≥ 1.13).
- Health-probe giờ gửi lại client settings (nhẹ, không kéo danh sách lớn).
- Module mới `src/core/ProtocolGuard.js`: gom lỗi parse, **không spam `[ERR]`**, chỉ cảnh báo 1 lần/loại gói + nhắc lại mỗi 60s, và **in ra tên gói bị lỗi** (vd `play.window_items`, id, kích thước). Mẫu hex lưu ở `logs/protocol-errors.log`. Nếu ≥ 20 lỗi/60s sẽ báo rõ là lệch phiên bản kèm cách xử lý.
- Chưa chạy thử với server thật (môi trường sửa không có mạng) → hãy xem dòng log "Lỗi đọc gói tin từ server: gói …" để xác nhận gói nào. Nếu vẫn còn: `npm i mineflayer@latest minecraft-protocol@latest minecraft-data@latest` và đặt `version` đúng với server (config đang để bot-1 = 1.21.11 nhưng mặc định chung = 1.21.1).

## 2. Bug khác đã sửa
- **Rò rỉ socket**: `_destroyMc()` gán `c.end = () => {}` rồi mới gọi `mc.end()` ⇒ socket cũ không bao giờ đóng, server vẫn thấy bot online → reconnect dễ bị "already logged in". Nay đóng socket thật.
- **Gói `settings` sai tên trường** (`chatMode`, `displayedSkinParts`, `allowServerListings`) ⇒ bị gửi toàn số 0 (skin parts = 0 khác vanilla). Nay dùng `mc.setSettings()` của mineflayer (tự đúng tên trường theo từng phiên bản); `clientSettings` tự khai vẫn được ghi nguyên văn.
- Bỏ lệnh DNS lookup thừa (kết quả không được dùng).
- `package.json`: bỏ 3 script trỏ tới file không tồn tại (`ecosystem.config.js`, `start-windows.ps1`, `cleanup.js`), thêm `npm test`.

## 3. Bảo mật / cập nhật
- Auto-update đã làm lại hoàn toàn bằng `load.js` (xem mục 4); `launcher.js`, `updater.js`, `update.json` đã bỏ.
- `load.js` không gửi token GitHub sang host khác khi bị redirect; giới hạn 5 lần redirect.
- Dashboard trước đây: không xác thực + CORS `*` + socket.io mở → bất kỳ trang web nào (hoặc ai truy cập được cổng) đều điều khiển được bot. Nay:
  - Đặt `DASHBOARD_TOKEN` (biến môi trường) hoặc `"dashboardToken"` trong config → trình duyệt hỏi mật khẩu (tên đăng nhập tuỳ ý, mật khẩu = token).
  - Chặn request/WebSocket khác nguồn (Origin ≠ Host). Cho nguồn khác: `DASHBOARD_CORS_ORIGIN=https://a.com,https://b.com`.
  - Thêm `/healthz` (luôn mở) cho Render/Docker; đã đổi `render.yaml` + `Dockerfile` sang đường dẫn này. Nếu đã tạo service Render từ trước, hãy đổi Health Check Path thành `/healthz`.

## 4. Auto-update kiểu mới: `load.js`
Trên máy chỉ cần **1 file `load.js`** (+ dữ liệu của bạn). `node load.js` mỗi lần mở sẽ: hỏi GitHub commit mới nhất → nếu khác bản đã tải thì tải code về `.anter/code/` (tự `npm install` khi `package.json` đổi) → chạy `main.js` từ đó. Mất mạng → chạy bản đã tải lần trước.
- Dữ liệu ở máy, cạnh `load.js`: `config.json` (mật khẩu, bot, macro, proxy), `revenue.json`, `proxies.txt`, `auth_cache/`, `logs/`, `backups/`. Update **không bao giờ đụng** vào các file này (không còn tự thêm key vào `config.json`). Máy mới chưa có `config.json` thì `load.js` tạo file trống `{"bots": []}` (thêm bot bằng lệnh `addbot` hoặc trên web).
- `.anter/` là thư mục tạm của load.js (code + `node_modules`), xoá đi lần sau tự tải lại. Không sửa tay trong đó.
- Đổi repo/nhánh/token: biến môi trường `GH_OWNER`, `GH_REPO`, `GH_BRANCH`, `GITHUB_TOKEN` hoặc file `update.json` cạnh load.js (`{"owner","repo","branch","token"}`). Mặc định `9649626269-create/Antertool@main`.
- Lệnh `update` trong tool: có bản mới thì thoát mã 42 → load.js tải và chạy lại.
- `main.js` giờ đọc `config.json` ở thư mục chạy (cwd) thay vì cạnh `main.js`; `node main.js` trực tiếp (Docker/Render) vẫn như cũ.
- Bỏ phụ thuộc `adm-zip` (load.js tự giải nén tar). Thêm `test/loader.test.js` (chạy bằng `npm test`, dùng server GitHub giả nên không cần mạng).
- Bảo mật: ai push được lên nhánh này thì chạy được code trên mọi máy dùng load.js → bật 2FA cho tài khoản GitHub, hoặc ghim `GH_BRANCH` sang một tag/nhánh riêng khi cần.

## Chạy kiểm thử
`npm test` (không cần cài thêm gì).
