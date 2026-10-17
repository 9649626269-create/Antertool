# Antares Manager

Bộ quản lý nhiều bot Minecraft (mineflayer) kèm web dashboard, macro, proxy, Telegram/Discord.

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
