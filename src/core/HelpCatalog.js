'use strict';
// Trợ giúp chia theo phân khu. Dùng chung cho:
//   - console Termux:  help | h | ?  [phân khu | lệnh | all]
//   - lệnh của bot:    cmd <id> help [phân khu | lệnh | all]
//
// Thêm lệnh mới: thêm 1 dòng vào đúng phân khu bên dưới.
// Lệnh bot đăng ký trong BotSession mà CHƯA có ở đây sẽ tự rơi vào phân khu "khac".

const SECTIONS = [
  {
    key: 'bot', title: 'Bot', desc: 'thêm/xoá, bật/tắt, gửi lệnh, xem trạng thái',
    aliases: ['bots', 'acc'],
    con: [
      { name: 'list', usage: 'list', desc: 'liệt kê tất cả bot (trạng thái, Money, Shards)' },
      { name: 'start', usage: 'start <id>', desc: 'khởi động một bot' },
      { name: 'stop', usage: 'stop <id>', desc: 'dừng một bot' },
      { name: 'addbot', usage: 'addbot <tên> mk <mật khẩu> [ip] [port] [ver] [owner]', desc: 'thêm bot mới. vd: addbot 123 mk 123  |  addbot 123 mk 123 play.abc.vn 25565 1.21.1 Steve' },
      { name: 'addbot', usage: 'addbot ... ip=<ip> port=<n> ver=<x.y.z> owner=<tên> id=<id>', desc: 'dạng key=value (đặt thứ tự tuỳ ý). Dấu "-" = bỏ qua, lấy mặc định theo bot đầu tiên' },
      { name: 'delbot', usage: 'delbot <id>', desc: 'xoá bot khỏi danh sách' },
      { name: 'cmd', usage: 'cmd <id> <lệnh>', desc: 'gửi lệnh tới một bot (xem các lệnh bên dưới)' },
      { name: 'cmdall', usage: 'cmdall <lệnh>', desc: 'gửi lệnh tới TẤT CẢ bot đang online' },
      { name: 'ai', usage: 'ai set <api_key> [url] [model] | ai status | ai test | ai off', desc: 'cấu hình khoá API OmniRouter cho trợ lý AI-Anter' },
      { name: 'ai', usage: 'ai <yêu cầu> | Dev: <yêu cầu>', desc: 'nhờ AI-Anter điều khiển dàn bot bằng tiếng Việt (vd: Dev: khởi động 2 bot số 1 và 2)' },
    ],
    bot: [
      { name: 'checkstats', usage: 'checkstats <người chơi>', desc: 'xem stats của người chơi khác: gõ /stats <tên>, đọc GUI, làm sạch tên + lore, bỏ item trang trí' },
      { name: 'autologin', usage: 'autologin on|off|status|now', desc: 'Auto Login & Antibot & Auto Join: tự đăng nhập (/l), vượt GUI antibot, mở /menu và click vào server; now = vào server ngay' },
      { name: 'beggar', usage: 'beggar on|off|status|list|forget <tên>|test <tin>', desc: 'chặn người ăn xin (xin tiền/xin đồ/"em là newbie"): tự gõ /block <tên> một lần cho mỗi người; test = thử một tin nhắn (gõ "begger" cũng được)' },
      { name: 'sessioncheck', usage: 'sessioncheck on|off|status', desc: 'quản lý SessionCheck verify: bật/tắt/xem trạng thái tự vượt anti-bot khi kết nối' },
      { name: 'status', usage: 'status', desc: 'hiện trạng thái bot' },
      { name: 'ping', usage: 'ping', desc: 'hiện ping' },
      { name: 'pos', usage: 'pos', desc: 'hiện toạ độ' },
      { name: 'inv', usage: 'inv', desc: 'xem túi đồ' },
      { name: 'board', usage: 'board', desc: 'xem Board server (Money, Shards, ...)' },
      { name: 'order', usage: 'order raw <số thứ tự>', desc: 'xem chi tiết thô 1 dòng đơn hàng vừa quét' },
      { name: 'tpa', usage: 'tpa', desc: 'TPA tới owner (tự click đồng ý)' },
      { name: 'menu', usage: 'menu', desc: 'gửi lệnh menu thủ công' },
      { name: 'reconnect', usage: 'reconnect', desc: 'ép kết nối lại' },
    ],
  },
  {
    key: 'spawn', title: 'Spawn', desc: 'lồng spawner: tự bán, doanh thu, bảo vệ lồng',
    aliases: ['spawner', 'long', 'lồng', 'sell'],
    con: [
      { name: 'webhook', usage: 'webhook revenue set <url> | test | off', desc: 'webhook RIÊNG cho báo cáo doanh thu autosell_spawn' },
      { name: 'webhook', usage: 'webhook mention <ID|@tên|off> | test', desc: 'tag người nhận ở cuối thông báo kick/hết reconnect/cảnh báo lồng' },
      { name: 'webhook', usage: 'webhook revenue report | every <30m|1h|off>', desc: 'gửi ngay / tự gửi định kỳ báo cáo TỔNG HỢP doanh thu của tất cả bot' },
      { name: 'webhook', usage: 'webhook preview [sự_kiện]', desc: 'gửi mẫu thử toàn bộ (hoặc 1) sự kiện Discord để xem trước bố cục' },
    ],
    bot: [
      { name: 'autosell_spawn', usage: 'autosell_spawn on|off|now|scan|status', desc: 'bật/tắt, chạy 1 vòng ngay, quét lồng quanh bot, xem trạng thái' },
      { name: 'autosell_spawn', usage: 'autosell_spawn every <30s|5m|2h|1h30m>', desc: 'chu kỳ lặp (tối thiểu 5 giây)' },
      { name: 'autosell_spawn', usage: 'autosell_spawn slot <n> [0|1]', desc: 'ô cần click trong GUI (mặc định 51); 0 = chuột trái, 1 = chuột phải' },
      { name: 'autosell_spawn', usage: 'autosell_spawn add|remove <x> <y> <z>', desc: 'thêm/bỏ một lồng theo toạ độ' },
      { name: 'autosell_spawn', usage: '(tự động) bán lỗi → /home treolong → bán lại', desc: 'tối đa 10 lần (config sellFailMaxHome), vẫn lỗi thì báo webhook sự kiện sellFailed có tag' },
      { name: 'autosell_spawn', usage: 'autosell_spawn clear', desc: 'xoá hết danh sách lồng' },
      { name: 'autosell_spawn', usage: 'autosell_spawn revenue [report|reset|on|off|every <30m>]', desc: 'xem/gửi/xoá/bật tắt báo cáo doanh thu, giới hạn tần suất báo cáo' },
      { name: 'autosell_spawn', usage: 'autosell_spawn msg <chữ|off>', desc: 'chỉ tính tin bán có chứa chữ này (nhiều chữ ngăn bằng |)' },
      { name: 'autosell_spawn', usage: 'autosell_spawn ignorechat on|off', desc: 'bỏ qua/tính tin ở kênh chat của người chơi' },
      { name: 'spawnhome', usage: 'spawnhome on|off|now|status', desc: 'tự gõ /home treolong khi bot không còn ở gần lồng (sau đăng nhập và cả khi đang treo); now = gõ ngay, status = xem' },
      { name: 'spawnhome', usage: 'spawnhome cmd </home tên>', desc: 'đổi lệnh về vị trí treo lồng (mặc định /home treolong)' },
      { name: 'spawnerprotect', usage: 'spawnerprotect on|off', desc: 'bảo vệ lồng (bật = tự lưu lồng trong 5 block quanh bot)' },
      { name: 'spawnerprotect', usage: 'spawnerprotect level [1-4]', desc: 'cường độ protect: 1 Nhẹ (chỉ báo) · 2 Cân bằng · 3 Mạnh · 4 Tối đa; bỏ trống = xem mức hiện tại' },
      { name: 'spawnerprotect', usage: 'spawnerprotect set <khoá> <giá trị|auto>', desc: 'chỉnh tay từng thông số (range, scanTicks, threatRadius, explosive, wither, surfaceDig, digThreshold, autoMine, pauseTicks, depositPerTick, timeoutSec…); auto = về theo mức' },
      { name: 'spawnerprotect', usage: 'spawnerprotect status', desc: 'xem toàn bộ thông số đang áp dụng (dấu *chỉnh tay* = khác mức đã chọn)' },
      { name: 'addspawner', usage: 'addspawner [x y z]', desc: 'thêm lồng cần bảo vệ (bỏ trống = vị trí hiện tại)' },
      { name: 'removespawner', usage: 'removespawner <x> <y> <z>', desc: 'bỏ lồng khỏi danh sách bảo vệ' },
      { name: 'listspawners', usage: 'listspawners', desc: 'xem danh sách lồng đang bảo vệ' },
      { name: 'spawneresp', usage: 'spawneresp on|off|status|list|filter BOTH|NATURAL|SMP', desc: 'SpawnerESP: quét/phân loại lồng spawn (tự nhiên vs SMP), lọc hiển thị' },
      { name: 'buyspawner', usage: 'buyspawner [lựa_chọn] [chế_độ] | buyspawner stop', desc: 'TPA tới owner, mở /shard, scan lọc kính, chọn lồng và mua (1 lần hoặc liên tục tới khi hết shard; alias: mualong, tpashard)' },
    ],
  },
  {
    key: 'macro', title: 'Macro', desc: 'chạy macro, lệnh tuỳ chỉnh, autosell túi đầy, mục tiêu tiền',
    aliases: ['macros', 'custom'],
    con: [],
    bot: [
      { name: 'macro', usage: 'macro <tên>', desc: 'chạy macro (chat/delay/winclick/ask/confirm...)' },
      { name: 'stopmacro', usage: 'stopmacro', desc: 'dừng macro đang chạy' },
      { name: 'listmacro', usage: 'listmacro', desc: 'xem danh sách macro (config.json > macros)' },
      { name: 'answer', usage: 'answer <nội dung>', desc: 'trả lời câu hỏi macro đang chờ (ask/askmap/confirm)' },
      { name: 'autoorder', usage: 'autoorder <item> | autoorder off | autoorder status', desc: 'tự /order → chọn đơn giá cao nhất → giao hàng, đếm stack/tiền theo xác nhận của server' },
      { name: 'autosell', usage: 'autosell <%đầy> <macro> | autosell off', desc: 'tự chạy macro khi túi đồ đầy (không có đối số = xem)' },
      { name: 'autosell', usage: 'autosell revenue [report|reset|on|off|every <30m>|keyword <chữ>|ignorechat on|off]', desc: 'doanh thu của auto-sell macro: xem/gửi báo cáo webhook, lọc tin bán' },
      { name: 'goal', usage: 'goal <số> <macro> | goal off', desc: 'tự chạy macro khi tiền đạt mục tiêu (không có đối số = xem)' },
      { name: 'addcmd', usage: 'addcmd <tên> <lệnh MC>', desc: 'thêm lệnh tuỳ chỉnh' },
      { name: 'delcmd', usage: 'delcmd <tên>', desc: 'xoá lệnh tuỳ chỉnh' },
      { name: 'listcmd', usage: 'listcmd', desc: 'xem danh sách lệnh tuỳ chỉnh' },
    ],
  },
  {
    key: 'afk', title: 'AFK', desc: 'treo AFK, shard, stats, tự ăn',
    aliases: ['farm', 'treo'],
    con: [],
    bot: [
      { name: 'shard', usage: 'shard', desc: 'bật/tắt Auto Shard' },
      { name: 'stats', usage: 'stats', desc: 'bật/tắt Auto Stats' },
      { name: 'tshard', usage: 'tshard', desc: 'gửi /warp afk (treo shard)' },
      { name: 'afk', usage: 'afk', desc: 'bật/tắt AFK nhảy' },
      { name: 'wafk', usage: 'wafk', desc: 'bật/tắt AFK đi bộ' },
      { name: 'stop', usage: 'stop', desc: 'dừng AFK' },
      { name: 'autoeat', usage: 'autoeat', desc: 'bật/tắt tự động ăn' },
    ],
  },
  {
    key: 'proxy', title: 'Proxy', desc: 'thêm/xem proxy, tự xoay proxy',
    aliases: ['proxies'],
    con: [
      { name: 'proxy', usage: 'proxy list', desc: 'liệt kê proxy' },
      { name: 'proxy', usage: 'proxy add <proxy>', desc: 'thêm một proxy' },
      { name: 'proxy', usage: 'proxy addfile <đường dẫn .txt>', desc: 'thêm nhiều proxy từ file (mỗi dòng 1 proxy)' },
    ],
    bot: [
      { name: 'proxyrotate', usage: 'proxyrotate on|off', desc: 'tự xoay proxy 1-10 phút/lần (ngẫu nhiên)' },
    ],
  },
  {
    key: 'notify', title: 'Thông báo & Lịch', desc: 'webhook Discord, Telegram, lịch tự out/vào',
    aliases: ['webhook', 'schedule', 'discord', 'lich', 'telegram', 'tg'],
    con: [
      { name: 'webhook', usage: 'webhook set <url>', desc: 'lưu 1 webhook Discord duy nhất (gộp chung cảnh báo, doanh thu & bảng trực tiếp 10s)' },
      { name: 'webhook', usage: 'webhook panel [fresh] | refresh <10s|off> | mode <hybrid|new>', desc: 'cập nhật Bảng Trạng Thái Trực Tiếp tại chỗ / đặt chu kỳ (mặc định 10s) / chế độ chống tràn' },
      { name: 'webhook', usage: 'webhook test | preview [sự_kiện] | off', desc: 'gửi thử kết nối / xem trước mẫu thông báo / tắt webhook' },
      { name: 'webhook', usage: 'webhook events [a,b,c]', desc: 'xem/đặt loại sự kiện được báo' },
      { name: 'webhook', usage: 'webhook mention <ID|@tên|off> | test', desc: 'tag người nhận ở cuối thông báo kick/hết reconnect/cảnh báo lồng (dùng ID số để ping)' },
      { name: 'telegram', usage: 'telegram set <token> [chatId] | chatid | test | off', desc: 'bảng Auto sell spawner + cảnh báo qua Telegram (chatid: tự tìm chat_id sau khi nhắn /start cho bot)' },
      { name: 'telegram', usage: 'telegram panel | every <1s|10s|10m|off> | mode edit|new | events [a,b,c] | commands on|off', desc: 'gửi bảng ngay / nhịp cập nhật (mặc định 1s) / sửa tại chỗ hay tin mới / loại sự kiện / lệnh /status /panel' },
      { name: 'telegram', usage: 'telegram users [add|remove] [admin|viewer] <userId>', desc: 'quản lý quyền admin và viewer điều khiển từ xa qua Telegram' },
      { name: 'telegram', usage: 'telegram mute <30m|1h|off> | control on|off | symbols unicode|ascii', desc: 'tắt tiếng thông báo tạm thời / bật tắt điều khiển từ xa / đổi bộ ký hiệu' },
      { name: 'telegram', usage: 'telegram logs [on|off]', desc: 'log runtime (log của TẤT CẢ bot + khởi động/tắt/lỗi) gửi lên Telegram thành 1 file log_all.txt tự cập nhật tại chỗ (có stats server từng bot ở đầu file); không có đối số = xem trạng thái' },
      { name: 'telegram', usage: 'telegram logs level <all|info|warn|err|a,b,c> | chat on|off | bots <all|id1,id2>', desc: 'lọc theo mức (sys,ok,warn,err,afk,shard,proxy,health,chat) / bật chat người chơi / chỉ bot chỉ định' },
      { name: 'telegram', usage: 'telegram logs every <10s|30s|1m|1h> | keep <n> | now | silent on|off | send [id] [n] | test', desc: 'chu kỳ cập nhật file log (2s–24h) / số dòng mới nhất giữ trong file (50–5000) / cập nhật ngay / tin đầu có rung hay không / gửi thêm file n dòng gần nhất / gửi file thử. Trong Telegram: nút làm mới, /logs now, /logs [id] [n]' },
      { name: 'schedule', usage: 'schedule on <HH:MM out> <HH:MM in>', desc: 'lịch tự out/vào cả dàn bot, vd: schedule on 23:00 06:00' },
      { name: 'schedule', usage: 'schedule off', desc: 'tắt lịch (không có đối số = xem)' },
    ],
    bot: [],
    note: 'Webhook doanh thu riêng của autosell_spawn: gõ  help spawn',
  },
  {
    key: 'system', title: 'Hệ thống & Web', desc: 'bật/tắt web localhost, thông số máy, cập nhật, thoát',
    aliases: ['sys', 'web', 'localhost', 'lochost', 'he thong', 'dash', 'status'],
    con: [
      { name: 'dash', usage: 'dash | status | dash live | dash off', desc: 'hiển thị bảng điều khiển Terminal Dashboard (snapshot hoặc live cập nhật tại chỗ)' },
      { name: 'web', usage: 'web on|off|status', desc: 'bật/tắt web localhost (bot vẫn chạy). Gõ "localhost on|off" cũng được' },
      { name: 'sys', usage: 'sys', desc: 'thông số hệ thống (RAM, CPU, uptime)' },
      { name: 'chatlog', usage: 'chatlog [on|off|smart|player|all|clear|status]', desc: 'bật/tắt chat; smart = gộp tin trùng nhiều bot & ẩn broadcast lặp lại; player = ẩn toàn bộ broadcast server' },
      { name: 'filelog', usage: 'filelog [status|on|off|dir <đường_dẫn>|chat on|off]', desc: 'log runtime ghi ra file (mặc định /sdcard/bot/log/runtime-YYYY-MM-DD.log, tự tạo thư mục & file nếu chưa có)' },
      { name: 'clean', usage: 'clean [now|dry|status|trash|copies [yes]]', desc: 'dọn file rác: file tạm, log quá hạn, backup thừa, file bản cũ đã bị loại bỏ (dry = xem trước, trash = thùng rác giữ 7 ngày). Tự chạy khi khởi động/update' },
      { name: 'update', usage: 'update', desc: 'kiểm tra GitHub, có bản mới thì cập nhật rồi chạy lại (cần chạy bằng npm start)' },
      { name: 'help', usage: 'help | h | ? [phân khu|lệnh|all]', desc: 'trợ giúp theo phân khu' },
      { name: 'exit', usage: 'exit | q | e', desc: 'thoát chương trình' },
    ],
    bot: [],
  },
];

// Danh sách lệnh đăng ký với BotFather / setMyCommands (không có emoji)
const TELEGRAM_BOT_COMMANDS = Object.freeze([
  { command: 'ai', description: 'Ra lệnh cho AI-Anter điều khiển dàn bot bằng tiếng Việt' },
  { command: 'status', description: 'Tổng quan trạng thái và doanh thu cả dàn bot' },
  { command: 'bots', description: 'Danh sách bot và nút mở menu điều khiển' },
  { command: 'panel', description: 'Gửi bảng Auto sell spawner' },
  { command: 'activity', description: 'Xem hoạt động hiện tại và lịch sử gần đây' },
  { command: 'sell', description: 'Bật/tắt/chạy ngay hoặc chỉnh chu kỳ bán lồng' },
  { command: 'sellall', description: 'Bật/tắt/chạy bán lồng cho toàn bộ bot' },
  { command: 'protect', description: 'Cấu hình bảo vệ lồng spawn' },
  { command: 'events', description: 'Bật/tắt và chỉnh âm báo cho từng loại sự kiện' },
  { command: 'mute', description: 'Tắt tiếng thông báo tạm thời (vd 30m, 1h, off)' },
  { command: 'logs', description: 'Cập nhật hoặc tải file log runtime' },
  { command: 'diag', description: 'Chẩn đoán hàng đợi và kết nối Telegram' },
  { command: 'whoami', description: 'Xem User ID, Chat ID và quyền hiện tại' },
  { command: 'help', description: 'Xem hướng dẫn đầy đủ các lệnh Telegram' },
]);

function getTelegramBotCommands() {
  return TELEGRAM_BOT_COMMANDS.map(c => ({ ...c }));
}

const HIDDEN_BOT_CMDS = new Set(['help', 'h', 'autosellspawn', 'begger']);

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim();
const botEntries = (sec, regNames) => sec.bot.filter(e => !regNames || regNames.has(e.name));
const hasScope = (sec, scope, regNames) => (scope === 'bot' ? botEntries(sec, regNames).length > 0 : true);

function resolveSection(q) {
  const n = norm(q);
  if (!n) return null;
  return SECTIONS.find(s => s.key === n || norm(s.title) === n || s.aliases.some(a => norm(a) === n)) || null;
}

const COMMAND_ALIASES = {
  begger: 'beggar',
  autosellspawn: 'autosell_spawn',
  h: 'help',
  '?': 'help',
  ls: 'list',
  add: 'addbot',
  rmbot: 'delbot',
  removebot: 'delbot',
  localhost: 'web',
  lochost: 'web',
  dashboard: 'web',
  tui: 'dash',
  tg: 'telegram',
  system: 'sys',
  logdir: 'filelog',
  cleanup: 'clean',
  don: 'clean',
  omnirouter: 'ai',
  quit: 'exit',
  q: 'exit',
  e: 'exit',
};

function findCommands(q, scope, regNames) {
  let n = norm(q);
  if (COMMAND_ALIASES[n]) n = COMMAND_ALIASES[n];
  const out = [];
  for (const sec of SECTIONS) {
    if (scope === 'console') for (const e of sec.con) if (norm(e.name) === n) out.push({ sec, scope: 'con', e });
    for (const e of botEntries(sec, regNames)) if (norm(e.name) === n) out.push({ sec, scope: 'bot', e });
  }
  return out;
}

function buildHelp({ scope = 'console', query = '', registry = null, customs = [] } = {}) {
  const regNames = registry ? new Set(registry.map(c => c.name.toLowerCase())) : null;
  const known = new Set(SECTIONS.flatMap(s => s.bot.map(e => e.name)));
  const extra = registry
    ? registry.filter(c => !known.has(c.name.toLowerCase()) && !HIDDEN_BOT_CMDS.has(c.name.toLowerCase()))
    : [];
  const lines = [];
  const q = norm(query);

  const sectionLines = sec => {
    const L = [{ t: 'title', text: `${sec.title.toUpperCase()} — ${sec.desc}` }];
    if (scope === 'console') {
      if (sec.con.length) { L.push({ t: 'head', text: 'Gõ ngay ở console:' }); sec.con.forEach(e => L.push({ t: 'cmd', usage: e.usage, desc: e.desc })); }
      const b = botEntries(sec, regNames);
      if (b.length) { L.push({ t: 'head', text: 'Gửi cho bot — gõ  cmd <id> <lệnh>  (hoặc  cmdall <lệnh>):' }); b.forEach(e => L.push({ t: 'cmd', usage: e.usage, desc: e.desc })); }
    } else {
      botEntries(sec, regNames).forEach(e => L.push({ t: 'cmd', usage: e.usage, desc: e.desc }));
    }
    if (sec.note) L.push({ t: 'note', text: sec.note });
    return L;
  };
  const extraLines = () => [{ t: 'title', text: 'KHÁC — lệnh chưa xếp phân khu' }, ...extra.map(c => ({ t: 'cmd', usage: c.name, desc: c.desc }))];
  const customLines = () => [{ t: 'title', text: `LỆNH TUỲ CHỈNH (${customs.length})` }, ...customs.map(c => ({ t: 'cmd', usage: c.name, desc: '→ ' + c.cmd }))];

  const menuSecs = SECTIONS.filter(s => hasScope(s, scope, regNames));

  if (!q) {
    lines.push({ t: 'title', text: scope === 'console' ? 'TRỢ GIÚP — chọn phân khu' : 'LỆNH CỦA BOT — chọn phân khu' });
    for (const s of menuSecs) lines.push({ t: 'menu', key: s.key, text: `${s.title} — ${s.desc}` });
    if (scope === 'bot' && extra.length) lines.push({ t: 'menu', key: 'khac', text: `Khác — ${extra.length} lệnh chưa xếp phân khu` });
    if (scope === 'bot' && customs.length) lines.push({ t: 'menu', key: 'custom', text: `Lệnh tuỳ chỉnh — ${customs.length} lệnh (addcmd)` });
    lines.push({ t: 'menu', key: 'all', text: 'Xem tất cả phân khu' });
    lines.push({ t: 'note', text: scope === 'console'
      ? 'Gõ  help <phân khu>  hoặc  help <lệnh>   vd: help spawn · help addbot'
      : 'Gõ  help <phân khu>  hoặc  help <lệnh>   vd: help spawn · help autosell_spawn' });
    if (scope === 'bot') lines.push({ t: 'note', text: 'Lệnh console (list/start/addbot/web...): gõ  help  ở console, không qua cmd' });
    return { found: true, lines };
  }

  if (q === 'all' || q === 'tat ca') {
    menuSecs.forEach((s, i) => { if (i) lines.push({ t: 'gap' }); lines.push(...sectionLines(s)); });
    if (scope === 'bot' && extra.length) { lines.push({ t: 'gap' }); lines.push(...extraLines()); }
    if (scope === 'bot' && customs.length) { lines.push({ t: 'gap' }); lines.push(...customLines()); }
    return { found: true, lines };
  }

  if (q === 'khac' || q === 'other') {
    if (!extra.length) return { found: true, lines: [{ t: 'note', text: 'Không có lệnh nào ngoài các phân khu.' }] };
    return { found: true, lines: extraLines() };
  }
  if (scope === 'bot' && (q === 'custom' || q === 'tuy chinh')) {
    return { found: true, lines: customs.length ? customLines() : [{ t: 'note', text: 'Chưa có lệnh tuỳ chỉnh nào (thêm bằng: addcmd <tên> <lệnh MC>)' }] };
  }

  const sec = resolveSection(q);
  if (sec && hasScope(sec, scope, regNames)) return { found: true, lines: sectionLines(sec) };
  if (sec) {
    return { found: true, lines: [{ t: 'warn', text: `Phân khu "${sec.title}" chỉ có lệnh ở console — gõ  help ${sec.key}  ở console (không qua cmd).` }] };
  }

  const cmds = findCommands(q, scope, regNames);
  if (cmds.length) {
    const L = [];
    const seen = new Set();
    for (const c of cmds) {
      if (!seen.has(c.sec.key)) {
        seen.add(c.sec.key);
        L.push({ t: 'title', text: `${query.toLowerCase()} — phân khu ${c.sec.title} (help ${c.sec.key})` });
      }
      L.push({ t: 'cmd', usage: c.e.usage, desc: c.e.desc + (scope === 'console' && c.scope === 'bot' ? '  [gõ: cmd <id> ...]' : '') });
    }
    return { found: true, lines: L };
  }
  const x = extra.find(c => c.name.toLowerCase() === q);
  if (x) return { found: true, lines: [{ t: 'title', text: x.name }, { t: 'cmd', usage: x.name, desc: x.desc }] };

  const keys = menuSecs.map(s => s.key).join(', ');
  return { found: false, lines: [{ t: 'warn', text: `Không có phân khu hay lệnh "${query}". Phân khu: ${keys}, all` }] };
}

module.exports = {
  SECTIONS,
  HIDDEN_BOT_CMDS,
  TELEGRAM_BOT_COMMANDS,
  getTelegramBotCommands,
  buildHelp,
  resolveSection,
  findCommands,
  norm,
};
