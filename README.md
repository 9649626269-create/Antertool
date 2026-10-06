# ⬡ Antares — Mine Bot Manager v2.0

A premium Minecraft bot management dashboard with CLI support. Proxy auto-detection, multi-bot orchestration, live web UI.

## Features

- **Multi-Bot Manager** — Run dozens of bots simultaneously with staggered startup and concurrent connection limits
- **Proxy Auto-Detect** — HTTP / HTTPS / SOCKS4 / SOCKS5 with automatic type detection, health tracking, and geo enrichment
- **Live Web Dashboard** — Real-time status, logs, inventory, commands, and system metrics
- **CLI Interface** — Full command-line control alongside the web UI
- **Auto Menu** — Automatic server menu navigation and GUI handling
- **AFK Modes** — Jump and walk AFK with anti-stuck detection
- **Shard Tracking** — Auto-read shard counts from scoreboard and inventory windows
- **Board Reader** — Read the full server scoreboard sidebar (Money, Shards, ...), not just one number
- **Macro Engine** — Scripted `chat`/`delay`/`winclick`/`waitmsg`/`stopif` sequences, chainable, runnable from CLI/web
- **Money Goal** — Auto-fire a macro the instant the tracked balance crosses a threshold
- **Spawner Protect** — Alert (and optionally auto-secure) when an unwhitelisted player nears a registered spawner
- **Order GUI Reader** — Reads the "/order" GUI (paginated order book) into a table: price, quantity, buyer, time
- **Discord Webhook** — Notifications for disconnects, reconnect status, Money Goal hits, and Spawner Protect alerts
- **Proxy Auto-Rotate** — Randomized 1-10 min proxy rotation per bot, plus bulk import from a .txt file
- **Scheduled Out/In** — Daily fleet-wide rest window (e.g., off at 23:00, back on at 06:00)
- **Auto-Sell** — Fires a user-defined macro once inventory crosses a fullness threshold
- **Premium (Microsoft) Login** — Optional real Microsoft/Xbox account auth alongside the default offline mode
- **Colored Termux Chat** — Player vs. server chat, color-coded, printed live to the CLI
- **Per-Bot Logs** — Isolated log streams for each bot, never mixed
- **Responsive Design** — Mobile-first Glassmorphism UI with gradient background

## Quick Start

### Windows
```bat
setup.bat
run.bat
```

### Linux / macOS
```bash
chmod +x setup.sh run.sh
./setup.sh
./run.sh
```

### Manual
```bash
npm install
node main.js
```

### Chạy bằng `load.js` (tự lấy code từ GitHub)
Chỉ cần copy **`load.js`** vào 1 thư mục trống rồi chạy:
```bash
node load.js
```
Lần đầu nó tải code + cài thư viện vào `.anter/`; các lần sau chỉ tải khi GitHub có commit mới. `config.json` (mật khẩu, bot…), `revenue.json`, `proxies.txt`, `logs/` nằm ngay cạnh `load.js` và không bị ghi đè khi update. Gõ `update` trong tool để cập nhật ngay không cần tắt tay. Chi tiết: xem `FIXES.md` mục 4.

Open **http://localhost:3000** in your browser.

## Configuration

Edit `config.json`:

```json
{
  "host": "server.com",
  "port": 25565,
  "version": "1.21.1",
  "ownerUsername": "YourName",
  "botPassword": "yourPassword",
  "bots": [
    {
      "id": "bot1",
      "host": "server.com",
      "port": 25565,
      "version": "1.21.1",
      "username": "BotName1",
      "botPassword": "password1",
      "useProxy": false
    }
  ],
  "proxies": [],
  "proxyAssignments": {}
}
```

| Field | Description |
|-------|-------------|
| `host` | Default Minecraft server IP |
| `port` | Default server port (25565) |
| `version` | Minecraft version string |
| `ownerUsername` | Your username for `/tpa` commands |
| `botPassword` | Password for `/dk` and `/dn` register/login |
| `bots[]` | Array of bot configurations |
| `proxies[]` | Proxy entries (managed via UI or CLI) |
| `settings.webPort` | Web dashboard port (default 3000) |

## Proxy Formats

```
http://user:pass@host:port
socks5://user:pass@host:port
host:port:user:pass          (auto-detect)
host:port                    (no auth)
```

## Macros (chat / delay / winclick)

Khai báo trong `config.json` (toàn cục) hoặc trong từng bot ở `bots[]` (mục `macros`, sẽ ghi đè macro toàn cục cho riêng bot đó):

```json
"macros": {
  "ten_macro": {
    "next": "macro_ke_tiep",   // tùy chọn — tự chạy tiếp khi macro này xong
    "steps": "chat /shop\ndelay 1000\nwinclick 15 1"
  }
}
```

Mỗi dòng trong `steps` là một bước, chạy tuần tự:

| Bước | Ý nghĩa |
|------|---------|
| `chat <lệnh>` | Gửi chat/lệnh MC (tự thêm `/` nếu thiếu) |
| `delay <ms>` | Chờ N mili-giây (tối đa 60000) trước bước kế tiếp |
| `winclick <slot> <button>` | Click ô `slot` (0-based) trong GUI đang mở. `button`: `0` = trái, `1` = phải |
| `waitmsg [timeoutMs] <chữ>` | Chờ tới khi có dòng chat/thông báo chứa đúng đoạn chữ đó (không phân biệt hoa/thường) mới chạy bước kế tiếp. Mặc định chờ tối đa 15000ms, hết giờ thì tự bỏ qua và chạy tiếp (không bị treo) |
| `stopif <chữ>` | Nếu (vài) dòng chat **gần đây** có chứa đoạn chữ này thì **dừng macro ngay** — không chạy nốt các bước còn lại, không chạy `next`. Dùng để tránh bấm mua lặp lại vô ích khi đã biết chắc sẽ thất bại (vd thiếu tiền) |

| `ask <câu hỏi>` | Dừng macro, chờ bạn trả lời bằng `answer <nội dung>`; câu trả lời lưu vào `$answer` để dùng ở bước sau |
| `askmap <câu hỏi> \|\| nhãn=giátrị,...` | Như `ask` nhưng đối chiếu với bảng nhãn→giá trị (vd `creeper=14`), không khớp thì huỷ macro |
| `confirm <câu hỏi>` | Chỉ chạy tiếp nếu bạn trả lời yes/có/ok/đồng ý — chặn trước bước bấm mua thật |

| `askmenu <tiêu đề> \|\| NHÓM: số=nhãn,... \|\| NHÓM2: ...` | Hiện **bảng chọn theo nhóm**, bạn chỉ gõ SỐ (hoặc tên như `gold`, `creeper`, `nguoi sat`) qua `answer`. Lưu `$answer` (số/slot), `$label` (tên), `$group` (nhóm). Gõ sai được hỏi lại tối đa 3 lần |
| `waitmsg! [timeoutMs] <chữ>` | Như `waitmsg` nhưng hết giờ mà **không thấy** thì **dừng macro** (không chạy `next`) |

Biến có sẵn trong macro: `$owner` (ownerUsername của bot), `$bot` (tên bot). Tên macro gõ không phân biệt hoa/thường và bỏ qua `_`/`-` (`Tpa_Owner` = `tpaowner` = `tpa_owner`).

**Luồng mua lồng/key:** `cmd s1 tpa_owner` → bot `/tpa` tới owner, click đồng ý, **chờ tin "dịch chuyển thành công"** (không thấy thì dừng) → tự chạy `mualong` → hiện bảng:

```
Chọn mua key/spawner
=== KEY ===        2: key free  3: key gold  4: key vip  5: key pre
=== SPAWNER ===    9: heo  10: bò  11: thây ma  12: nhện  13: ske
                   14: creeper  15: piglin  16: quỷ lửa  17: người sắt
```
Gõ `cmd s1 answer 9` (hoặc trên web: ô "Trả lời" ở tab Automation, câu hỏi hiện ngay phía trên) → xác nhận `cmd s1 answer yes` → mua. Muốn bỏ bước xác nhận thì xoá dòng `confirm ...` trong macro `mualong`. Muốn chỉ mua (không teleport) thì chạy thẳng `cmd s1 mualong`.

`stopmacro` ngắt macro **ngay lập tức**, kể cả khi đang giữa 1 bước `delay`/`waitmsg` dài — không cần chờ bước đó tự hết giờ.

Chạy qua CLI hoặc web dashboard (giống lệnh thường): `cmd <id> macro <ten_macro>`
Các lệnh liên quan: `stopmacro` (dừng macro đang chạy), `listmacro` (xem danh sách macro đã khai báo).

Ví dụ có sẵn trong `config.json`: `tpa_owner` (nối `next` sang `mualong`) và `mualong`. Slot key/spawner sửa ngay trong dòng `askmenu`; số danh mục shop là `winclick 15 1`.

### Money Goal — tự động chạy macro khi đủ tiền

Thay vì tự canh lúc nào đủ tiền để gõ lệnh mua tay, đặt 1 "ngưỡng tiền" — bot tự chạy macro chỉ định ngay khi Board báo đủ:

```
cmd s1 goal 1.5k mualong      # đủ 1500 (hoặc ★ 1.5K) là tự chạy macro "mualong"
cmd s1 goal                   # xem ngưỡng hiện tại + đã có bao nhiêu
cmd s1 goal off                # tắt
```

Sau khi macro chạy và tiêu tiền, tiền tụt xuống dưới ngưỡng thì cờ tự reset — lần sau gom đủ tiền lại tự bắn tiếp, không cần đặt lại. Cũng có thể khai báo mặc định trong `config.json` bằng 2 field `moneyGoal` và `moneyGoalMacro` ở cấp bot hoặc cấp toàn cục để giữ nguyên sau khi restart (lệnh `goal` chỉ đổi tạm thời trong phiên chạy, không ghi lại vào file).

## Spawner Protect (Bảo vệ Lồng Spawn)

Đứng sát lồng (≤5 block) rồi bật — bot tự làm phần còn lại:

1. **Khi bật**: tự lưu toạ độ mọi lồng trong **5 block** quanh bot (không cần `addspawner`; toạ độ cũ đã biến mất tự bị dọn).
2. **Cứ 5 tick (250ms)** quét người chơi trong **20 block** quanh bot. Owner, `spawnerWhitelist` và các bot khác trong dàn được tin, không bị coi là người lạ.
3. **Thấy người lạ**: lấy cúp trong túi đồ → không có thì mở **ender chest** lấy cúp → **giữ shift** đập hết lồng (plugin gộp lồng cho đào cả stack trong 1 lần; còn dư thì đập tiếp) → nhặt item rơi (nếu server không tự cho vào túi) → **cất mọi item có tên chứa "lồng" hoặc "spawn"** vào ender chest.
4. **Không có cúp ở cả túi đồ lẫn ender chest**: gửi cảnh báo **webhook liên tục** (mỗi 5s, còn người lạ là còn báo). Bot ở lại online để tiếp tục báo, nên `spawnerAutoDisconnect` không cắt trong trường hợp này.

```
cmd s1 spawnerprotect on       # bật (tự lưu lồng trong 5 block)
cmd s1 spawnerprotect off      # tắt
cmd s1 listspawners            # xem danh sách + trạng thái
cmd s1 addspawner [x y z]      # thêm tay (bỏ trống = vị trí đang đứng)
cmd s1 removespawner 100 64 200
```

Trên web: tab **Tự Động → Bảo vệ Lồng Spawn** (công tắc bật, ô quét, whitelist, lệnh ender chest, các tuỳ chọn bên dưới).

| Field (`config.json`, cấp bot hoặc toàn cục) | Ý nghĩa |
|---|---|
| `spawnerProtectRange` | bán kính quét người lạ quanh bot (mặc định **20**) |
| `spawnerSaveRange` | bán kính tự lưu lồng khi bật (mặc định **5**) |
| `spawnerWhitelist` | tên người chơi được tin thêm (ngoài owner + bot trong dàn) |
| `spawnerAutoMine` | mặc định **true**: tự lấy cúp/đập lồng/cất ender chest. `false` = chỉ cảnh báo |
| `spawnerRequireSilk` | mặc định **true**: chỉ dùng cúp **Silk Touch** (đập lồng bằng cúp thường thì lồng biến mất, không rơi ra). Server của bạn cho cúp thường rơi lồng thì đặt `false` |
| `enderChestCommand` | lệnh mở ender chest, mặc định `/ec`. Có rương ender thật trong tầm 4.5 block thì mở rương thật trước. Để `""` nếu chỉ muốn dùng rương thật |
| `spawnerAutoDisconnect` | ngắt kết nối sau khi đập xong lồng |
| `protectedSpawners` | toạ độ đã lưu (tự quản lý, lưu vào `config.json`) |
| `spawnerProtectOn` | `true` để tự bật lại sau khi bot kết nối lại |

Cảnh báo webhook dùng chung sự kiện `spawnerThreat`: người lạ tới gần (15s/lần), **không có cúp** (5s/lần), và kết quả xử lý (✅/⚠️).

Giới hạn cần biết: bot **không tự đi tới** lồng ngoài tầm với (chỉ đập lồng trong tầm với từ chỗ đang đứng, sát lồng là đủ) và chỉ đi thẳng vài block để nhặt item rơi. Phát hiện người lạ dựa trên danh sách người chơi client đã "thấy" được, nên người ở quá xa/chưa load thì chưa phát hiện được. Chưa test trên server thật — lần đầu nên thử với 1 lồng và cúp Silk Touch trong túi.

## Trình tự khởi động & tự về `/home treolong`

Mỗi lần bot vào server (kể cả sau khi bị kick/reconnect), mọi thứ chạy **đúng thứ tự**, bước sau chỉ bắt đầu khi bước trước xong:

1. **Đăng nhập** — bot gõ `/dn`, rồi **đợi server báo** `SẢNH ➞ Đăng nhập thành công, nếu chưa tạo mã pin, hãy vào discord.kingmc.vn để tạo` (tin `Bạn đã đăng nhập!` cũng được tính). Quá 45s không thấy tin này thì cảnh báo trong log và vẫn đi tiếp.
2. **Menu** — gửi `/menu`, click ô 24 trong GUI menu để vào server.
3. **Cổng vị trí** — chưa bật gì cả. Bot chờ tới khi **đứng cạnh lồng** (≥1 lồng trong danh sách `autosell_spawn` nằm trong 6 block, hoặc ≥1 lồng của `spawnerprotect` trong 8 block) và đứng yên ~2.5s. Sau khi vào menu 12s mà vẫn chưa ở gần lồng (server không tự đưa bot về chỗ cũ) thì **tự gõ `/home treolong`**, chờ 20s cho teleport rồi kiểm tra lại, tối đa 5 lần.
4. **Bật tính năng** — lúc này mới bật **spawnerprotect → autosell_spawn → autosell macro** (macro bán khi túi đầy), và gửi **webhook** `✅ đã bật spawnerprotect + autosell_spawn` (kèm vị trí, số lồng trong tầm, số lần đã gõ `/home`).

Sau khi đã bật, bot **vẫn canh vị trí**: nếu không còn ở gần lồng liên tục ≥4s (chết rồi hồi sinh ở spawn, bị đá về sảnh, bị teleport đi…) thì gửi webhook `🏠 lệch khỏi vị trí treo lồng`, **tự gõ `/home treolong`** (cách nhau 20s), tạm hoãn vòng bán của `autosell_spawn` cho tới khi về, rồi gửi webhook `✅ đã về lại vị trí treo lồng`. Gõ 5 lần vẫn không về được → báo động webhook (`spawnerThreat`, có tag) và thử thưa dần 5 phút/lần. Không can thiệp khi macro đang chạy hoặc bot đang đập lồng/đang bán. Lồng đã bị phá (chunk đã tải mà block không còn là spawner) không bị tính là "lệch vị trí".

```
cmd s1 spawnhome status          # xem: bật/tắt, lệnh, đang ở gần lồng hay không
cmd s1 spawnhome on|off          # bật/tắt tự về home (lưu vào config.json)
cmd s1 spawnhome now             # gõ lệnh về home ngay
cmd s1 spawnhome cmd /home abc   # đổi lệnh (mặc định /home treolong)
```

Lưu ý: macro như `tpa_owner` cố ý đưa bot đi chỗ khác — trong lúc macro chạy bot không bị kéo về, nhưng ngay sau khi macro xong (và lệch ≥4s) bot sẽ tự về `/home treolong`. Muốn ở lại chỗ mới thì `spawnhome off`.

| Field (`config.json`, cấp bot hoặc toàn cục) | Mặc định | Ý nghĩa |
|---|---|---|
| `spawnHomeEnabled` | `true` | tự về home khi lệch vị trí |
| `spawnHomeCommand` | `/home treolong` | lệnh về chỗ treo lồng |
| `spawnHomeGraceMs` | `12000` | sau khi vào menu, chờ chừng này cho server tự đưa bot về trước khi gõ lệnh |
| `spawnHomeConfirmMs` | `4000` | phải lệch liên tục chừng này mới coi là rời vị trí |
| `spawnHomeCooldownMs` | `20000` | giãn cách giữa 2 lần gõ lệnh |
| `spawnHomeMaxTries` | `5` | quá số lần này vẫn chưa về → báo động + thử thưa |
| `spawnHomeSlowMs` | `300000` | giãn cách thử lại sau khi quá số lần |
| `spawnHomeWarmupMs` | `5000` | thời gian server đếm ngược trước khi teleport — bot **đứng yên hoàn toàn** (không nhảy/đi/xoay, AFK tạm dừng) suốt thời gian này |
| `spawnHomeMarginMs` | `3000` | chờ thêm sau đếm ngược; quá mức này mà bot vẫn đứng nguyên thì log cảnh báo "KHÔNG bị dịch chuyển" kèm tin server và nguyên nhân khả dĩ |
| `spawnPositionSettleMs` | `2500` | phải thấy lồng cạnh bot + đứng yên chừng này mới bật tính năng |
| `spawnGateTimeoutMs` | `180000` | quá lâu chưa về được vị trí → báo webhook + vẫn bật autosell macro (spawnerprotect/autosell_spawn vẫn chờ) |
| `loginSuccessPattern` | *(trống)* | regex nhận tin "đã đăng nhập" nếu server dùng câu khác (mặc định nhận "đăng nhập thành công" / "đã đăng nhập") |
| `loginConfirmTimeoutMs` | `45000` | quá lâu không thấy tin xác nhận đăng nhập thì vẫn đi tiếp |

Webhook có 2 loại sự kiện mới: `featuresReady` và `homeReturn` (tự thêm 1 lần vào danh sách `webhook events` đã lưu; tắt bằng `webhook events ...` nếu không muốn nhận). Sau khi vào server xong, GUI lạ mở ra (vd GUI của `/home`) bị **đóng**, không còn bị click bừa ô 24 như trước.

## Auto-sell Spawn (tự bán ở lồng theo chu kỳ)

Bot định kỳ đi qua từng lồng trong danh sách: **chuột phải vào lồng** (mở GUI, *không* đập block) → **click ô số 51** → **đóng GUI** → sang lồng kế tiếp. Hết vòng thì chờ tới chu kỳ sau.

```
cmd s1 autosell_spawn scan              # lưu mọi lồng trong 5 block quanh bot vào danh sách
cmd s1 autosell_spawn every 30m         # chu kỳ: 30s | 5m | 2h | 1h30m | 1h 2m 3s
cmd s1 autosell_spawn slot 51 [0|1]     # ô cần click (mặc định 51), 0 = chuột trái, 1 = chuột phải
cmd s1 autosell_spawn on                # bật (tự quét lồng quanh bot nếu danh sách đang trống)
cmd s1 autosell_spawn now               # chạy 1 vòng ngay, không chờ chu kỳ
cmd s1 autosell_spawn off               # tắt
cmd s1 autosell_spawn add 100 64 200    # thêm tay toạ độ block lồng (remove/clear để bỏ)
cmd s1 autosell_spawn status            # xem trạng thái + danh sách
```
(`autosellspawn` viết liền cũng được.) Trên web: tab **Tự Động → Auto-sell Spawn** (ô Giờ / Phút / Giây, slot, nút Chạy ngay, Quét lồng).

| Field (`config.json`, cấp bot) | Ý nghĩa |
|---|---|
| `autoSellSpawnOn` | `true` = tự bật lại sau khi bot kết nối lại / restart |
| `autoSellSpawnList` | toạ độ lồng `[{ "x":0,"y":64,"z":0 }]` (tự quản lý khi dùng `scan`/`add`) |
| `autoSellSpawnSlot` | ô cần click trong GUI lồng (mặc định **51**) |
| `autoSellSpawnButton` | `0` chuột trái (mặc định) / `1` chuột phải |
| `autoSellSpawnHour` / `Minute` / `Second` | chu kỳ lặp = tổng 3 ô; tối thiểu 5 giây; để trống cả 3 = 5 phút |
| `autoSellSpawnRange` | bán kính tự quét lồng quanh bot khi bật (mặc định 5, tối đa 6) |
| `autoSellSpawnRevenue` | `true` (mặc định) = đọc doanh thu + báo cáo webhook |
| `autoSellSpawnMsgKeyword` | chỉ tính tin chứa chữ này (nhiều chữ ngăn bằng `\|`) |
| `autoSellSpawnMsgPattern` | regex tuỳ chọn, nhóm 1 = số tiền |
| `autoSellSpawnIgnoreChat` | `true` (mặc định) = bỏ qua chat người chơi |
| `autoSellSpawnReportMin` | tối thiểu N phút giữa 2 báo cáo (0 = mỗi vòng) |
| `revenueWebhookUrl` (cấp gốc) | webhook riêng cho báo cáo doanh thu |

Lưu ý:
- Bot **không tự đi tới** lồng — lồng phải nằm trong tầm với (≤6 block) từ chỗ bot đứng, lồng xa hơn sẽ bị bỏ qua và ghi log.
- Nếu ô 51 nằm ngoài GUI (GUI nhỏ hơn 52 ô) hoặc ô đang trống thì **không click** (tránh bấm nhầm vào túi đồ của bot).
- **Bảo vệ Lồng Spawn** và **macro** được ưu tiên hơn: gặp người lạ / có macro chạy thì vòng bán tự dừng nhường quyền, vòng sau chạy lại bình thường.
- GUI không mở sau 6 giây → bỏ qua lồng đó, sang lồng kế tiếp.

### Báo cáo doanh thu (webhook Discord)

Sau mỗi vòng bán, server báo số tiền bán được vào **chat của chính bot** (vd `1.25k`, `2.4m`, `1.1b`). Bot đọc các tin đó trong lúc chạy vòng bán (+4 giây sau lồng cuối), cộng lại, rồi gửi 1 embed lên Discord gồm: **vòng vừa xong** (tiền + số lồng bán thành công/lỗi), **hiệu suất** (trung bình 24h/giờ và giờ vừa qua), **doanh thu** (hôm nay, 24 giờ qua, hôm qua, ước tính/ngày), bảng 6 giờ và 7 ngày gần nhất, **tổng cộng** (số vòng + thời gian chạy) và giờ cập nhật.

```
webhook revenue set <url>          # webhook RIÊNG (kênh Discord khác) cho báo cáo doanh thu
webhook revenue test | off         # không đặt → báo cáo đi qua webhook chung (sự kiện "revenue")
cmd s1 autosell_spawn revenue              # xem nhanh: 1h qua, TB/giờ, ~/ngày, hôm nay, tổng
cmd s1 autosell_spawn revenue report       # gửi báo cáo ngay
cmd s1 autosell_spawn revenue every 30m    # tối đa 1 báo cáo / 30 phút (các vòng ở giữa được cộng dồn); off = mỗi vòng 1 báo cáo
cmd s1 autosell_spawn revenue on|off|reset
cmd s1 autosell_spawn msg bán|nhận         # CHỈ tính tin chứa 1 trong các chữ này (khuyên dùng để khỏi đếm nhầm); msg off = bỏ lọc
cmd s1 autosell_spawn ignorechat on|off    # bỏ qua chat người chơi (mặc định BẬT)
```
Trên web: card **Auto-sell Spawn → 💸 Doanh thu** (bật/tắt, lọc chữ, nút Gửi báo cáo / Reset) và tab **Hệ thống → Discord Webhook — Báo cáo doanh thu (riêng)**.

Cách tính & lưu ý:
- Mặc định tính mọi tin **không phải chat người chơi** xuất hiện trong lúc bán mà có số dạng `1.25k / 2.4m / 3b / 1.2t` hoặc `$1,250`. Số trần (`64`, `12`) không bị tính. Mỗi lần bot click xong, log hiện `Doanh thu: +1.25k ← "<tin gốc>"` để bạn kiểm tra đúng tin chưa.
- Định dạng tin của server khác (vd số nằm giữa câu, có nhiều số): đặt `autoSellSpawnMsgPattern` trong `config.json` là regex, **nhóm 1 = số tiền**, vd `"thu được\\s+(\\S+)"`.
- Nếu không đọc được tin nào nhưng có tin chứa số tiền ở kênh `chat` bị bỏ qua, log sẽ gợi ý `autosell_spawn ignorechat off`.
- **Vòng bán đầu tiên** (và vòng đầu sau khi bot offline) là hàng dồn từ trước: vẫn cộng vào tổng/hôm nay nhưng **không đưa vào doanh thu/giờ** để số liệu không bị thổi phồng. Cần ≥ 2 vòng liên tiếp mới có tốc độ; dưới 1 giờ đo thì ghi chú "ước tính". Doanh thu/ngày = TB/giờ × 24.
- Giờ/ngày tính theo múi giờ `timezone` trong `config.json` (mặc định `Asia/Ho_Chi_Minh`).
- Dữ liệu lưu ở `revenue.json` cạnh `config.json` (chi tiết 48 giờ, tổng theo ngày 60 ngày). Trên Render free (ổ đĩa tạm) file này mất khi redeploy/restart.

## Đọc GUI Đơn Hàng (/order)

Khi server mở GUI "ĐƠN HÀNG" (sau khi gửi `/order <item>`), bot tự nhận diện và hiện thành bảng trong log — **chỉ đọc, không tự bấm chọn/giao đơn nào**:

```
cmd s1 /order item_xxx
```

Bảng hiện: tên item, Giá, SL (số lượng), Người đặt, Thời gian — tách ra từ lore của từng ô bằng cách dò từ khoá (Giá/Price, Số lượng/SL, Người đặt/Người mua/Người bán, Thời gian/...). Field nào không dò được hiện dấu `?`. Xem đầy đủ dòng lore gốc (chưa lọc) của 1 mục để tự đối chiếu hoặc báo mình chỉnh từ khoá:

```
cmd s1 order raw 3   # xem trọn lore gốc của mục #3 trong bảng vừa hiện
```

Giới hạn hiện tại: chỉ đọc **đúng trang đang mở** (GUI có phân trang, không tự lật trang); nếu cần tự động quét nhiều trang, báo mình.

> **Đã sửa 1 bug liên quan:** trước khi có route riêng cho GUI này, nó bị rơi vào xử lý GUI-lạ mặc định và **tự bấm nhầm vào 1 slot cố định** — vô tình mở luôn màn "bỏ vật phẩm vào để giao" của bất kỳ đơn nào nằm ở đó. Giờ đã nhận diện riêng nên không còn bị click nhầm.

## Lịch Tự Out/Vào Theo Giờ

Cả dàn bot tự out lúc 1 giờ trong ngày, tự vô lại lúc giờ khác (giờ theo máy đang chạy Termux/VPS):

```
schedule on 23:00 06:00
schedule off
schedule
```

Chỉ những bot **bị chính lịch này out** mới được tự vô lại — bot bạn tự `stop` tay thì lịch không đụng vào. Có webhook riêng (`schedule`) nếu bật Discord Webhook.

## Auto-sell khi đầy túi đồ

Cùng cơ chế với Money Goal: tới ngưỡng % đầy thì tự chạy 1 macro do bạn định nghĩa — vì cách bán (`/sell`, `/sellall`, GUI...) tuỳ mỗi server, không đoán bừa:

```
cmd s1 autosell 90 ten_macro_ban    # 90% đầy (33/36 ô) là tự chạy macro
cmd s1 autosell off
cmd s1 autosell                      # xem trạng thái
```

Có độ trễ reset (phải dọn xuống dưới ngưỡng ~11 điểm % mới sẵn sàng bắn lại) để tránh bắn macro liên tục nếu số ô dao động ngay sát biên.

## Đăng nhập acc Premium (Microsoft)

Mặc định bot dùng chế độ offline (đăng nhập qua lệnh chat `/dn` như từ trước tới giờ). Muốn dùng acc Premium thật (Microsoft/Xbox), thêm vào bot trong `config.json`:

```json
{ "id": "s2", "username": "email-that-cua-ban@example.com", "authMode": "microsoft", ... }
```

Bỏ trống `botPassword` cho bot này (server online-mode thường không cần lệnh `/dn`). Lần đầu chạy, 1 link + mã xác thực sẽ hiện ra dạng chữ thô trong Termux — mở trình duyệt (máy khác cũng được) để đăng nhập Microsoft. Token được cache riêng theo từng bot ở `auth_cache/<id>/`, các lần sau tự kết nối không cần đăng nhập lại.

## Proxy

```
proxy list
proxy add socks5://user:pass@1.2.3.4:1080
proxy addfile duong/dan/proxies.txt      # thêm hàng loạt, mỗi dòng 1 proxy — cùng cú pháp như "proxy add"
cmd s1 proxyrotate on                     # tự xoay proxy 1-10 phút/lần (ngẫu nhiên, không phải chu kỳ cố định)
cmd s1 proxyrotate off
```
Cấu hình khoảng thời gian xoay trong `config.json`: `proxyRotateMinMinutes` / `proxyRotateMaxMinutes` (mặc định 1-10). Mỗi lần xoay là 1 lần **reconnect thật** tới server (đổi proxy giữa chừng 1 kết nối TCP đang mở là không thể) — cân nhắc: xoay càng dày thì càng nhiều lần login/logout, bản thân việc đó cũng là 1 kiểu "dấu vết" mà anti-cheat có thể để ý, không chỉ riêng việc đổi IP. Muốn ổn định hơn thì nghiêng về đầu 10 phút thay vì 1 phút.
`useProxy` phải bật thì `proxyrotate` mới hoạt động (không có proxy thì không có gì để xoay).

## Discord Webhook

Nhận thông báo khi có sự kiện quan trọng, không cần ngồi canh Termux:

```
webhook set https://discord.com/api/webhooks/xxx/yyy
webhook test
webhook off
webhook events                     # xem đang bật loại nào
webhook events moneyGoal,spawnerThreat   # chỉ bật 2 loại này (mặc định bật cả 5)
```

5 loại sự kiện: `disconnect` (bị kick), `reconnectFailed` (hết lượt reconnect, cần chú ý), `reconnectRecovered` (đã tự kết nối lại ổn định), `moneyGoal` (đủ tiền theo ngưỡng đã đặt), `spawnerThreat` (người lạ tới gần lồng đang bảo vệ). Webhook dùng chung cho tất cả bot (1 kênh Discord theo dõi cả dàn), cấu hình lưu thẳng vào `config.json`.

## CLI Commands

Gõ `help` (hoặc `h`, `?`) để xem **menu phân khu**, rồi `help <phân khu>` để xem chi tiết. Lệnh của bot cũng chia phân khu: `cmd <id> help`.

```
help                    Menu các phân khu
help <phân khu>         Chi tiết 1 phân khu:  bot | spawn | macro | afk | proxy | notify | system
help <lệnh>             Cú pháp 1 lệnh, vd: help autosell_spawn · help addbot
help all                Xem tất cả
cmd <id> help [phân khu]   Trợ giúp lệnh của bot (không gồm lệnh console)
```

| Phân khu | Nội dung |
|----------|----------|
| `bot` | list, start, stop, addbot, delbot, cmd, cmdall + status, ping, pos, inv, board, order, tpa, menu, reconnect |
| `spawn` | autosell_spawn (on/off/now/scan/every/slot/add/remove/clear/revenue/msg/ignorechat), spawnhome (on/off/now/status/cmd), spawnerprotect, addspawner, removespawner, listspawners, webhook revenue |
| `macro` | macro, stopmacro, listmacro, answer, autosell, goal, addcmd, delcmd, listcmd |
| `afk` | shard, stats, tshard, afk, wafk, stop, autoeat |
| `proxy` | proxy list/add/addfile, proxyrotate |
| `notify` | webhook set/test/off/events, schedule on/off |
| `system` | web on/off/status, sys, chatlog, update, help, exit |

Lệnh mới đăng ký trong `BotSession` mà chưa xếp phân khu sẽ tự hiện ở `help khac`. Muốn xếp: thêm 1 dòng vào `src/core/HelpCatalog.js`.

### addbot — thêm bot ngay trong Termux

```
addbot <tên> mk <mật khẩu> [ip] [port] [ver] [owner]

addbot 123 mk 123                                      # chỉ tên + mật khẩu, còn lại lấy theo bot đầu tiên
addbot 123 mk 123 play.abc.vn 25565 1.21.1 Steve       # đủ ip, port, version, owner
addbot 123 mk 123 play.abc.vn:25565 1.21.1             # ip:port viết liền
addbot 123 mk 123 - - 1.21.1                           # dấu "-" = bỏ qua (chỉ đổi version)
addbot 123 mk 123 ip=play.abc.vn port=25565 ver=1.21.1 owner=Steve id=acc1   # dạng key=value
```

Bỏ trống ip/port/ver/owner thì lấy theo bot đầu tiên (hoặc `config.json` gốc nếu chưa có bot). Thêm xong gõ `start <id>`.

### Web localhost

`web on` / `web off` / `web status` (hoặc `localhost on|off`) — bật/tắt web, bot vẫn chạy. Trạng thái lưu trong `config.json` (`webDashboard`).

## Requirements

- **Node.js** >= 18
- **npm** >= 9

## Project Structure

```
antares/
├── main.js                  Entry point
├── config.json              Bot & server configuration
├── package.json             Dependencies
├── setup.sh / setup.bat     Install scripts
├── run.sh / run.bat         Launch scripts
└── src/
    ├── core/                Core engine
    │   ├── BotSession.js    Bot lifecycle & events
    │   ├── ProxyManager.js  Proxy management & detection
    │   ├── CommandRegistry.js
    │   ├── WindowRouter.js  Minecraft GUI handling
    │   ├── PacketMonitor.js Packet rate tracking
    │   ├── constants.js     Timing & config constants
    │   └── utils.js         Utility functions
    ├── services/
    │   └── BotManager.js    Bot orchestration
    └── web/
        ├── WebDashboard.js  Express + Socket.io server
        └── public/          Frontend assets
```

## Deploy to Render

### 1. Blueprint (Auto Deploy)

Push this repo to GitHub, then in Render dashboard:

**New → Blueprint** → select your repo → Render reads `render.yaml` automatically.

### 2. Docker

**New → Web Service** → Docker → point to `Dockerfile`.

### 3. Manual

**New → Web Service** → Node:
- **Build Command:** `npm install`
- **Start Command:** `node main.js`

Render injects `PORT` env var automatically. The app prioritizes `process.env.PORT`.

> Free tier spins down after inactivity. Use Starter plan for 24/7 uptime.

## Changelog (bổ sung gần đây)

- **Mới:** Macro lặp `loop` / `until <chữ>` (+ `closewin`) — macro `mualong` mua liên tục tới khi server báo `Bạn cần có…` thì tự dừng (tối đa 500 lượt, `stopmacro` dừng tay). Macro đang có trong `config.json` của bạn: thêm dòng `loop 500` trước `chat /shop`, và thay dòng cuối `stopif Bạn cần có` bằng 3 dòng `delay 1200` / `closewin` / `until Bạn cần có`.
- **Mới:** Tự về `/home treolong` (`spawnhome`) — phát hiện bot không còn ở gần lồng spawn (sau đăng nhập hoặc đang treo) thì tự gõ lệnh về, có giãn cách/giới hạn số lần, webhook `homeReturn` khi lệch và khi đã về.
- **Sửa lỗi:** `spawnerprotect`, `autosell_spawn` và `autosell` (macro túi đầy) từng bật ngay lúc spawn, trước khi đăng nhập/vào menu xong và trước khi bot về tới chỗ treo lồng (gây báo nhầm người lạ, "quá xa/chunk chưa tải", macro bán chạy ngoài sảnh). Giờ đi đúng thứ tự: đợi tin `SẢNH ➞ Đăng nhập thành công…` → `/menu` + click ô 24 → chờ đứng cạnh lồng → mới bật cả ba và gửi webhook `featuresReady`.
- **Sửa lỗi:** `WindowRouter` tự click ô 24 ở **mọi** GUI lạ khi `autoMenu` bật (kể cả sau khi đã vào server); nay chỉ click ở bước menu (hoặc ngay sau lệnh `menu` gõ tay), GUI lạ khác bị đóng.
- **Mới:** Báo cáo doanh thu Auto-sell Spawn — đọc số tiền server báo (1.xxk/m/b), gom thành doanh thu vòng/giờ/ngày, gửi embed qua webhook riêng (`webhook revenue set <url>`) hoặc webhook chung.
- **Mới:** Auto-sell Spawn (`autosell_spawn`) — định kỳ chuột phải từng lồng → click ô 51 → đóng GUI → lồng kế tiếp; chu kỳ giờ/phút/giây tuỳ chỉnh, có UI web và lệnh CLI.
- **Sửa lỗi:** SOCKS4 proxy gửi sai định dạng khi target là domain (SOCKS4a) — thiếu byte NUL kết thúc thật sự, khiến nhiều proxy SOCKS4 từ chối/treo khi connect tới server bằng tên miền.
- **Sửa lỗi:** `WindowRouter` (auto-click/auto-đóng GUI lạ) từng đè lên macro đang chạy, gây kẹt/hủy giữa chừng — giờ macro được toàn quyền điều khiển GUI khi đang chạy, trả lại quyền cho `WindowRouter` ngay khi macro kết thúc.
- **Sửa lỗi:** `stopmacro` giờ ngắt ngay lập tức kể cả khi đang giữa bước `delay`/`waitmsg` dài, thay vì phải đợi bước đó tự hết giờ.
- **Nâng cấp:** Macro có thêm bước `waitmsg` (đợi đúng tin nhắn) và `stopif` (huỷ sớm nếu thấy tin nhắn báo thất bại — vd tránh bấm mua lặp lại khi đã biết thiếu tiền).
- **Nâng cấp:** Đọc được toàn bộ Board server (không chỉ 1 số shard đơn lẻ) — lệnh `board`, tự cập nhật Money/Shards nền.
- **Nâng cấp:** Chat server/player hiện màu trực tiếp trên Termux (`chatlog` để bật/tắt).
- **Mới:** `cmd <id> help` — xem toàn bộ lệnh của 1 bot.
- **Mới:** `cmdall <lệnh>` — gửi cùng lúc tới mọi bot đang online, không cần gõ từng bot.
- **Mới:** "Money Goal" (`goal <số> <macro>`) — tự động chạy 1 macro ngay khi tiền đạt ngưỡng, tự reset để lặp lại ở lần gom đủ tiền tiếp theo.
- **Mới:** "Spawner Protect" (`spawnerprotect`, `addspawner`, `listspawners`) — bật là tự lưu lồng ≤5 block, quét người lạ 20 block/5 tick, tự lấy cúp (túi/ender chest), giữ shift đập lồng, cất item lồng/spawn vào ender chest; không có cúp thì báo webhook liên tục.
- **Mới:** Đọc GUI "ĐƠN HÀNG" (`/order`) thành bảng (giá/SL/người đặt/thời gian) — chỉ đọc, không tự chọn/giao đơn.
- **Sửa lỗi:** lý do kick dạng chuỗi JSON (`{"text":"§c§l..."}`) lọt nguyên mã màu `§` + ngoặc JSON ra log/webhook — nay parse JSON rồi mới làm sạch.
- **Mới:** macro tương tác `ask`/`askmap`/`confirm` + lệnh `answer`; `mua_long` hỏi loại lồng và chờ xác nhận trước khi mua.
- **Sửa lỗi:** GUI dùng font chữ-hoa-nhỏ Unicode (vd "sʜᴏᴘ", "ĐƠɴ ʜÀɴɢ") không khớp được với các route nhận diện GUI (STATS/TPA/AFK...) vì `.toUpperCase()` không đổi được các ký tự này — giờ tự chuẩn hoá về chữ Latin thường trước khi so khớp, áp dụng cho mọi GUI chứ không riêng đơn hàng.
- **Sửa lỗi:** GUI "ĐƠN HÀNG" trước đây rơi vào xử lý GUI-lạ mặc định và bị tự bấm nhầm vào 1 slot cố định (vô tình mở màn giao đồ của đơn ngẫu nhiên) — nay có route riêng nên không còn bị.
- **Sửa lỗi:** `proxy` parse sai định dạng phổ biến nhất `ip:port:user:pass` (không có `scheme://`) — mất user/pass; đồng thời 1 chuỗi rác không hợp lệ lại bị chấp nhận nhầm thành proxy. Cả 2 phát hiện được trong lúc viết `proxy addfile`, đã sửa.
- **Mới:** `proxy addfile <path>` — nhập proxy hàng loạt từ file .txt.
- **Mới:** Xoay proxy tự động (`proxyrotate on|off`) — mỗi 1-10 phút (ngẫu nhiên).
- **Mới:** Discord Webhook (`webhook set/test/off/events`) — thông báo disconnect, reconnect fail/recovered, Money Goal, Spawner Protect.
- **Mới:** Lịch tự out/vào theo giờ (`schedule on/off`) — cả dàn bot nghỉ/vào theo khung giờ cố định trong ngày.
- **Mới:** Auto-sell khi đầy túi đồ (`autosell <%> <macro>`) — tự chạy macro do bạn định nghĩa khi túi đồ đạt ngưỡng % đầy.
- **Mới:** Đăng nhập acc Premium/Microsoft (`authMode: "microsoft"` trong config.json) — bên cạnh chế độ offline mặc định.
- **Mới:** Giao diện web (localhost) làm lại theo phong cách Glassmorphism (kính mờ, nền gradient) + tab "Tự Động" mới gom Macro/Board/Đơn hàng/Money Goal/Auto-sell/Bảo vệ Lồng Spawn; thêm dán nhiều proxy, xoay proxy, acc Premium, Webhook, Lịch tự out/vào vào các tab liên quan.

## License

MIT


### Lịch nghỉ (schedule) — bản sửa
- Tính giờ theo múi giờ `timezone` trong `config.json` (mặc định `Asia/Ho_Chi_Minh`), **không phụ thuộc giờ máy chủ** (Render chạy UTC nên trước đây lệch 7 tiếng).
- Chạy theo **khung giờ** (`schedule on 23:00 06:00` = nghỉ từ 23:00 tới 06:00, qua nửa đêm được): restart giữa đêm hay tick trượt phút vẫn đúng; bot nào start muộn trong giờ nghỉ cũng bị out.
- Nhập `6:00`/`23h30` đều được (tự chuẩn hoá `06:00`). `schedule off` giữa lúc đang nghỉ sẽ cho bot vô lại ngay.
