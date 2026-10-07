# Bản sửa lỗi (fixed9) — autosell_spawn bị kick "Đã xảy ra lỗi nội bộ" (fix2 không bị)

**So sánh fix2 ↔ fix8:** code vòng bán (`_runSellSpawnCycle` / `_sellOneSpawn`: lookAt → chuột phải → click ô → đóng GUI) **giống hệt nhau**. Gói `block_place` và protocol không phải thủ phạm: log cho thấy bot dùng protocol 775 và server Velocity cũng báo 775 (không có lớp dịch phiên bản).
Thứ duy nhất fix8 đổi mà server nhìn thấy được là **nội dung gói `settings` (client settings)** gửi lúc login: fix2 thực tế gửi `skinParts=0, enableServerListing=false` (do ghi sai tên trường nên ra 0), còn fix8 gửi như client thật (`skinParts=127, enableServerListing=true`). Kick xảy ra ngay giây đầu tiên của vòng bán, lần nào cũng vậy.

**Chưa kiểm chứng với server thật** (môi trường sửa không có mạng/mineflayer). Đây là nghi vấn mạnh nhất theo diff, không phải kết luận chắc chắn.

**Đã làm:**
- `settings` giờ dựng theo **đúng tên trường của phiên bản đang dùng** (đọc từ minecraft-data) và mặc định **gửi đúng các giá trị fix2 đã gửi** (`"settingsProfile": "legacy"`). Muốn như client thật: `"settingsProfile": "vanilla"`.
- Ping "Server tự báo" (mở thêm 1 kết nối tới server lúc login, fix2 không có) → **tắt mặc định**, bật bằng `"pingServerInfo": true`.
- Khi bị kick lúc đang bán, log thêm dòng **`Gói bot gửi ngay trước khi bị kick: …`** (8 gói gửi gần nhất + trường của block_place). Nếu fix9 vẫn bị kick, gửi mình dòng này là biết chính xác gói nào gây ra.
- Test mới `test/settings-packet.test.js` (có trong `npm test`).

**Nếu vẫn bị kick:** `load.js` chạy `npm install` mới hoàn toàn (`mineflayer ^4.0.0` không khoá phiên bản) nên có thể đang dùng mineflayer/minecraft-protocol **mới hơn** bản fix2 của bạn. Trong thư mục chạy fix2 gõ `npm ls mineflayer minecraft-protocol minecraft-data` rồi gửi kết quả; so với log hiện tại: mineflayer 4.39.0, minecraft-protocol 1.68.0.

---

# Bản sửa lỗi (fixed8) — bị kick "Đã xảy ra lỗi nội bộ" ngay lúc autosell_spawn chuột phải lồng

**Log mới:** bản fixed7 đã hết "điếc" — bot về được lồng ("đã thấy lồng cạnh bot 1/1") và bật được autosell_spawn. Nhưng cả 2 lần bị kick `Đã xảy ra lỗi nội bộ…` đều rơi đúng giây vòng bán bắt đầu (bước chuột phải vào lồng), kick xong reconnect rồi lại lặp.

**Chưa chắc nguyên nhân** (chưa có dòng kick đầy đủ). Nghi nhất: gói chuột phải `block_place` của bot không khớp phiên bản server (cùng họ với lỗi `declare_recipes`: thư viện/`version` lệch với server hoặc proxy dịch phiên bản). Bản này thêm chẩn đoán để biết chắc:
- Đọc được lý do kick dạng NBT (1.20.3+) → hiện **nguyên văn đầy đủ** (trước đây in JSON thô, bị cắt ở "nội b").
- Lúc kết nối in dòng `Giao thức: bot dùng MC … (protocol …), config version=…, mineflayer …, minecraft-protocol … | block_place: <các trường gói>` và `Server tự báo: "<tên>" (protocol …)` (ping 1 lần/phiên, bỏ qua khi dùng proxy).
- Bị kick **khi đang chạy vòng bán 2 lần liên tiếp** → tự TẮT autosell_spawn (tránh kick lặp vô hạn / bị ban). Bật lại: `autosell_spawn on`.
- Sửa log giả: sau reconnect không còn dòng "GUI không mở sau 6s … 0/1 lồng" của vòng bán cũ.

**Việc cần làm / gửi lại cho mình:** 2 dòng `Giao thức:` + `Server tự báo:` và dòng `Bị kick:` đầy đủ. Nếu protocol bot ≠ protocol server hoặc mineflayer cũ: `npm i mineflayer@latest minecraft-protocol@latest minecraft-data@latest` và đặt `"version"` đúng bản server gốc (hoặc bỏ trống để tự dò).

---

# Bản sửa lỗi (fixed7) — bot "điếc" sau lỗi `declare_recipes` (nguyên nhân thật của lỗi `/home treolong`)

**Log mới cho thấy:** bot gõ `/home treolong` nhưng server **không trả lời gì**, rồi đúng 30s sau lỗi `declare_recipes` thì có `client timed out after 30000 milliseconds`. Ở log cũ cũng vậy: lệnh gõ **trước** lỗi thì server trả lời "Đang dịch chuyển…", lệnh gõ **sau** lỗi thì im lặng.

**Nguyên nhân:** `ProtocolGuard` chỉ ghi nhớ gói lỗi rồi **ném lỗi lên lại**. Với `minecraft-protocol`, lỗi parse trong luồng giải mã làm luồng bị **huỷ** → bot không đọc thêm được gói nào: không thấy chat, không thấy gói teleport, không trả lời `keep_alive` → 30s sau là timeout. Server gửi `declare_recipes` mỗi lần vào server / đổi world (sau `/menu`, sau `/home`…) nên bot "câm" đúng lúc teleport. Ghi chú ở fixed3 ("lỗi này không làm đứt kết nối, bot vẫn chạy bình thường") là **sai** — mình đã đoán mà chưa kiểm chứng. Bản fixed6 (bot đứng yên khi chờ teleport) vẫn hữu ích nhưng **không phải** nguyên nhân chính.

**Đã sửa:**
- `ProtocolGuard`: bọc `parsePacketBuffer`; gói parse lỗi → trả **gói giả `unparsed_packet`** thay vì ném lỗi ⇒ luồng đọc sống tiếp, các gói sau (chat, vị trí, keep_alive…) vẫn tới. Log chỉ cảnh báo 1 lần/loại gói: `… Đã BỎ QUA riêng gói này, giữ nguyên kết nối.`
- Lưới an toàn: nếu luồng đọc vẫn bị huỷ sau lỗi parse → log `[ERR] Luồng đọc gói tin đã bị huỷ…` và **reconnect ngay** (không chờ 30s).
- Chẩn đoán teleport: nếu hết hạn mà bot không nhận được gói nào từ server trong ≥5s → báo "kết nối đang câm (lỗi đọc gói tin), không phải lỗi lệnh /home" thay vì đoán home bị lỗi.
- Tắt chế độ bỏ qua nếu cần: `"skipBadPackets": false` trong config của bot (không khuyên dùng).
- Test mới (`npm test`): luồng `Transform` mô phỏng `FullPacketParser` — đường cũ thì luồng chết và mất các gói sau, đường mới thì giữ nguyên các gói sau.

**Cần kiểm tra khi chạy thật:** sau dòng `Đã BỎ QUA riêng gói này`, phải **không** còn `client timed out`, tin server (chat, "Đang dịch chuyển…") phải hiện bình thường, và vị trí bot đổi sang chỗ treo lồng. Khoảng cách 18.881 block tới lồng ở log vừa rồi là bot đang ở gần spawn (0,0), nên chưa có chunk lồng — bình thường cho tới khi `/home` hoàn tất. Nếu vẫn lỗi, gửi lại log + file `logs/protocol-errors.log`.

---

# Bản sửa lỗi (fixed6) — `/home treolong` không teleport + không thấy thông báo server

**Triệu chứng:** bot gõ `/home treolong`, server báo "Đang dịch chuyển…" (đếm ngược ~5s) nhưng bot không về được chỗ treo lồng, không có thêm thông báo nào.

**Nguyên nhân (đọc từ code, chưa chạy thử với server thật):**
1. **Bot vẫn nhảy/đi/xoay trong 5s đếm ngược.** AFK jump/walk chạy độc lập với việc về home nên làm bot xê dịch → plugin home hủy teleport. (AFK còn được tự khôi phục 3s sau khi vào menu — đúng lúc bot đang gõ `/home`.)
2. **Tin action bar / title bị nuốt.** Code bỏ hẳn mọi tin `game_info`/action bar và không nghe title, nên các tin kiểu "Teleport bị hủy, đừng di chuyển" không bao giờ hiện lên log.
3. **Không kiểm tra kết quả**: gõ xong là chờ 20s rồi gõ lại, không biết teleport có xảy ra hay không; gõ lại giữa lúc đang đếm ngược còn làm đếm lại từ đầu.

**Đã sửa:**
- Module mới `src/core/TeleportWatch.js`. Trước khi gõ lệnh: thả hết phím + huỷ timer nhảy/đi, chờ ~0.6s cho bot đứng im, rồi mới gõ. Trong suốt `spawnHomeWarmupMs + spawnHomeMarginMs` (mặc định 5s + 3s) AFK nhảy/đi **tạm dừng**; sau khi tới nơi còn đứng yên thêm 2s.
- Tự xác nhận kết quả mỗi giây: dịch ≥3 block → log `Đã dịch chuyển … sau X s`; hết hạn mà không dịch → log `KHÔNG bị dịch chuyển` kèm các tin server nhận được trong lúc chờ và nguyên nhân khả dĩ (bot tự xê dịch / server im lặng).
- Hiện lại tin **action bar + title/subtitle** (có dedupe 4s; chỉ hiện khi đang chờ teleport hoặc khớp từ khoá teleport/hủy/cooldown/home… để không spam).
- Không bao giờ gõ lại `/home` khi lần trước chưa kết thúc (khoảng cách tối thiểu ≈ 12s dù `spawnHomeCooldownMs` đặt nhỏ hơn).
- Log "CHƯA ở gần lồng" giờ kèm **khoảng cách tới lồng gần nhất + trạng thái block** (`chunk chưa tải` / `không phải spawner, đang là …` / `spawner OK`) để phân biệt: chưa tải chunk, toạ độ lồng lưu sai, hay home đặt xa lồng hơn tầm (6 block cho autosell_spawn).
- `spawnhome now` đi qua cùng quy trình.
- Test mới: `test/teleport-watch.test.js` (có trong `npm test`).

**Nếu vẫn không về được**, đọc dòng log mới sau khi gõ lệnh:
- `Bot bị xê dịch … teleport bị HỦY` → còn thứ gì khác làm bot di chuyển (macro, bị đẩy, nước/băng chuyền).
- `Server KHÔNG trả lời gì` → home `treolong` không tồn tại / đang cooldown / lệnh bị chặn.
- `Đã dịch chuyển … lồng gần nhất … cách N block` với N > 6 → home đặt cách lồng quá tầm, hoặc toạ độ lồng trong danh sách sai (`listspawners`, `addspawner` lại khi đứng sát lồng).

---

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
