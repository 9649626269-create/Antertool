# Antares Manager

Bộ quản lý nhiều bot Minecraft (mineflayer) kèm web dashboard, macro, proxy, Telegram/Discord.

## Thông báo Discord Webhook — Thiết kế mới (`DiscordTheme`)
Hệ thống thông báo Discord Webhook được thiết kế lại đồng bộ qua module trung tâm `src/core/DiscordTheme.js` và `src/core/Notifier.js`:

- **Bảng màu theo mức độ (Severity)**:
  - `success` (`0x6ef16f` — xanh lá): `test` (Kiểm Tra Kết Nối Webhook), `reconnectRecovered`, `moneyGoal`, `protectResult`, `featuresReady`, `scheduleIn`, `connected`.
  - `info` (`0x38bdf8` — xanh dương): `autoSell`, `schedule`, `sellCycle`, `macro`, `system`.
  - `warning` (`0xf59e0b` — vàng hổ phách): `homeReturn`, `scheduleOut`, `testMention`, `proxy`, `posLost`.
  - `critical` (`0xef4444` — đỏ): `disconnect`, `reconnectFailed`, `spawnerThreat`, `sellFailed`.
  - `report` (`0xcf8338` — cam): `revenue` (Báo Cáo Tổng Kết Auto-Sell Spawn), `revenueMacro`, `revenueSummary`, `autoOrder`.
- **Bố cục chuẩn cho mọi Embed**:
  - Tiêu đề dạng Title Case tiếng Việt có gắn ký hiệu emoji theo từng loại sự kiện.
  - Dòng `author` gồm tên người chơi/bot (`Steve_01 (bot-1)`) và avatar đầu nhân vật từ `mc-heads.net`, kèm ảnh `thumbnail` góc phải.
  - Hàng trường ngang (`inline: true`) gọn gàng: `Người chơi`, `Server`, `Thời gian treo` cùng các trường chi tiết theo sự kiện.
  - Định dạng nâng cao: mốc thời gian tương đối của Discord (`<t:unix:R>`), trích dẫn (`>`) cho lý do bị kick, khối mã (` ``` `) cho lệnh và bảng tổng hợp, thanh tiến độ (`▰▰▰▱▱ 60%`) cho túi đồ/lượt thử/số lồng, định dạng tiền tệ thống nhất (`$41.35K`), chân trang `Antertool` và `timestamp` ISO.
  - Tự động che mọi thông tin nhạy cảm (URL webhook, token Telegram, thông tin xác thực proxy, mật khẩu đăng nhập) và cắt chuỗi an toàn theo Unicode code point (không bao giờ cắt đôi surrogate pair, luôn nằm trong giới hạn 256/4096/1024/25/6000/1900 của Discord).
- **Lệnh Console cho Discord Webhook**:
  ```
  webhook set <url>                  # lưu URL webhook Discord chung
  webhook test                       # gửi tin kiểm tra kết nối
  webhook preview [sự_kiện]          # gửi bộ mẫu thử giao diện của tất cả (hoặc 1) sự kiện lên Discord
  webhook events [a,b,c]             # xem hoặc chọn các loại sự kiện được bật
  webhook mention <ID|@tên|off>      # đặt người/role được tag cho disconnect, reconnectFailed, spawnerThreat
  webhook mention test               # gửi tin thử kiểm tra tag người nhận
  webhook revenue set <url>          # đặt webhook riêng cho báo cáo doanh thu
  webhook revenue test | off         # thử hoặc tắt webhook doanh thu riêng
  webhook revenue report             # gửi ngay báo cáo tổng hợp doanh thu cả dàn bot
  webhook revenue every <30m|1h|off> # hẹn giờ tự gửi báo cáo tổng hợp doanh thu
  webhook off                        # tắt webhook chung
  ```

## Thông báo & Điều khiển từ xa qua Telegram (v2)
- Bảng `Auto sell spawner` cập nhật tại chỗ, hiển thị trạng thái, hoạt động hiện tại kèm thanh tiến độ (`▰▰▰▱▱`), đếm ngược vòng bán kế tiếp, trạng thái bảo vệ lồng, toạ độ/ping/proxy, doanh thu và 8 mục lịch sử gần nhất trong `<blockquote expandable>`.
- Bảng ký hiệu chuẩn (`src/core/Symbols.js`) hỗ trợ 2 chế độ `unicode` và `ascii`, hoàn toàn không sử dụng ký tự emoji màu.
- Trung tâm thông báo `src/core/NotificationCenter.js` gộp tin trùng trong cửa sổ 30s, chống bão tin (digest), phân biệt sự kiện rung/im lặng và giữ nguyên 100% nội dung đầu ra Telegram.
- Điều khiển từ xa `src/core/TelegramControl.js` hỗ trợ phân quyền RBAC (`admin` / `viewer`), xác nhận hành động nguy hiểm bằng token 12-hex một lần hết hạn sau 30s, danh sách đen lệnh nhạy cảm (`/login`, `/register`, `/changepassword`, `/pay`), giới hạn tốc độ 5 lệnh/10s và khoá tạm 10 phút sau 5 lần bị từ chối.

## Changelog cải thiện (2026-10-19)
- Thêm `package-lock.json` — khóa dependency, Dockerfile dùng `npm ci`.
- Chuyển magic number sell/teleport vào `constants.js` (`SELL`, `TP`).
- Xóa hardcoded Discord ID `SELL_FAIL_MENTION_ID`. Dùng `sellFailMention` trong config bot (mặc định rỗng).
- `SessionVerifier.solveMath` viết lại bằng recursive descent parser (không còn `Function`/`eval`).
- Thêm `ConfigValidator.js` — kiểm tra schema cơ bản khi load `config.json` (log lỗi, không chặn startup).
- Dockerfile: thêm `wget`, bắt buộc lockfile.
- `config.example.json`: thêm `sellFailMention`, `sellFailMaxHome`.
- **Tách BotSession**:
  - `ReconnectHandler.js` — toàn bộ scheduleReconnect / cancel / force / proxy-fallback đã chuyển body.
  - `AutoSellHandler.js`, `TeleportHandler.js`, `LoginHandler.js` — skeleton + composition (delegate). Body method sẽ chuyển tiếp ở bước sau.
  - BotSession giảm ~120 dòng.

## Tích hợp logic premium (2026-10-19)
Port từ gói `premium` (Java/Fabric) những phần chạy được ở bot headless:
- `src/core/PremiumLogic.js` — logic thuần: parse lore đơn hàng (còn thiếu / giá), chọn đơn giá cao nhất, parse tin "Bạn đã giao…", đếm stack theo xác nhận server (`ConfirmedTransfer`, `PendingAccounting`), phát hiện hết hàng / hết tiền, whitelist/blacklist, NameProtect, độ trễ theo ping.
- `src/core/AutoOrder.js` + lệnh `autoorder <item> | off | status` — tự `/order`, lật trang, giao hàng, xác nhận, cộng tiền; báo cáo định kỳ qua webhook sự kiện `autoOrder` (config `autoOrderReportMin`, `autoOrderCauldron`).
- `"nameProtect": {"TênThật": "BíDanh"}` trong config bot → che tên trong mọi log/webhook.
- Test: `test/premium-logic.test.js`.
Không port: KillAura/CrystalAura/AutoTotem... (cần vật lý + render của client Minecraft, không có ở bot mineflayer).

## Auto Login & Antibot & Auto Join (2026-10-20)
Port từ `premium/AliceAutoReconnect.java` → `src/core/AutoLoginFlow.js` (máy trạng thái, tick 250ms). **Mặc định TẮT**; khi bật nó thay luồng `/dn` + `menuRetry` cũ.

Luồng: server báo "đăng nhập bằng lệnh /dn" → gửi `/l <mật khẩu>` → tin "đăng nhập thành công…" → `/menu` → nếu GUI có ô antibot (tên chứa *xác minh / là người / verify*) thì click tới khi server báo "xác minh thành công" → click ô vào server (mặc định ô 24 = `settings.kingSmpSlot`) → chờ GUI đóng → báo `_onMenuDone` cho cổng vị trí. Trong lúc chạy: tạm dừng `autoorder` (giữ nguyên bộ đếm), `spawnerprotect`, tự về home; xong thì bật lại. Timeout tổng 3 phút.

Bật: lệnh `autologin on` (rồi `reconnect`) hoặc trong `config.json` (cấp bot hoặc toàn cục):
```json
"autoLogin": { "enabled": true, "loginCommand": "/l", "finalSlot": 24, "actionDelayMs": 750, "startFallbackMs": 20000 }
```
Lệnh: `autologin on|off|status|now` (`now` = mở menu + vào server ngay). Mật khẩu lấy từ `autoLogin.password`, nếu trống dùng `botPassword` / `BOT_PASSWORD_<ID>`.

Khoá tuỳ chọn khác: `registerCommand` (`/dk`, chỉ gửi khi `registered:false`), `menuCommand`, `loginPrompt`, `menuTriggers`, `antibotItemNames`, `antibotSuccess` (danh sách cụm chữ, không cần dấu), `menuSendDelayMs`, `menuTimeoutMs`, `antibotTimeoutMs`, `postVerifyWaitMs`, `restoreSettleMs`, `globalTimeoutMs`, `maxLoginAttempts` (5), `triggerCooldownMs` (15000), `startFallbackMs` (0 = tắt fallback auto-join), `pauseFeatures`.
Khác bản Java: giới hạn số lần gửi lại lệnh login, chờ GUI nạp đủ item trước khi quyết định, cooldown tin kích hoạt menu, fallback tự vào server nếu không thấy tin nào. Test: `test/auto-login.test.js`.

## Đọc stats người chơi — `checkstats` (2026-10-20)
Port phần đọc dữ liệu stats của CheckStatsKingMC → `src/core/StatsReader.js`. Lệnh `checkstats <người chơi>`: bot gõ `/stats <tên>`, đọc GUI (tên + lore của từng ô, kể cả NBT/component), bỏ mã màu và chữ hoa nhỏ (`ᴍᴏɴᴇʏ` → `MONEY`), bỏ item trang trí (kính, barrier) và dòng hướng dẫn "nhấp/click", rồi in `TIÊU ĐỀ | giá trị` ra log + phát sự kiện `playerStats` (socket.io / `session.on`). Dùng trong code: `await session.statsReader.request('Notch')` → `{ player, title, items[], lines[] }`. Có timeout 15s, nhận tin "không tìm thấy người chơi", từ chối khi bot offline/bận (macro, bảo vệ lồng, đang đăng nhập). Trong lúc chờ GUI, `WindowRouter`/`StatsParser` bị chặn để không ghi đè shard của chính bot. Chưa port: `/bal`, order, AH, online, leaderboard, phần Discord/queue. Test: `test/stats-reader.test.js`.

## Chặn người ăn xin (`beggarGuard`)
`src/core/BeggarGuard.js` — khi người chơi trong chat xin tiền / xin đồ / nói kiểu "em là newbie", "em mới chơi", "em nghèo", "cho em xin ít tiền", "give me money"..., bot **tự gõ `/block <tên>`** để chặn họ. **Mặc định BẬT.**
- Chấm điểm từng tin sau khi bỏ dấu/chữ hoa: mẫu xin rõ ràng (xin tiền, cho em xin, ai cho em...) = 2 điểm, mẫu yếu (em là newbie, mới chơi, nghèo...) = 1 điểm. Chặn khi đủ `minScore` (mặc định 1 — chặn cả "em là newbie"; đặt 2 nếu chỉ muốn chặn khi xin rõ ràng).
- Chỉ chặn khi xác định được **người gửi là người chơi đang online** (tên nằm trước dấu `» : > ➤` trong dòng chat, hoặc theo `senderPattern` nếu chat của server có định dạng lạ). Tin hệ thống/quảng cáo không bao giờ bị chặn nhầm.
- Không chặn: chính bot, chủ bot (`ownerUsername`), các bot khác trong dàn, whitelist spawner và `beggarGuard.whitelist`.
- Mỗi người chỉ bị gõ lệnh **một lần** cho mỗi bot (lưu trong `beggars.json`) — nhiều plugin coi `/block` là công tắc, gõ lần hai sẽ bỏ chặn. Có khoảng nghỉ ngẫu nhiên giữa các lệnh và giới hạn `maxPerMinute` để server không phạt spam; chỉ chạy khi bot đã đăng nhập xong.
- Lệnh trong tool: `beggar on|off|status|list|forget <tên>|test <tin>`. `beggar test Steve: cho em xin ít tiền, em là newbie` cho biết tin đó có bị coi là ăn xin không (không cần server). `forget` chỉ xoá khỏi danh sách của tool; muốn bỏ chặn trên server hãy tự gõ lại `/block <tên>`.
```json
"beggarGuard": { "enabled": true, "action": "block", "commands": ["/block {player}"], "minScore": 1,
                 "whitelist": ["TenBanBe"], "extraPatterns": ["nhan\\s+qua\\s+mien\\s+phi"], "senderPattern": "", "delayMs": 2500, "maxPerMinute": 4 }
```
`action: "notify"` = chỉ ghi log `Ăn xin: <tên> ...`, không chặn. `commands` có thể có tối đa 3 lệnh (vd. thêm `/mute {player}`); `{player}` được thay bằng tên. Đặt trong `config.json` cấp toàn cục hoặc từng bot.

## Auto Xin Tiền / Thu Tiền (`autobeg`, `msg`)
`src/core/AutoBeg.js` + `src/core/MoneyParse.js`. **Mặc định TẮT.** "Clone" là một bot đã có trong `config.json` (thêm bằng `addbot`, đăng nhập bằng quy trình hiện có); module **không** tự tạo tài khoản và không vượt xác thực / giới hạn / chống spam của server.

Luồng: vào server xong (đăng nhập + menu) → lấy người online → lọc (loại chính bot, bot cùng hệ thống, owner, blacklist, người đã từ chối/đã xin trong `askCooldownMs`) → `/msg <người> <mẫu xin tiền>` có giãn cách và giới hạn/phút → khi hết danh sách `/bal` → nếu số dư đạt ngưỡng thì `/pay <owner> <số tiền>` đúng một lần → xác minh bằng phản hồi của server. Song song, mỗi dòng `» Bạn nhận được $<số> từ <người>` được ghi nhận và cảm ơn bằng `/msg`.

Lệnh (qua `cmd <id> ...` hoặc `cmdall ...`):
```
autobeg on [dry|live]    # bật (dry = chỉ ghi ý định /pay, không gửi); lưu enabled:true vào config
autobeg off              # dừng có kiểm soát (đang chờ xác minh /pay thì chờ xong mới tắt)
autobeg estop            # DỪNG KHẨN CẤP: xoá hàng đợi, không gửi thêm tin/giao dịch nào
autobeg pause | resume   # tạm dừng / tiếp tục (bắt buộc resume sau pause cứng, vd /pay UNKNOWN)
autobeg status           # trạng thái, số liệu vòng
autobeg test <dòng>      # kiểm tra một dòng server có được nhận dạng không (không tác dụng phụ)
autobeg forget <tên>     # xoá khỏi sổ đã xin / đã từ chối
msg <người chơi> <tin nhắn>   # /msg có kiểm tra tên, độ dài (<=256), giới hạn tốc độ
```
Trạng thái: `OFF, STARTING, CONNECTING, READY, REQUESTING, CHECKING_BALANCE, TRANSFERRING, VERIFYING, PAUSED, STOPPING`; chuyển trạng thái được kiểm tra, mỗi bot chỉ có một vòng chạy.

Cấu hình (`autoBeg` toàn cục hoặc trong từng bot; mọi giá trị được kiểm tra khi bật, sai thì báo lỗi và không bật):
```json
"autoBeg": { "enabled": false, "dryRun": false, "autoTransfer": true, "owner": "ten_owner", "minBalanceThreshold": "100K",
  "reserve": "0", "maxTransferAmount": "", "recipientMode": "allowlist", "allowedRecipients": ["Steve"], "blacklistRecipients": [],
  "requestMessageTemplate": "Em là newbie ạ, anh/chị cho em xin 100k mua giáp khởi nghiệp với huhu",
  "thankMessageTemplate": "Cảm ơn anh/chị nhiều ạ", "thankEnabled": true, "thankCooldownMs": 60000,
  "messageDelayMs": 3000, "responseTimeoutMs": 5000, "maxMessagesPerMinute": 12, "maxRecipientsPerRound": 20,
  "maxRounds": 3, "roundCooldownMs": 600000, "askCooldownMs": 86400000, "dedupWindowMs": 1000,
  "verifyWithBalance": true, "trustedPositions": ["system"] }
```
- `owner` **bắt buộc** khi chuyển tiền (không có giá trị mặc định, không tự đoán); đặt `"autoTransfer": false` để chỉ xin tiền.
- `recipientMode`: `allowlist` (mặc định, chỉ `allowedRecipients`) hoặc `online` (mọi người online trừ blacklist). Có sàn an toàn cho `messageDelayMs` (>= 1500), `responseTimeoutMs`, `roundCooldownMs`.
- Sổ dữ liệu chung `autobeg.json` (cạnh `config.json`): người đã xin/từ chối (nhiều clone không xin trùng một người) và nhật ký giao dịch. Ý định `/pay` được ghi xuống đĩa **trước** khi gửi.

An toàn tiền bạc (tóm tắt):
- Số tiền xử lý bằng BigInt; `$13.87M` là số làm tròn nên `/pay` chỉ gửi mức chắc chắn không vượt số dư thật (trừ 1 đơn vị hiển thị, vd `13860000`). Không đọc được số dư thì không chuyển và không mặc định bằng 0.
- Dòng `Bạn nhận được / Bạn có / Bạn đã chuyển cho / ...` chỉ được tin khi khớp toàn dòng, bắt đầu bằng "»" và position là `system`; tin người chơi tự chat hoặc `/msg` giả mạo không bao giờ được tính. `/pay` không bao giờ được kích hoạt bởi tin "Bạn nhận được".
- `/pay` gửi đúng một lần. Không có phản hồi hoặc mất kết nối ngay sau khi gửi thì giao dịch là `UNKNOWN`: tạm dừng cứng, tự đọc `/bal` để bạn đối chiếu, **không bao giờ tự gửi lại**; bạn kiểm tra rồi gõ `autobeg resume`.
- Phản hồi luôn đi qua listener của chính bot đã gửi lệnh. Nhãn `[Server]`/`[S1]` trong console chỉ là cách hiển thị (ChatFilter), không dùng để định tuyến.
- Hai khoản nhận tiền thật cùng người, cùng số tiền cách nhau quá `dedupWindowMs` đều được tính; chỉ tin lặp trong cửa sổ ngắn đó bị coi là gói trùng.
Test: `test/money-parse.test.js`, `test/auto-beg.test.js`, `test/auto-beg-integration.test.js`.

## Chạy
```bash
node load.js          # khuyên dùng: tự tải/cập nhật code từ GitHub rồi chạy
# hoặc từ mã nguồn:
npm install && npm run start:nolauncher   # = node main.js
```
Lần đầu: sao chép `config.example.json` → `config.json`, điền bot (hoặc thêm bằng lệnh `addbot` / trên web).

## Bảo mật (đọc trước khi deploy)
| Biến | Tác dụng |
|---|---|
| `DASHBOARD_HOST` | Địa chỉ nghe. Mặc định `127.0.0.1` (chỉ máy này); `NODE_ENV=production` mặc định `0.0.0.0`. |
| `DASHBOARD_TOKEN` | Mật khẩu dashboard (tên đăng nhập tuỳ ý). Nếu dashboard mở ra ngoài mà chưa đặt, tool **tự sinh token** và in ra console. |
| `BOT_PASSWORD_<ID>` / `BOT_PASSWORD` | Mật khẩu bot qua môi trường, không cần ghi vào `config.json`. |
| `DASHBOARD_CORS_ORIGIN` | Cho phép UI ở nguồn khác (danh sách, phân tách bằng dấu phẩy). |

`config.json`, `.env`, `proxies.txt` đã nằm trong `.gitignore` — đừng đẩy lên GitHub.

## Cập nhật tự động (`load.js`)
Code tải từ GitHub **được chạy trên máy bạn**, nên chỉ trỏ tới repo bạn tin:
- Ghim phiên bản: `GH_BRANCH=v1.0.0` (tag) hoặc SHA commit.
- Tắt tự cập nhật: `ANTER_AUTO_UPDATE=0` hoặc `"autoUpdate": false` trong `update.json`. Lệnh `update` trong tool vẫn cập nhật thủ công.
- Có `package-lock.json` trong repo → thư viện được cài bằng `npm ci`.

## Dọn rác tự động (`Janitor`)
Chạy **mỗi lần `node load.js`**, **ngay sau khi tải bản cập nhật**, **khi khởi động tool** và **mỗi 24 giờ** (bot treo nhiều ngày không đầy ổ). Gõ `clean dry` để xem trước, `clean` để dọn ngay.

| Loại | Việc làm |
|---|---|
| `temp` | xoá file tạm/dở dang: `*.tmp *.part *.swp *~`, `.DS_Store`, `Thumbs.db`, `.write-test-*`, `npm-debug.log`, `core.*`… |
| `updater` | xoá `.anter/code.new`, `.anter/code.old`, gói tải về còn sót, cache thư viện; khôi phục bản cũ nếu lần update trước bị ngắt giữa chừng |
| `logs` | xoá `runtime-*.log` quá `fileLogKeepDays` ngày, vượt tổng `maxLogMB` (xoá cũ nhất trước), cắt `protocol-errors.log` quá to |
| `backups` | chỉ giữ N bản trong `backups/` và N bản `config.json.*.bak` có dấu thời gian (`config.json.bak` chính luôn giữ) |
| `legacy` | **cách ly** file bản cũ đã bị loại bỏ (danh sách có sẵn + `obsolete.json` đi kèm bản code mới: `{"paths":["a/b.js"],"reason":"..."}`) |
| `authCache` | **cách ly** `auth_cache/<id>` của bot không còn trong `config.json` |
| `archives` | **cách ly** các file `.zip/.tgz` bản cập nhật cũ trong thư mục dữ liệu (giữ 1 bản mới nhất) |
| `staleCopies` | *(mặc định TẮT)* **cách ly** bản sao mã nguồn cũ cạnh `load.js` khi code thật chạy từ `.anter/code`: `clean copies` xem trước, `clean copies yes` để làm |

- **Cách ly** = chuyển vào `.anter/trash/<ngày-giờ>/`, giữ `trashDays` (7) ngày rồi mới xoá hẳn → nhầm vẫn lấy lại được (`clean trash` để xem).
- **Không bao giờ đụng**: `config.json`, `config.json.bak`, `.env`, `update.json`, `revenue.json`, `proxies.txt`, `beggars.json`, `ai_history.json`; không đi theo symlink; không ra ngoài thư mục dữ liệu/thư mục log; bỏ qua file mới sửa trong 2 phút.
- Sau mỗi lần update, `load.js` còn báo những file của bản cũ không còn trong bản mới (so với `.anter/manifest.json`).
- Tắt: `ANTER_CLEANUP=0` (chỉ phần của `load.js`) hoặc `"cleanup": {"enabled": false}` trong `config.json`. Chỉnh: `cleanup.{onStart, intervalHours, maxLogMB, keepBackups, keepConfigBackups, keepArchives, trashDays, staleCopies, temp, logs, backups, legacy, authCache, archives, updater}`.

## Log runtime ra file
Mọi log của bot và log hệ thống (khởi động, tắt, `[FATAL]`/`[UNCAUGHT]`/`[UNHANDLED]`) được ghi ra `logs/runtime-YYYY-MM-DD.log` (cạnh `config.json`), nên vẫn đọc được sau khi tool sập. Mật khẩu/token được che; chat của người chơi mặc định không ghi.
```
2026-10-17 23:45:01.123 [WARN  ] [bot-1] Bị kick, thử đăng nhập lại...
```
Cấu hình trong `config.json` (đều tuỳ chọn):

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `fileLogs` | `true` | Bật/tắt ghi file |
| `fileLogLevels` | `"all"` | `"all"` hoặc danh sách như `["warn","err"]` (mức: sys, ok, warn, err, afk, shard, proxy, health, chat) |
| `fileLogChat` | `false` | `true` = ghi cả chat của người chơi |
| `fileLogKeepDays` | `7` | Xoá file cũ hơn từng này ngày |
| `fileLogMaxMB` | `10` | Quá dung lượng này thì sang `runtime-DATE.1.log`, `.2.log`... |
| `fileLogFormat` | `"text"` | `"json"` = mỗi dòng một JSON (`.jsonl`), dễ lọc bằng `jq` |
| `fileLogDir` | `logs` | Thư mục ghi (hoặc biến môi trường `ANTER_LOG_DIR`, ưu tiên hơn) |

Đặt thư mục log ra chỗ khác (ví dụ Termux): `"fileLogDir": "/sdcard/bot"` trong `config.json`, hoặc `ANTER_LOG_DIR=/sdcard/bot` ở môi trường **hoặc trong file `.env` cạnh `config.json`** (biến môi trường thắng `.env`, `.env` thắng `fileLogDir`). Đường dẫn tương đối tính từ thư mục chứa `config.json`. Lúc khởi động tool in `Log file: <thư mục>` (hoặc cảnh báo nếu không ghi được); lỗi ghi file giữa chừng cũng được báo ra console 1 lần. Trên Termux, `/sdcard` cần chạy `termux-setup-storage` trước.

Ghi bất đồng bộ theo lô ~1 giây nên không làm chậm bot; riêng lỗi mức `err` được ghi ngay. Trên Docker/Render nhớ gắn volume cho thư mục `logs/` nếu muốn giữ log qua các lần deploy.

## Phát triển
```bash
npm test               # chạy mọi test/*.test.js, báo tổng kết (node test/run-all.js telegram để lọc)
npm run lint           # kiểm tra cú pháp
ANTER_DEBUG=1 node main.js   # in các lỗi trước đây bị nuốt im lặng trong catch
```
Mẫu CI (GitHub Actions) nằm ở `docs/ci.yml.example`. Muốn dùng: chép thành `.github/workflows/ci.yml` bằng tay trên GitHub. Không đưa file này qua bot Telegram, vì token của bot thường không có quyền `workflow` nên GitHub sẽ từ chối cả lần push.

## Docker / Render
`docker build -t antares-manager . && docker run -p 3000:3000 --env-file .env antares-manager`.
`render.yaml` tự sinh `DASHBOARD_TOKEN`; xem giá trị ở tab *Environment* của service.
