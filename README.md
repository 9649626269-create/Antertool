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
