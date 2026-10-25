'use strict';
/**
 * StatsReader — đọc dữ liệu stats và kinh tế (/stats & /bal) từ KingMC / Essentials.
 * Port & nâng cấp từ CheckStatsKingMC (mc-bot.js + commands/stats.js + commands/bal.js + helpers/utils.js).
 *
 * Tính năng:
 * 1. Đọc GUI /stats <người chơi>:
 *    - Bóc tách chỉ số: Kills, Deaths, Played Time, Mob Kills, Blocks Mined, Shards, Money, Animals Breed...
 *    - Làm sạch mã màu (§/&), xử lý chuẩn xác phông chữ Small Caps độc lạ của KingMC.
 *    - Bỏ qua vật phẩm trang trí (kính, barrier, air...).
 * 2. Đọc số dư /bal <người chơi>:
 *    - Gửi lệnh /bal <người chơi>, phân tích regex tin nhắn chat phản hồi từ server KingMC / Essentials.
 *    - Bóc tách số tiền, dạng chuẩn hóa ($1,250,000 / 1.5M / Xu...) và giá trị số thực.
 * 3. Tích hợp từ điển Việt hoá vật phẩm (dựa trên minecraft_lang_vi.json) và nhãn hiển thị thân thiện.
 *
 * Dùng:
 *   const stats = await session.statsReader.request('Steve');
 *   const bal   = await session.statsReader.requestBal('Steve');
 */
const { dbg } = require('./debug');
const { nbtSimplify, sleep, nowMs } = require('./utils');

const LATE_WINDOW_MS = 4000;

// ── 1. Chuẩn hoá văn bản & Small Caps Unicode của KingMC ──────────────────────

/** Bỏ mã màu §/&, hex §x§r§r..., &#RRGGBB, ký tự vô hình. Port từ cleanMinecraftText. */
function cleanMinecraftText(text) {
  if (!text) return '';
  return String(text)
    .replace(/§x(§[0-9a-f]){6}/gi, '')
    .replace(/&x(&[0-9a-f]){6}/gi, '')
    .replace(/&#[0-9a-f]{6}/gi, '')
    .replace(/§#[0-9a-f]{6}/gi, '')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/&[0-9a-fk-or]/gi, '')
    .replace(/§./g, '')
    .replace(/[\u00A0\u200B\u200C\u200D\u2060\uFEFF]/g, ' ')
    .normalize('NFC')
    .trim();
}

// Bảng ánh xạ toàn diện ký tự Small Caps từ KingMC sang chữ hoa ASCII tiêu chuẩn
const SMALL_CAPS = {
  '\u1D00': 'A', // ᴀ
  '\u0299': 'B', // ʙ
  '\u1D04': 'C', // ᴄ
  '\u1D05': 'D', // ᴅ
  '\u1D07': 'E', // ᴇ
  '\uA730': 'F', '\u0493': 'F', // ғ
  '\u0262': 'G', // ɢ
  '\u029C': 'H', // ʜ
  '\u026A': 'I', '\u0196': 'I', '\uA7AE': 'I', // ɪ, Ɪ
  '\u1D0A': 'J', // ᴊ
  '\u1D0B': 'K', // ᴋ
  '\u029F': 'L', // ʟ
  '\u1D0D': 'M', // ᴍ
  '\u0274': 'N', // ɴ
  '\u1D0F': 'O', // ᴏ
  '\u1D18': 'P', // ᴘ
  '\u01EB': 'Q', '\uA7AF': 'Q', // ǫ
  '\u0280': 'R', '\u01A6': 'R', // ʀ, Ʀ
  '\uA731': 'S', // ꜱ
  '\u1D1B': 'T', // ᴛ
  '\u1D1C': 'U', // ᴜ
  '\u1D20': 'V', // ᴠ
  '\u1D21': 'W', // ᴡ
  'x': 'X',
  '\u028F': 'Y', // ʏ
  '\u1D22': 'Z', // ᴢ
  '\u0111': 'D', '\u0110': 'D', // đ, Đ
};
const SMALL_CAPS_RE = new RegExp('[' + Object.keys(SMALL_CAPS).join('') + ']', 'gu');

/**
 * Chuyển đổi phông chữ Small Caps sang chữ in hoa chuẩn ASCII (Kiểu 1).
 * Ví dụ: ᴍᴏɴᴇʏ -> MONEY, ꜱʜᴀƦᴅꜱ -> SHARDS, ᴋꞮʟʟꜱ -> KILLS, ᴀɴꞮᴍᴀʟꜱ ʙƦᴇᴇᴅ -> ANIMALS BREED
 */
function smallCapsToUpper(str) {
  if (!str) return '';
  return String(str).replace(SMALL_CAPS_RE, m => SMALL_CAPS[m] || m).toUpperCase().trim();
}

/**
 * Chuẩn hoá Small Caps về chữ thường không dấu (để so sánh từ khoá an toàn).
 */
function normalizeSmallCaps(str) {
  if (!str) return '';
  return String(str)
    .replace(SMALL_CAPS_RE, m => SMALL_CAPS[m] || m)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// ── 2. Từ điển vật phẩm & Nhãn thân thiện Tiếng Việt ─────────────────────────

// Ánh xạ tên vật phẩm sang Tiếng Việt (trích xuất từ minecraft_lang_vi.json của CheckStatsKingMC)
const ITEM_NAMES_VI = {
  "emerald": "Ngọc lục bảo",
  "diamond": "Kim cương",
  "gold_ingot": "Phôi vàng",
  "iron_ingot": "Phôi sắt",
  "copper_ingot": "Phôi đồng",
  "netherite_ingot": "Phôi Netherit",
  "netherite_scrap": "Vụn Netherit",
  "coal": "Than",
  "charcoal": "Than gỗ",
  "lapis_lazuli": "Ngọc lưu ly",
  "redstone": "Bột Redstone",
  "quartz": "Thạch anh Nether",
  "amethyst_shard": "Mảnh thạch anh tím",
  "echo_shard": "Mảnh vỡ âm vang",
  "nether_star": "Sao Nether",
  "diamond_sword": "Kiếm kim cương",
  "netherite_sword": "Kiếm Netherit",
  "iron_sword": "Kiếm sắt",
  "golden_sword": "Kiếm vàng",
  "stone_sword": "Kiếm đá",
  "wooden_sword": "Kiếm gỗ",
  "diamond_pickaxe": "Cuốc chim kim cương",
  "netherite_pickaxe": "Cuốc chim Netherit",
  "iron_pickaxe": "Cuốc chim sắt",
  "golden_pickaxe": "Cuốc chim vàng",
  "stone_pickaxe": "Cuốc chim đá",
  "wooden_pickaxe": "Cuốc chim gỗ",
  "diamond_axe": "Rìu kim cương",
  "netherite_axe": "Rìu Netherit",
  "iron_axe": "Rìu sắt",
  "golden_axe": "Rìu vàng",
  "stone_axe": "Rìu đá",
  "wooden_axe": "Rìu gỗ",
  "diamond_shovel": "Xẻng kim cương",
  "netherite_shovel": "Xẻng Netherit",
  "iron_shovel": "Xẻng sắt",
  "golden_shovel": "Xẻng vàng",
  "stone_shovel": "Xẻng đá",
  "wooden_shovel": "Xẻng gỗ",
  "diamond_hoe": "Cuốc kim cương",
  "netherite_hoe": "Cuốc Netherit",
  "iron_hoe": "Cuốc sắt",
  "golden_hoe": "Cuốc vàng",
  "stone_hoe": "Cuốc đá",
  "wooden_hoe": "Cuốc gỗ",
  "bow": "Cung",
  "crossbow": "Cây nỏ",
  "arrow": "Mũi tên",
  "spectral_arrow": "Mũi tên ma quỷ",
  "tipped_arrow": "Mũi tên tẩm thuốc",
  "trident": "Đinh ba",
  "shield": "Khiên",
  "netherite_helmet": "Mũ cối Netherit",
  "netherite_chestplate": "Áo giáp Netherit",
  "netherite_leggings": "Quần giáp Netherit",
  "netherite_boots": "Ủng Netherit",
  "diamond_helmet": "Mũ cối kim cương",
  "diamond_chestplate": "Áo giáp kim cương",
  "diamond_leggings": "Quần giáp kim cương",
  "diamond_boots": "Ủng kim cương",
  "iron_helmet": "Mũ cối sắt",
  "iron_chestplate": "Áo giáp sắt",
  "iron_leggings": "Quần giáp sắt",
  "iron_boots": "Ủng sắt",
  "golden_helmet": "Mũ cối vàng",
  "golden_chestplate": "Áo giáp vàng",
  "golden_leggings": "Quần giáp vàng",
  "golden_boots": "Ủng vàng",
  "chainmail_helmet": "Mũ cối xích",
  "chainmail_chestplate": "Áo giáp xích",
  "chainmail_leggings": "Quần giáp xích",
  "chainmail_boots": "Ủng xích",
  "leather_helmet": "Mũ da",
  "leather_chestplate": "Áo da",
  "leather_leggings": "Quần da",
  "leather_boots": "Ủng da",
  "elytra": "Cánh cứng",
  "totem_of_undying": "Vật tổ trường sinh",
  "clock": "Đồng hồ",
  "compass": "La bàn",
  "recovery_compass": "La bàn phục hồi",
  "spyglass": "Kính viễn vọng",
  "bell": "Chuông",
  "name_tag": "Thẻ tên",
  "lead": "Dây buộc",
  "player_head": "Đầu người chơi",
  "skeleton_skull": "Đầu lâu Skeleton",
  "wither_skeleton_skull": "Đầu lâu Wither Skeleton",
  "zombie_head": "Đầu Zombie",
  "creeper_head": "Đầu Creeper",
  "dragon_head": "Đầu rồng",
  "piglin_head": "Đầu Piglin",
  "book": "Sách",
  "enchanted_book": "Sách phù phép",
  "writable_book": "Sách và bút lông",
  "written_book": "Sách đã viết",
  "paper": "Giấy",
  "map": "Bản đồ trống",
  "filled_map": "Bản đồ",
  "golden_apple": "Táo vàng",
  "enchanted_golden_apple": "Táo vàng phù phép",
  "golden_carrot": "Cà rốt vàng",
  "apple": "Táo",
  "bread": "Bánh mì",
  "cooked_beef": "Bít tết",
  "cooked_porkchop": "Thịt lợn chín",
  "cooked_mutton": "Thịt cừu chín",
  "cooked_chicken": "Thịt gà chín",
  "wheat": "Lúa mì",
  "carrot": "Cà rốt",
  "potato": "Khoai tây",
  "baked_potato": "Khoai tây nướng",
  "beetroot": "Củ dền",
  "melon_slice": "Lát dưa hấu",
  "pumpkin": "Bí ngô",
  "bone": "Xương",
  "bone_meal": "Bột xương",
  "egg": "Trứng",
  "feather": "Lông gà",
  "leather": "Da thuộc",
  "string": "Dây tơ",
  "gunpowder": "Thuốc súng",
  "slime_ball": "Quả cầu chất dính",
  "magma_cream": "Kem dung nham",
  "blaze_rod": "Que quỷ lửa",
  "blaze_powder": "Bột quỷ lửa",
  "ender_pearl": "Ngọc Ender",
  "ender_eye": "Mắt Ender",
  "shulker_shell": "Vỏ Shulker",
  "experience_bottle": "Chai kinh nghiệm",
  "firework_rocket": "Pháo hoa",
  "spawner": "Lồng quái",
  "beacon": "Đèn hiệu",
  "conduit": "Vật dẫn",
  "chest": "Rương",
  "trapped_chest": "Rương bẫy",
  "ender_chest": "Rương Ender",
  "barrel": "Thùng gỗ",
  "shulker_box": "Hộp Shulker",
  "hopper": "Phễu",
  "dispenser": "Máy phân phát",
  "dropper": "Máy thả",
  "furnace": "Lò nung",
  "blast_furnace": "Lò luyện kim",
  "smoker": "Lò hun khói",
  "crafting_table": "Bàn chế tạo",
  "anvil": "Cái đe",
  "enchanting_table": "Bàn phù phép",
  "brewing_stand": "Giàn pha thuốc",
  "cauldron": "Vạc",
  "grass_block": "Khối cỏ",
  "dirt": "Đất",
  "stone": "Đá",
  "cobblestone": "Đá cuội",
  "deepslate": "Đá phiến sâu",
  "cobbled_deepslate": "Đá phiến sâu cuội",
  "obsidian": "Hắc diện thạch",
  "crying_obsidian": "Hắc diện thạch rỉ lệ",
  "bedrock": "Đá nền",
  "sand": "Cát",
  "red_sand": "Cát đỏ",
  "gravel": "Sỏi",
  "glass": "Thuỷ tinh",
  "tinted_glass": "Thuỷ tinh che sáng",
  "tnt": "Thuốc nổ TNT",
  "sponge": "Miếng bọt biển",
  "wet_sponge": "Miếng bọt biển ướt",
  "sea_lantern": "Đèn biển",
  "glowstone": "Đá phát sáng",
  "shroomlight": "Nấm sáng",
  "redstone_lamp": "Đèn Redstone",
  "target": "Bia tập bắn",
  "hay_block": "Kiện cỏ khô",
  "honey_block": "Khối mật ong",
  "slime_block": "Khối chất dính",
  "ice": "Băng",
  "packed_ice": "Băng chặt",
  "blue_ice": "Băng xanh",
  "snow_block": "Khối tuyết",
  "snowball": "Quả tuyết",
};

/** Định dạng tên vật phẩm Minecraft (vd: iron_chestplate -> Iron Chestplate). Port từ utils.js. */
function formatItemName(name) {
  if (!name) return 'Unknown';
  return String(name)
    .replace(/^minecraft:/i, '')
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Lấy tên tiếng Việt của item từ ID (VD: diamond_sword -> Kiếm kim cương). Port từ itemHelper.js. */
function getVietnameseName(itemName, fallbackName = '') {
  if (!itemName) return fallbackName;
  const clean = String(itemName).toLowerCase().replace(/^minecraft:/i, '').trim();
  return ITEM_NAMES_VI[clean] || fallbackName || formatItemName(clean);
}

// Bảng nhãn thân thiện tiếng Việt cho từng nhóm stats
const STATS_LABELS_VI = {
  'Tài chính': 'Tài chính',
  'Shards': 'Shards (Sao)',
  'Kills': 'Hạ gục (PvP)',
  'Mob Kills': 'Quái đã diệt',
  'Deaths': 'Số lần chết',
  'Thời gian chơi': 'Thời gian chơi',
  'Blocks Mined': 'Khối đã đào',
  'Blocks Placed': 'Khối đã đặt',
  'Animals Breed': 'Nhân giống thú',
  'Shop Buy': 'Mua từ Shop',
  'Shop Sell': 'Bán cho Shop',
  'Rank/Cấp độ': 'Hạng / Cấp độ',
};

function getStatsLabelVi(label) {
  return STATS_LABELS_VI[label] || label;
}

// ── 3. Phân loại chỉ số GUI KingMC (/stats) ──────────────────────────────────

/**
 * Nhận diện nhóm chỉ số dựa trên tên hiển thị và ID vật phẩm.
 * Hoàn thiện đọc đúng các chỉ số: Kills, Deaths, Played Time, Mob Kills, Blocks Mined, Shards, Money, Animals Breed...
 */
function statsLabel(item) {
  const d = cleanMinecraftText(item?.displayName || '')
    .replace(SMALL_CAPS_RE, m => (m === '\u0111' || m === '\u0110') ? m : SMALL_CAPS[m])
    .toLowerCase();
  const n = String(item?.name || '').toLowerCase();

  // Ưu tiên khớp nhóm theo từ khoá chính xác trước
  if (/tiền|\bxu\b|money|coin|balance/.test(d) || (!d && n === 'emerald')) return 'Tài chính';
  if (/shard|ngôi sao|\bsao\b|★/.test(d) || (!d && (n === 'amethyst_shard' || n === 'nether_star'))) return 'Shards';
  if (/mob\s*kill|quái|quai/.test(d) || (!d && (n === 'zombie_head' || n === 'creeper_head'))) return 'Mob Kills';
  if (/kill|giết|hạ gục/.test(d) || (!d && n.includes('sword'))) return 'Kills';
  if (/death|chết|bị giết/.test(d) || (!d && n.includes('skull'))) return 'Deaths';
  if (/thời gian|time|giờ|playtime|played/.test(d) || (!d && (n === 'clock' || n === 'compass'))) return 'Thời gian chơi';
  if (/block.*mine|đào|mined/.test(d) || (!d && n.includes('pickaxe'))) return 'Blocks Mined';
  if (/block.*place|đặt|placed/.test(d)) return 'Blocks Placed';
  if (/animal.*breed|breed|nhân giống|thú/.test(d) || (!d && (n === 'wheat' || n === 'lead'))) return 'Animals Breed';
  if (/shop.*buy|mua\s*shop/.test(d)) return 'Shop Buy';
  if (/shop.*sell|bán\s*shop/.test(d)) return 'Shop Sell';
  if (/rank|danh hiệu|cấp|level/.test(d)) return 'Rank/Cấp độ';

  return cleanMinecraftText(item?.displayName || '') || 'Thông tin';
}

/** Item trang trí không mang dữ liệu stats (kính viền, barrier, ô rỗng...). Port từ isDecorationItem. */
function isDecorationItem(item) {
  const n = String(item?.name || '').toLowerCase();
  const d = cleanMinecraftText(item?.displayName || '');
  if (n.includes('glass_pane') || n === 'air' || n === 'barrier') return true;
  if (!d) return true;
  if ((!item?.lore || !item.lore.length) && (n.includes('pane') || n.includes('stained'))) return true;
  return false;
}

/** Lọc dòng lore: bỏ dòng kẻ ngang, dòng hướng dẫn click chuột. Port từ commands/stats.js. */
function cleanLoreLines(lore) {
  return (lore || [])
    .map(cleanMinecraftText)
    .filter(line => {
      if (!line) return false;
      if (/^[_\-+=*~#\s]*$/.test(line)) return false;
      if (line.includes('------') || line.includes('======') || line.includes('______')) return false;
      const l = line.toLowerCase();
      return !(l.includes('nhấp') || l.includes('click') || l.includes('bấm để'));
    });
}

/** Component / NBT / chuỗi JSON → chữ thường (đệ quy). Port từ parseMinecraftJSON. */
function componentText(x, depth = 0) {
  if (x === null || x === undefined || depth > 12) return '';
  const t = typeof x;
  if (t === 'number' || t === 'boolean') return String(x);
  if (t === 'string') {
    const s = x.trim();
    if (s[0] === '{' || s[0] === '[') {
      try { return componentText(JSON.parse(s), depth + 1); } catch { /* không phải JSON — giữ chuỗi */ }
    }
    return s.replace(/\{"color".*?\}/gi, '').trim();
  }
  if (Array.isArray(x)) return x.map(i => componentText(i, depth + 1)).join('');
  if (t === 'object') {
    if (typeof x.type === 'string' && 'value' in x) {
      if (x.type === 'compound' || x.type === 'list') return componentText(nbtSimplify(x), depth + 1);
      return componentText(x.value, depth + 1);
    }
    let out = '';
    if (x[''] !== undefined) out += componentText(x[''], depth + 1);
    if (x.text !== undefined) out += componentText(x.text, depth + 1);
    if (x.translate !== undefined && x.text === undefined) out += componentText(x.translate, depth + 1);
    if (x.extra !== undefined) out += componentText(x.extra, depth + 1);
    return out.trim();
  }
  return '';
}

/** Lore nằm trong NBT cũ (display.Lore) hoặc component mới (minecraft:lore / lore). */
function loreFromNbt(nbt) {
  if (!nbt) return [];
  const root = nbt.value || nbt;
  let raw = null;
  if (root.display) {
    const d = root.display.value || root.display;
    if (d) raw = d.lore || d.Lore;
  }
  if (!raw && root['minecraft:lore']) raw = root['minecraft:lore'];
  if (!raw && root.lore) raw = root.lore;
  if (!raw) return [];
  let lines = raw.value !== undefined ? raw.value : raw;
  if (lines && lines.value !== undefined) lines = lines.value;
  if (typeof lines === 'string') lines = [lines];
  if (!Array.isArray(lines)) return [];
  return lines.map(l => componentText(l && typeof l === 'object' && l.value !== undefined ? l.value : l)).filter(Boolean);
}

/** Một ô mineflayer → bản ghi thô { slot, name, displayName, lore[] } */
function rawEntry(it, slot) {
  const name = it.name || '';
  const displayName = componentText(it.customName || it.displayName || '');
  let lore = [];
  try {
    if (it.customLore) lore = (Array.isArray(it.customLore) ? it.customLore : [it.customLore]).map(l => componentText(l));
    else lore = loreFromNbt(it.nbt);
  } catch (e) { dbg('StatsReader', e); }
  return { slot, name, displayName, lore: lore.filter(Boolean) };
}

/** Quét phần container của cửa sổ → danh sách bản ghi thô. */
function scanWindow(win) {
  const out = [];
  if (!win?.slots) return out;
  const lim = Number.isInteger(win.inventoryStart) ? win.inventoryStart : win.slots.length;
  for (let i = 0; i < lim; i++) {
    const it = win.slots[i];
    if (it) out.push(rawEntry(it, i));
  }
  return out;
}

/** Bản ghi thô → mục stats đã làm sạch, bỏ trang trí, gắn nhãn tiếng Việt. */
function buildItems(raws) {
  const items = [];
  for (const r of raws) {
    if (isDecorationItem(r)) continue;
    const lines = cleanLoreLines(r.lore);
    if (!lines.length) continue;
    const label = statsLabel(r);
    const labelVi = getStatsLabelVi(label);
    const title = smallCapsToUpper(cleanMinecraftText(r.displayName)) || label.toUpperCase();
    const itemNameVi = getVietnameseName(r.name);
    items.push({
      slot: r.slot,
      name: r.name,
      label,
      labelVi,
      title,
      itemNameVi,
      lore: lines,
      value: lines.join(', ')
    });
  }
  return items;
}
const formatLine = it => `${it.title} | ${it.value}`;

// ── 4. Phân tích số dư /bal từ tin nhắn chat ─────────────────────────────────

// Các mẫu regex số dư của KingMC và Essentials
const BALANCE_REGEXES = [
  // 1. "Số dư của <player>: <tiền>" hoặc "Số dư của <player> là <tiền>"
  /(?:số\s*dư\s*của|so\s*du\s*cua)\s+([A-Za-z0-9_.*]{1,32})\s*(?:là|:)\s*([$¥€£]?\s*[\d,._KMkmBbTt]+(?:\s*(?:xu|\$|coins?|đồng))?)/i,
  // 2. "Balance of <player>: <tiền>" hoặc "Balance of <player> is <tiền>"
  /(?:balance\s*of)\s+([A-Za-z0-9_.*]{1,32})\s*(?:is|:)\s*([$¥€£]?\s*[\d,._KMkmBbTt]+(?:\s*(?:xu|\$|coins?))?)/i,
  // 3. "<player>'s balance: <tiền>"
  /([A-Za-z0-9_.*]{1,32})['’]s\s*balance\s*(?:is|:)\s*([$¥€£]?\s*[\d,._KMkmBbTt]+(?:\s*(?:xu|\$|coins?))?)/i,
  // 4. "<player> có <tiền>" (CheckStatsKingMC mc-bot.js pattern)
  /([A-Za-z0-9_.*]{1,32})\s+(?:hiện\s+)?có\s+([$¥€£]\s*[\d,._KMkmBbTt]+(?:\s*(?:xu|\$))?)/i,
  // 5. "Số dư: <tiền>" hoặc "Balance: <tiền>" (khi xem số dư chính mình hoặc dạng ngắn gọn)
  /(?:số\s*dư|balance)\s*:\s*([$¥€£]?\s*[\d,._KMkmBbTt]+(?:\s*(?:xu|\$|coins?))?)/i,
];

/** Chuyển đổi chuỗi số tiền ($1,250,000 / 1.5M / 50K) thành số thực. */
function parseMoneyAmount(str) {
  if (!str) return 0;
  let s = String(str).replace(/[$¥€£,]/g, '').trim().toLowerCase();
  let mult = 1;
  if (s.endsWith('k')) { mult = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1e6; s = s.slice(0, -1); }
  else if (s.endsWith('b')) { mult = 1e9; s = s.slice(0, -1); }
  else if (s.endsWith('t')) { mult = 1e12; s = s.slice(0, -1); }
  s = s.replace(/[^0-9.]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n * mult;
}

/**
 * Phân tích tin nhắn chat để trích xuất số dư của người chơi.
 * @param {string} text - Tin nhắn thô hoặc đã làm sạch
 * @param {string} [targetPlayer] - Người chơi đang truy vấn (nếu có để lọc tin nhắn đúng chủ)
 * @returns {{ player: string, balance: string, amount: number, raw: string } | null}
 */
function parseBalanceMessage(text, targetPlayer = '') {
  const clean = cleanMinecraftText(text);
  if (!clean) return null;
  // Bỏ qua tin nhắn chat của người chơi thông thường: <Player> tin_nhắn
  if (/^<[^>]+>/.test(clean)) return null;

  for (const re of BALANCE_REGEXES) {
    const m = clean.match(re);
    if (!m) continue;
    let player = targetPlayer;
    let balanceStr = '';

    if (m.length === 3) {
      const foundPlayer = m[1].trim();
      balanceStr = m[2].trim();
      if (targetPlayer && foundPlayer.toLowerCase() !== targetPlayer.toLowerCase()) {
        continue; // Tin nhắn số dư của người chơi khác
      }
      player = foundPlayer;
    } else if (m.length === 2) {
      balanceStr = m[1].trim();
    }

    if (!balanceStr) continue;
    // Làm sạch dấu chấm câu cuối câu
    balanceStr = balanceStr.replace(/\.$/, '').trim();

    return {
      player: player || targetPlayer || '',
      balance: balanceStr,
      amount: parseMoneyAmount(balanceStr),
      raw: clean,
    };
  }
  return null;
}

/** Tin chat báo không có người chơi / chưa từng đăng nhập */
function isNotFoundMessage(text, player) {
  const t = cleanMinecraftText(text || '').toLowerCase();
  if (player && !t.includes(String(player).toLowerCase())) return false;
  return /không tìm thấy|khong tim thay|not found|never joined|chưa từng|chua tung|không tồn tại|khong ton tai|unknown player/.test(t);
}

// ── 5. Class StatsReader ───────────────────────────────────────────────────────

class StatsReader {
  /** @param {import('./BotSession')} session */
  constructor(session) {
    this.s = session;
    this._p = null;    // { player, resolve, reject, timer, startedAt, win } (yêu cầu GUI /stats)
    this._pBal = null; // { player, resolve, reject, timer, startedAt } (yêu cầu chat /bal)
    this._lateUntil = 0; // thời gian chặn GUI trễ sau timeout
  }

  get pending() { return !!this._p; }
  get pendingBal() { return !!this._pBal; }

  /**
   * Gõ /stats <player> và đọc GUI stats.
   * @param {string} player
   * @param {number} [timeoutMs=15000]
   * @returns {Promise<{player:string, title:string, items:object[], lines:string[]}>}
   */
  request(player, timeoutMs = 15000) {
    const s = this.s;
    const name = String(player || '').trim();
    if (!/^[A-Za-z0-9_.*]{1,32}$/.test(name)) return Promise.reject(new Error('Tên người chơi không hợp lệ'));
    if (!s.isOnline || !s.mc) return Promise.reject(new Error('Bot chưa online'));
    if (this._p) return Promise.reject(new Error('Đang xử lý một yêu cầu stats khác'));
    if (s._isBusy) return Promise.reject(new Error('Bot đang bận (macro / bảo vệ lồng / đăng nhập) — thử lại sau'));
    if (nowMs() < this._lateUntil) return Promise.reject(new Error('Yêu cầu stats trước vừa timeout — đợi vài giây rồi thử lại'));
    return new Promise((resolve, reject) => {
      const p = { player: name, resolve, reject, timer: null, startedAt: nowMs(), win: null };
      p.timer = setTimeout(() => {
        if (this._p !== p) return;
        this._lateUntil = nowMs() + LATE_WINDOW_MS;
        this._finish(new Error(`Timeout: không mở được bảng stats sau ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this._p = p;
      try { s.mc.chat(`/stats ${name}`); } catch (e) { this._finish(e); }
    });
  }

  /**
   * Gõ /bal <player> và đọc số dư từ tin nhắn chat.
   * @param {string} player
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<{player:string, balance:string, amount:number, raw:string}>}
   */
  requestBal(player, timeoutMs = 10000) {
    const s = this.s;
    const name = String(player || '').trim();
    if (!/^[A-Za-z0-9_.*]{1,32}$/.test(name)) return Promise.reject(new Error('Tên người chơi không hợp lệ'));
    if (!s.isOnline || !s.mc) return Promise.reject(new Error('Bot chưa online'));
    if (this._pBal) return Promise.reject(new Error('Đang xử lý một yêu cầu balance khác'));
    if (s._isBusy) return Promise.reject(new Error('Bot đang bận (macro / bảo vệ lồng / đăng nhập) — thử lại sau'));
    return new Promise((resolve, reject) => {
      const p = { player: name, resolve, reject, timer: null, startedAt: nowMs() };
      p.timer = setTimeout(() => {
        if (this._pBal !== p) return;
        this._finishBal(new Error(`Timeout: không nhận được số dư sau ${Math.round(timeoutMs / 1000)}s`), undefined, p);
      }, timeoutMs);
      this._pBal = p;
      try { s.mc.chat(`/bal ${name}`); } catch (e) { this._finishBal(e, undefined, p); }
    });
  }

  _finish(err, value, owner) {
    const p = this._p;
    if (!p || (owner && owner !== p)) return;
    this._p = null;
    clearTimeout(p.timer);
    if (err) p.reject(err); else p.resolve(value);
  }

  _finishBal(err, value, owner) {
    const p = this._pBal;
    if (!p || (owner && owner !== p)) return;
    this._pBal = null;
    clearTimeout(p.timer);
    if (err) p.reject(err); else p.resolve(value);
  }

  /** Gọi từ handler windowOpen. @returns {boolean} true = đã nhận cửa sổ này */
  handleWindow(win) {
    const p = this._p;
    if (!p) {
      if (nowMs() < this._lateUntil) {
        this._lateUntil = 0;
        try { this.s.mc?.closeWindow(win); } catch (e) { dbg('StatsReader', e); }
        return true;
      }
      return false;
    }
    if (p.win) return false;
    p.win = win;
    this._read(win, p).catch(e => this._finish(e, undefined, p));
    return true;
  }

  async _read(win, p) {
    const title = componentText(win.title || '');
    let raws = [];
    for (let i = 0; i < 12; i++) {
      if (this._p !== p) return;
      raws = scanWindow(win);
      if (raws.length) { await sleep(150); raws = scanWindow(win); break; }
      await sleep(250);
    }
    if (this._p !== p) return;
    try { this.s.mc?.closeWindow(win); } catch (e) { dbg('StatsReader', e); }
    const items = buildItems(raws);
    if (!items.length) {
      return this._finish(new Error('Không có stats hữu ích (người chơi chưa từng đăng nhập hoặc GUI rỗng)'), undefined, p);
    }
    this._finish(null, { player: p.player, title: cleanMinecraftText(title), items, lines: items.map(formatLine) }, p);
  }

  /**
   * Nhận tin nhắn chat phản hồi về /bal từ server.
   * @param {string} text
   */
  onBalMessage(text) {
    const p = this._pBal;
    if (!p) return;
    const clean = cleanMinecraftText(text);
    if (!clean) return;

    if (/^<[^>]+>/.test(clean)) return;

    if (isNotFoundMessage(clean, p.player)) {
      return this._finishBal(new Error(`Không tìm thấy người chơi ${p.player} hoặc chưa từng đăng nhập`), undefined, p);
    }

    const parsed = parseBalanceMessage(clean, p.player);
    if (parsed) {
      return this._finishBal(null, parsed, p);
    }
  }

  /** Gọi từ handler chat */
  onMessage(text) {
    const p = this._p;
    if (p && isNotFoundMessage(text, p.player)) {
      this._finish(new Error(`Không tìm thấy người chơi ${p.player} hoặc chưa từng đăng nhập`));
    }
    if (this._pBal) {
      this.onBalMessage(text);
    }
  }

  /** Mất kết nối */
  reset() {
    this._lateUntil = 0;
    this._finish(new Error('Bot bị ngắt kết nối khi đang lấy stats'));
    this._finishBal(new Error('Bot bị ngắt kết nối khi đang lấy balance'));
  }
}

module.exports = StatsReader;
module.exports.StatsReader = StatsReader;
Object.assign(module.exports, {
  componentText,
  loreFromNbt,
  cleanMinecraftText,
  smallCapsToUpper,
  normalizeSmallCaps,
  formatItemName,
  getVietnameseName,
  getStatsLabelVi,
  statsLabel,
  isDecorationItem,
  cleanLoreLines,
  rawEntry,
  scanWindow,
  buildItems,
  formatLine,
  parseMoneyAmount,
  parseBalanceMessage,
  isNotFoundMessage,
  ITEM_NAMES_VI,
  STATS_LABELS_VI,
  BALANCE_REGEXES,
  SMALL_CAPS,
});
