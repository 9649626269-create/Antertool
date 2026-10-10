# Bản sửa (fixed16) — 5 lỗi từ báo cáo bug (proxy, bộ đếm kết nối, Restart/Start All, id proxy)

**BUG-001 — Proxy HTTP/HTTPS rò rỉ RAM/CPU** (`ProxyManager._connectHttp`): listener `data` đọc phản hồi CONNECT không bao giờ được gỡ, nên mọi byte của phiên chơi bị nối vào một chuỗi ngày càng dài và quét lại. Giờ gỡ listener ngay khi đọc xong header; socket được trả về trạng thái "chưa ai đọc" (như `http.ClientRequest` làm với CONNECT) nên không mất byte trước khi mineflayer gắn listener; byte thừa sau `\r\n\r\n` (nếu có) được `unshift` lại. Đo với proxy giả, 40 MB đi qua tunnel: **86 ms, heap +0 MB** (bản cũ 13 s, +39 MB).

**BUG-002 — Bộ đếm kết nối đồng thời bị kẹt** (`BotSession`): `_destroyMc()` giờ trả slot (`_onConnectComplete()`) trước khi `return`, nên restart/`start()` lần 2 khi đang CONNECTING không làm rò slot; `_connectCompleted` khởi tạo `true` và chỉ `start()` đặt `false` (cùng lúc tăng bộ đếm), nên `shutdown()` của bot chưa từng chạy không trừ nhầm slot của bot khác; bỏ dòng `_connectCompleted = false` trong `hardReset()`.

**BUG-003 — Restart bot đã chọn lại restart cả dàn** (`app.js` + `WebDashboard.js`): `bulkRestart` gửi `{ids:[...]}` (function không đi qua JSON được). Server lọc theo `ids` (không phân biệt hoa thường); `ids` rỗng = không restart bot nào; không có `ids` thì giữ hành vi cũ (restart tất cả). Sửa kèm: thông báo "Đã gửi restart N bot" trước đây luôn ghi 0 vì đọc số bot sau khi đã bỏ chọn.

**BUG-004 — "Start All" không bật lại bot đã Stop** (`BotManager.startAll`): bỏ điều kiện `!bot._disabled` (làm dòng `_disabled = false` bên dưới thành code chết). **Quyết định cần bạn xem lại:** bot đang nghỉ theo lịch (`_scheduledOut`) bị bỏ qua, vì `_scheduleTick` (20s/lần) sẽ out lại ngay; muốn Start All ép cả bot đó vô thì xoá `&& !bot._scheduledOut` ở dòng đó.

**BUG-005 — Id proxy trùng sau khi khởi động lại** (`ProxyManager.loadFromConfig`): sau khi nạp, `_idCounter` được đẩy lên (số lớn nhất của các id `pxy_N`) + 1. Id trùng đã nằm sẵn trong `config.json` của bạn thì không tự sửa: cần xoá rồi thêm lại proxy đó.

**Test mới (có trong `npm test`):** `test/proxy-http.test.js` (BUG-001, 005, dùng proxy giả trên localhost), `test/connect-slots.test.js` (BUG-002, 004, dùng BotManager/BotSession thật + mineflayer giả), `test/dashboard-restart.test.js` (BUG-003, cả hàm `bulkRestart` lẫn handler socket). Đã chạy cả 3 trên **bản fixed15 gốc**: đều fail đúng các kịch bản trong báo cáo; trên bản này đều qua, 11 test cũ vẫn qua.

**Chưa kiểm với server/proxy thật** (môi trường làm việc không có mạng ra ngoài, không cài được thư viện npm nên test dùng đồ giả như các test sẵn có).

**Ghi nhận, chưa sửa (ngoài báo cáo):** nếu bot dùng proxy đang chờ proxy trả lời (`await proxyManager.connect`) mà bị restart, lần `start()` cũ vẫn chạy tiếp và có thể tạo thêm một kết nối mineflayer nữa cho cùng tài khoản (kết nối thừa không bị đóng). Cách sửa gọn: đánh số thế hệ cho mỗi lần `start()` và bỏ qua lần đã cũ sau khi `await`.

---

# Bản chỉnh (fixed15) — bảng Telegram cập nhật mỗi 1 giây

**Yêu cầu:** bảng cập nhật mỗi 1s.

**Đã sửa:**
- Nhịp cập nhật mặc định **1 giây** (`telegramRefreshSec`, đổi bằng `telegram every <1s|10s|10m|off>`; thay cho `telegramRefreshMin` của fixed14). Bảng có **giây**: "Tổng Thời Gian Hoạt Động 3d 04h 12m 35s", "(2m 05s trước)", dòng "🔄 cập nhật HH:MM:SS".
- **Giới hạn của Telegram:** ~1 lần sửa/giây/chat (group còn chặt hơn, ~20 lần/phút). Nên mỗi nhịp tool sửa **đúng 1 bảng**, xoay vòng giữa các bot: 1 bot = mỗi giây, N bot = mỗi bảng ~N giây. Bot offline chỉ sửa 1 lần khi trạng thái đổi (hiện 🔴), không sửa liên tục. Bot đang có lần sửa chưa xong thì nhịp đó bỏ qua nó.
- **Gặp 429** (gửi quá nhanh): tự nghỉ đúng `retry_after`, bỏ qua các lần sửa trong lúc nghỉ; cảnh báo (tin mới) thì chờ hết giờ nghỉ rồi vẫn gửi, không mất.
- **Sửa lỗi nguy hiểm khi sửa liên tục:** trước đây sửa bảng lỗi vì bất cứ lý do gì (mạng chập chờn, 429) đều gửi **bảng mới** → sẽ đẻ bảng trùng hàng loạt. Giờ chỉ gửi bảng mới khi tin cũ thật sự bị xoá/không sửa được; lỗi tạm thời thì giữ bảng cũ.
- Nhịp giây chỉ chạy ở `telegram mode edit` (mode `new` mà sửa liên tục sẽ thành spam tin mới).
- Test: `test/telegram.test.js` thêm ca xoay vòng, bỏ qua bot bận, 429, lỗi mạng không đẻ bảng trùng, bot offline chỉ sửa 1 lần, mode new không chạy nhịp.

**Chưa test với Telegram thật.** Nếu bảng hay đứng/không đều giây thì xem log lỗi Telegram: dùng chat riêng với bot (không dùng group) hoặc `telegram every 2s`/`3s`.

---

# Bản thêm (fixed14) — bảng thông báo Auto sell spawner qua Telegram

**Yêu cầu:** thêm vào Telegram bảng: Auto sell spawner / Tên Bot / Tên Acc / Tình Trạng (ổn định 🟢) / Tổng Thu Nhập (K, M, B) / xx/day / 1h / Thu nhập vừa qua / Tổng Thời Gian Hoạt Động — kèm ý tưởng thêm.

**Đã thêm:**
- `src/core/TelegramNotifier.js` (mới): gửi/sửa tin qua Bot API, nhận lệnh bằng long polling (không cần mở cổng), chỉ phục vụ đúng `chatId`; tự tìm chat_id (`discoverChats`).
- `src/core/TelegramPanel.js` (mới): dựng bảng đúng mẫu + tính **Tình Trạng** 🟢🟡🟠🔴⚪⚫ + `/status`.
- `RevenueTracker`: đếm **tổng thời gian hoạt động** (cộng dồn các phiên ONLINE, chốt đúng cả khi tool tắt đột ngột; `reset` doanh thu không xoá giờ chạy) và trả thêm `lastAmount/lastAt` (thu nhập vòng vừa qua).
- `BotSession`: ghi giờ ONLINE/OFFLINE trong `_setState`; `_notify` chuyển mọi sự kiện sang Telegram; sau mỗi vòng bán gọi `onSellCycle`; cảnh báo `sellFailed` giờ gửi được cả khi chỉ dùng Telegram (không cần Discord).
- `BotManager`: bảng mỗi bot **sửa tại chỗ** (nhớ `message_id` trong config để lần chạy sau sửa đúng bảng cũ), tự cập nhật mỗi 10 phút, nút 🔄 Làm mới, lệnh `/status` `/panel` `/help`, cảnh báo kick/hết reconnect/vào lại/bán lỗi/bảo vệ lồng có thông báo đẩy.
- CLI `telegram set|chatid|test|panel|every|mode|events|commands|off` (+ `help notify`), hỗ trợ biến môi trường `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` cho Render/Docker.
- Test mới `test/telegram.test.js` (server Telegram giả trên localhost: định dạng bảng, trạng thái, đếm giờ, gửi/sửa/gửi lại khi tin bị xoá, chỉ nhận lệnh từ đúng chat, tích hợp BotManager) — có trong `npm test`. Toàn bộ test cũ vẫn qua.

**Chưa test với Telegram thật** (môi trường làm việc không có mạng ra ngoài) — các lời gọi API được kiểm bằng server giả theo đúng định dạng Bot API (`sendMessage`, `editMessageText`, `getUpdates`, `answerCallbackQuery`). Lần đầu chạy: `telegram set <token>` → nhắn `/start` cho bot → `telegram chatid` → `telegram panel`.

**Lưu ý:** "xx/day" là **ước tính** = trung bình/giờ × 24 (chỉ tính thời gian bot thực sự chạy, bỏ vòng đầu là hàng dồn); mới đo dưới 1 giờ thì bảng ghi `(ước tính)`.

---

# Bản sửa (fixed13) — góc nhìn không đổi + bỏ qua block nửa khối + bán lỗi thì /home treolong thử lại (tối đa 10 lần) rồi báo webhook

**Yêu cầu:** (1) góc nhìn bị lỗi, không chỉnh về lồng được; (2) block nửa khối như chồi thạch anh tím (người vẫn chui vô được) không được coi là vật cản; (3) không bán được lồng → gõ `/home treolong` rồi bán lại, lặp tối đa 10 lần, vẫn không được thì báo webhook tag `@1413104059333873764`.

**Nguyên nhân góc nhìn không đổi (đọc từ code, chưa chạy thử với server thật):**
- AFK (`afkWalk`/`afkJump`) vẫn gọi `look()` ngẫu nhiên mỗi ~0.5–5s và chỉ dừng khi đang chờ teleport — **không dừng khi đang bán/đang nhắm lồng** → góc nhìn vừa chỉnh về lồng bị đè ngay trước lúc chuột phải/đào. AFK walk còn giữ phím đi nên bot xê dịch.
- Lúc BẬT `autosell_spawn` ngay sau khi về home (đang trong thời gian đứng yên sau teleport), bước chỉnh góc nhìn bị **bỏ qua âm thầm**.
- `lookAt()` không có timeout: nếu gói xoay không gửi được thì đứng chờ vô hạn.

**Đã sửa (`BotSession.js`, module mới `AimUtil.js`):**
- `_faceBlock`: tự tính yaw/pitch nhìn vào tâm block rồi `look()` (có timeout 1.5s), chờ gói tới server, kiểm tra lại; lệch thì nhắm lại (tối đa 3 lần). Trong lúc nhắm + giữ ~4s sau đó **AFK đứng yên hẳn** (không xoay/đi/nhảy), phím đi đang giữ được thả.
- AFK cũng đứng yên suốt vòng bán, chuỗi `/home` thử lại và khi spawnerprotect đang xử lý.
- Chỉnh góc nhìn lúc bật `autosell_spawn`: nếu đang trong thời gian đứng yên sau teleport thì **đợi** (tối đa 10s) rồi mới xoay, không bỏ qua nữa. Ngay trước khi chuột phải còn kiểm tra lại một lần, lệch thì nhắm lại.
- Kiểm tra tia ngắm do bot tự tính (`AimUtil.aimCheck`): **chỉ khối đặc nguyên khối 1x1x1 mới che tia**. Chồi/cụm thạch anh tím, nến, thảm, nút bấm, ray, đuốc, cỏ, hoa, rào, kính tấm, bậc thang, phiến... đều được bỏ qua (dựa vào hình dạng thật `block.shapes`). Cảnh báo giờ nói rõ block nào che: `tia ngắm chưa trúng lồng — bị stone (x,y,z) che`.

**Bán lỗi → `/home treolong` → bán lại:**
- "Lỗi" = vòng bán chưa click đủ lồng (chunk chưa tải, quá xa, GUI không mở, ô trống...). Bị ngắt (tắt autosell, bảo vệ lồng ưu tiên, mất kết nối) thì **không** tính là lỗi.
- Lỗi → gõ `spawnHomeCommand` (mặc định `/home treolong`), đứng yên chờ teleport + chờ chunk lồng tải, bán lại. Lặp tối đa **10 lần** (`sellFailMaxHome`, đặt 0 để tắt). Đã ở sẵn chỗ treo thì teleport "tại chỗ" không sao, vẫn bán lại. Các lần gõ cách nhau ≥ ~12s. Trong chuỗi này canh-vị-trí không tự gõ `/home` chen vào.
- Vẫn lỗi sau 10 lần → webhook sự kiện mới **`sellFailed`**, dòng tiêu đề có tag `<@1413104059333873764>` (đổi bằng `sellFailMention` trong config của bot; `"off"` = không tag), kèm số lồng bán được, lý do lần cuối, vị trí bot. Giãn cách tối thiểu 10 phút giữa 2 tin thất bại (`sellFailAlertMinMs`). Chu kỳ bán kế tiếp vẫn tự chạy bình thường.
- Cần bật webhook (`webhook set <url>`); sự kiện `sellFailed` tự được thêm vào danh sách sự kiện đã lưu.

**Config (mỗi bot, tuỳ chọn):** `sellFailMaxHome` (10), `sellFailMention` ("1413104059333873764"), `sellFailAlertMinMs` (600000), `sellHomeChunkWaitMs` (6000).

**Test:** `test/aim-util.test.js` (block nào che tia), `test/sell-recovery.test.js` (gõ /home đúng số lần, báo + tag, không báo khi bán được/bị ngắt), `test/view-order.test.js` cập nhật (có cả ca chồi thạch anh tím).

**Chưa test trên server thật.** Khi chạy xem log: `đã chỉnh góc nhìn về lồng`; nếu bán lỗi sẽ thấy `bán chưa xong (…) → gõ /home treolong rồi bán lại (lần n/10)`. Nếu vẫn hay thấy `tia ngắm chưa trúng lồng — bị <block> che` với block là khối đặc thì thật sự có khối đặc đứng giữa bot và lồng.

---

# Bản sửa (fixed12) — autosell_spawn chỉnh góc nhìn trước khi bán; spawnerprotect nhìn lồng → đào → nhìn ender chest → mở → bỏ lồng vào

**Yêu cầu:** (1) khi bật `autosell_spawn` phải chỉnh lại góc nhìn về lồng rồi mới bán; (2) `spawnerprotect` làm đúng thứ tự: nhìn vào lồng → đào → nhìn vào ender chest → mở rương → bỏ lồng vào.

**Đã sửa (`BotSession.js`):**
- Hàm mới `_faceBlock()`: xoay đầu nhìn thẳng vào tâm block, chờ ~0.25s cho gói xoay tới server, rồi kiểm tra tia ngắm (`blockAtCursor`) có trúng đúng block đó không; lệch thì xoay lại (tối đa 2 lần). Không trúng (bị block khác che) thì log cảnh báo và vẫn làm tiếp như cũ — không chặn tính năng.
- `autosell_spawn`: lúc **bật** (cả lúc tự bật lại sau khi vào server) bot xoay về lồng đầu tiên trong tầm ngay (`_alignViewToSellSpawn`, bỏ qua nếu đang bận/đang chờ teleport). Mỗi lồng trong vòng bán đều `nhìn lồng → chuột phải → click ô`, có kiểm tra tia ngắm.
- `spawnerprotect`: từng lồng `nhìn vào lồng → đào`; `_openEnderChest` giờ `nhìn vào ender chest → mở rương` (rương thật trong 4.5 block; không có thì vẫn dùng `enderChestCommand`) rồi mới shift-click lồng vào. Dùng chung cho cả bước lấy cúp từ ender chest. Log từng bước: `nhìn vào lồng (x,y,z) → đào`, `nhìn vào ender chest (x,y,z) → mở rương`, `đã mở ender chest — bỏ N stack lồng vào`.
- Test mới `test/view-order.test.js` (có trong `npm test`): kiểm tra thứ tự các bước bằng bot giả lập (mineflayer/vec3 giả, không cần server).

**Chưa test trên server thật.** Cần xem trong log lúc chạy thật: dòng `đã chỉnh góc nhìn về lồng`, rồi `nhìn vào lồng … → đào`, `nhìn vào ender chest … → mở rương`. Nếu hay thấy `tia ngắm chưa trúng` thì có block đứng chắn giữa bot và lồng/rương.

---

# Bản sửa lỗi (fixed11) — auto menu không tự click vào server, phải gõ tay `cmd <bot> menu`

**Triệu chứng:** sau khi đăng nhập, bot gõ `/menu`, GUI `[MENU]` mở ra, log báo "Đã vào server thành công qua menu" + "Menu xong" nhưng **không có dòng `Click slot 24`** → bot vẫn ở sảnh. Gõ tay `cmd accchinh menu` thì có `Click slot 24` và vào được.

**Nguyên nhân (đọc từ code + log, khớp từng dòng):** hai đoạn code xung đột nhau.
- `windowOpen` (BotSession): thấy GUI tên có "MENU" → đặt `_menuSuccess = true` **rồi mới** gọi `WindowRouter.route`.
- `WindowRouter._handleUnknown`: chỉ click ô vào server khi `_menuSuccess` còn **false** (hoặc vừa gõ tay lệnh `menu`, có `_manualMenuUntil`); ngược lại **đóng GUI**. Vì `_menuSuccess` đã bị đặt true từ trước nên luôn rơi vào nhánh đóng GUI.
- Gõ tay thì có `_manualMenuUntil` nên mới click được. Lỗi này có từ fix2, không phải do fix8.

**Đã sửa:**
- `windowOpen` không đặt `_menuSuccess` trước khi route nữa. `_handleUnknown` click ô 24 rồi mới đặt `_menuSuccess` + gọi `_onMenuDone`. Nếu chưa click được (ô trống) thì vòng `menuRetry` vẫn chạy, mở lại `/menu`.
- `WindowRouter.route()` giờ trả `true/false` (route đăng ký sẵn đã xử lý hay GUI lạ) để trường hợp GUI do route khác xử lý vẫn tính là xong bước menu.
- Log đổi thành "Đã mở GUI menu … — click ô vào server" (trước đó báo "vào server thành công" sai sự thật).
- Test mới `test/menu-click.test.js` (có trong `npm test`).

**Kiểm tra sau khi chạy:** sau khi đăng nhập phải thấy `Gửi menu lần 1` → `Click slot 24 trong [MENU]` → `Menu xong (click ô 24)`, rồi bot tự vào server mà không cần gõ tay.

---

# Bản sửa lỗi (fixed10) — autosell_spawn bị kick "Đã xảy ra lỗi nội bộ" (fix2 không bị)

**Nguyên nhân (đã đối chiếu log + ảnh):** bot đang chạy **giao thức 26.1 (775)** còn server thật là **1.21.11** (client Meteor 1.21.11 trong ảnh vào được bình thường).
- `config.json` của fix2 ghi sẵn `"version": "1.21.11"` cho bot. Bản bạn chạy qua `load.js` có `config.json` riêng, bot không có `version` → để **tự dò**.
- Tự dò = ping server. Server nằm sau proxy **Velocity 26.1**, proxy luôn báo protocol mới nhất của chính nó (775) dù server phía sau chạy 1.21.11 → bot chọn 775, proxy phải dịch 775→1.21.11 (ViaVersion) và dịch hỏng đúng gói **chuột phải (`block_place`)** → Velocity kick "An internal error occurred in your connection".
- Bằng chứng trong log fix9: 8 gói cuối trước khi bị kick là `… position_look → block_place → arm_animation` rồi kick ngay; mọi thứ trước đó bình thường. Code vòng bán của fix2 và fix8 giống hệt nhau — chỉ khác phiên bản giao thức.
- **Đính chính fix9:** mình đã đoán nguyên nhân là gói `settings` — **sai** (log fix9 vẫn bị kick). Đã trả mặc định về như client thật (`"settingsProfile": "vanilla"`); `"legacy"` vẫn còn nếu cần.

**Đã sửa:**
- Để trống `version` giờ mặc định **1.21.11** (trước: tự dò). Muốn tự dò như cũ: `"version": "auto"`. Áp dụng cho bot đã có sẵn trong config (không cần sửa tay) và cho `addbot`.
- Thông báo khi autosell bị kick 2 lần giờ chỉ thẳng vào việc đặt đúng `version`.
- Ping "Server tự báo" chạy lại khi `version` để tự dò (tắt: `"pingServerInfo": false`).
- Giữ dòng chẩn đoán `Gói bot gửi ngay trước khi bị kick: …`.
- Test mới: `test/settings-packet.test.js` (gồm kiểm tra `resolveVersion`).

**Kiểm tra sau khi chạy:** dòng `Giao thức:` phải ra `MC 1.21.11 (protocol 774)`, `config version="1.21.11"`; vòng bán không còn bị kick. Nếu vẫn kick, gửi lại dòng `Gói bot gửi ngay trước khi bị kick`.

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
