'use strict';
/*
 * scroll.js — tích hợp Lenis 1.3.27 cho Antares Manager.
 *
 * Vì sao Lenis chạy trên #tab-content chứ không phải window:
 *   giao diện là app-shell cố định 100dvh (html/body overflow:hidden), trang không bao giờ cuộn.
 *   Vùng cuộn chính là #tab-content, nên Lenis dùng wrapper/content = #tab-content.
 *
 * Các vùng cuộn lồng nhau (log console, modal, sidebar...) được cách ly bằng thuộc tính
 * data-lenis-prevent (đặt trong index.html / app.js) nên cuộn native, không bị Lenis làm mượt.
 *
 * Nếu Lenis không tải được (CDN bị chặn/offline) hoặc khởi tạo lỗi -> tự rơi về cuộn native,
 * mọi tính năng (progress, Back to Top, nhảy mục) vẫn hoạt động.
 */
(function () {
  var scroller = document.getElementById('tab-content');
  if (!scroller) return;

  var root = document.documentElement;
  var bar = document.getElementById('scroll-progress');
  var barFill = bar ? bar.firstElementChild : null;
  var tools = document.getElementById('scroll-tools');
  var btnTop = document.getElementById('btn-scroll-top');
  var jumpWrap = document.getElementById('scroll-jump');
  var jumpBtn = document.getElementById('btn-scroll-jump');
  var jumpMenu = document.getElementById('scroll-jump-menu');

  var SHOW_TOP_AFTER = 320;      // px cuộn xuống rồi mới hiện nút "lên đầu"
  var SCROLL_OPTS = { offset: -20, duration: 1.2 };
  var SECTION_SEL = '.sec-label, .sys-section-title, .cmd-section-title, .cfg-section-title';

  var lenis = null;
  var locked = false;
  var velTimer = 0;
  var rafPending = false;
  var lastKey = null;

  /* ---------- Khóa/mở cuộn khi modal hoặc drawer đang mở ---------- */
  function shouldLock() {
    if (document.querySelector('.overlay.open')) return true;
    var sb = document.getElementById('sidebar');
    return !!(sb && sb.classList.contains('open') && window.matchMedia('(max-width: 899px)').matches);
  }
  function syncLock() {
    var want = shouldLock();
    if (want === locked) return;
    locked = want;
    root.toggleAttribute('data-scroll-locked', locked);
    if (lenis) { if (locked) lenis.stop(); else lenis.start(); }
    if (locked) closeJump();
  }

  /* ---------- Số đo cuộn (dùng chung cho Lenis và native) ---------- */
  function metrics() {
    var limit = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    var scroll = scroller.scrollTop;
    return { scroll: scroll, limit: limit, progress: limit > 0 ? Math.min(1, Math.max(0, scroll / limit)) : 0 };
  }
  function paint(scroll, limit, progress, velocity) {
    if (barFill) {
      barFill.style.transform = 'scaleX(' + (isFinite(progress) ? progress : 0).toFixed(4) + ')';
      bar.classList.toggle('is-idle', limit <= 1);
    }
    if (tools) tools.classList.toggle('show-top', scroll > SHOW_TOP_AFTER);
    if (btnTop) btnTop.tabIndex = scroll > SHOW_TOP_AFTER ? 0 : -1;
    if (typeof velocity === 'number') {
      // Hiệu ứng theo vận tốc: độ sáng/độ dày của thanh progress. Tự về 0 khi dừng cuộn.
      root.style.setProperty('--scroll-v', Math.min(1, Math.abs(velocity) / 60).toFixed(3));
      clearTimeout(velTimer);
      velTimer = setTimeout(function () { root.style.setProperty('--scroll-v', '0'); }, 140);
    }
  }
  function refresh() {
    var m = metrics();
    paint(m.scroll, m.limit, m.progress);
  }
  function scheduleRefresh() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      if (lenis) { try { lenis.resize(); } catch (e) { /* bỏ qua */ } }
      refresh();
    });
  }

  /* ---------- scrollTo dùng chung ---------- */
  function scrollToTarget(target, opts) {
    opts = opts || SCROLL_OPTS;
    if (lenis) { lenis.scrollTo(target, opts); return; }
    var top = 0;
    if (typeof target === 'number') top = target;
    else if (target && target.getBoundingClientRect) {
      top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + (opts.offset || 0);
    }
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: Math.max(0, top), behavior: reduce || opts.immediate ? 'auto' : 'smooth' });
  }

  /* ---------- Menu "nhảy tới mục" ---------- */
  function collectSections() {
    var out = [];
    var nodes = scroller.querySelectorAll(SECTION_SEL);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      // .cfg-section-title lồng bên trong thẻ (vd "Doanh thu") không phải mục cấp cao nhất
      if (el.classList.contains('cfg-section-title') && el.previousElementSibling) continue;
      var text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      var card = el.classList.contains('cfg-section-title') ? (el.parentElement || el) : el;
      out.push({ text: text.length > 44 ? text.slice(0, 43) + '…' : text, el: card });
    }
    return out;
  }
  function closeJump() {
    if (!jumpMenu || jumpMenu.hidden) return;
    jumpMenu.hidden = true;
    if (jumpBtn) jumpBtn.setAttribute('aria-expanded', 'false');
  }
  function rebuildJump() {
    if (!jumpWrap || !jumpMenu) return;
    var items = collectSections();
    closeJump();
    jumpMenu.textContent = '';
    if (items.length < 3) { jumpWrap.hidden = true; return; }
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'scroll-jump-item';
      b.setAttribute('role', 'menuitem');
      b.textContent = it.text;
      b.addEventListener('click', function () {
        closeJump();
        scrollToTarget(it.el, SCROLL_OPTS);
      });
      jumpMenu.appendChild(b);
    });
    jumpWrap.hidden = false;
  }

  /* ---------- Khởi tạo ---------- */
  function onLenisScroll(l) {
    // Lenis truyền instance: { scroll, velocity, progress, limit }
    paint(l.scroll, l.limit, l.progress, l.velocity);
  }
  function onNativeScroll() {
    var m = metrics();
    paint(m.scroll, m.limit, m.progress);
  }

  function init() {
    if (typeof window.Lenis === 'function') {
      try {
        lenis = new window.Lenis({
          wrapper: scroller,
          content: scroller,        // nội dung #tab-content bị thay bằng innerHTML nên dùng chính nó
          eventsTarget: scroller,
          autoRaf: true,
          lerp: 0.1,                // khi có lerp, Lenis bỏ qua duration/easing (duration giữ lại theo cấu hình)
          duration: 1.2,
          smoothWheel: true,
          anchors: true,
          autoToggle: true,
          stopInertiaOnNavigate: true,
          naiveDimensions: true     // chiều cao nội dung đổi liên tục (render động) -> đo trực tiếp
        });
        lenis.on('scroll', onLenisScroll);
      } catch (err) {
        console.warn('[scroll] Lenis lỗi, dùng cuộn native:', err);
        lenis = null;
      }
    }
    if (!lenis) scroller.addEventListener('scroll', onNativeScroll, { passive: true });
    root.toggleAttribute('data-smooth-scroll', !!lenis);

    // Lỡ có modal đang mở trước khi Lenis sẵn sàng
    locked = false;
    syncLock();

    // Render lại tab (innerHTML): đổi tab/bot -> về đầu trang; cập nhật live -> giữ nguyên vị trí.
    new MutationObserver(function () {
      var key = '';
      try { key = String(ST.activeId) + '|' + String(ST.activeTab); } catch (e) { key = lastKey || ''; }
      if (lastKey !== null && key !== lastKey) {
        if (lenis) lenis.scrollTo(0, { immediate: true, force: true });
        else scroller.scrollTop = 0;
      }
      lastKey = key;
      rebuildJump();
      scheduleRefresh();
    }).observe(scroller, { childList: true });

    // Nội dung tải bất đồng bộ / mở <details> làm đổi chiều cao (bỏ qua log console đã cách ly)
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var t = list[i].target;
        if (t && t.nodeType === 1 && t.closest && t.closest('[data-lenis-prevent]')) continue;
        scheduleRefresh();
        return;
      }
    }).observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener('toggle', scheduleRefresh, true);
    window.addEventListener('resize', scheduleRefresh);

    // Modal/drawer: theo dõi class thay vì sửa từng chỗ mở/đóng trong app.js
    var mo = new MutationObserver(syncLock);
    document.querySelectorAll('.overlay').forEach(function (o) { mo.observe(o, { attributes: true, attributeFilter: ['class'] }); });
    var sb = document.getElementById('sidebar');
    if (sb) mo.observe(sb, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', syncLock);

    // Nút điều khiển
    if (btnTop) btnTop.addEventListener('click', function () { scrollToTarget(0, { duration: 1.2 }); });
    if (jumpBtn) jumpBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = jumpMenu.hidden;
      jumpMenu.hidden = !open;
      jumpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (jumpWrap && !jumpWrap.contains(e.target)) closeJump();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeJump();
    });

    rebuildJump();
    refresh();
  }

  // Chạy sau khi mọi script (kể cả Lenis tải dự phòng) đã nạp xong
  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init);

  // API cho phần còn lại của app nếu cần
  window.AntScroll = {
    scrollTo: scrollToTarget,
    top: function () { scrollToTarget(0, { duration: 1.2 }); },
    stop: function () { if (lenis) lenis.stop(); },
    start: function () { if (lenis) lenis.start(); },
    get lenis() { return lenis; }
  };
})();
