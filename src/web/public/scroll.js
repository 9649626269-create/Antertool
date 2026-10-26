'use strict';
/*
 * scroll.js — tích hợp Lenis 1.3.27 cho Antares Manager.
 *
 * Vì sao Lenis chạy trên #tab-scroll chứ không phải window:
 *   giao diện là app-shell cố định 100dvh (html/body overflow:hidden), trang không bao giờ cuộn.
 *   Vùng cuộn chính là #tab-scroll (wrapper); #tab-content là con trực tiếp (content, render bằng innerHTML).
 *
 * Các vùng cuộn lồng nhau (log console, modal, sidebar...) được cách ly bằng thuộc tính
 * data-lenis-prevent (đặt trong index.html / app.js) nên cuộn native, không bị Lenis làm mượt.
 *
 * Nếu Lenis không tải được (CDN bị chặn/offline) hoặc khởi tạo lỗi -> tự rơi về cuộn native,
 * mọi tính năng (progress, Back to Top, nhảy mục) vẫn hoạt động.
 */
(function () {
  var scroller = document.getElementById('tab-scroll');   // wrapper cuộn
  var content = document.getElementById('tab-content');   // con trực tiếp, nội dung bị thay bằng innerHTML
  if (!scroller || !content) return;

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
    var nodes = content.querySelectorAll(SECTION_SEL);
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

  /* ---------- Lưới an toàn: nếu Lenis làm trang không cuộn được -> tự tắt Lenis, dùng cuộn native ---------- */
  var lastScrollAt = 0;
  var probePending = false;
  var probeFails = 0;
  function hasNestedScroller(target) {
    for (var n = target; n && n !== scroller && n.nodeType === 1; n = n.parentElement) {
      if (n.hasAttribute('data-lenis-prevent')) return true;
      var cs = getComputedStyle(n);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 1) return true;
    }
    return false;
  }
  function disableLenis(reason) {
    console.warn('[scroll] Lenis bị tắt, dùng cuộn native. Lý do:', reason, debugInfo());
    try { lenis.destroy(); } catch (e) { /* bỏ qua */ }
    lenis = null;
    root.removeAttribute('data-smooth-scroll');
    scroller.classList.remove('lenis', 'lenis-smooth', 'lenis-stopped', 'lenis-autoToggle', 'lenis-scrolling');
    scroller.addEventListener('scroll', onNativeScroll, { passive: true });
    refresh();
  }
  function onWheelProbe(e) {
    if (!lenis || locked || probePending || e.ctrlKey || !e.deltaY) return;
    if (hasNestedScroller(e.target)) return;
    var m = metrics();
    var room = e.deltaY > 0 ? m.limit - m.scroll : m.scroll;
    if (room < 4) return;                       // đang ở mép: không cuộn được là bình thường
    if (lenis.isStopped) { try { lenis.start(); } catch (err) { /* bỏ qua */ } }
    // Không so sánh scrollTop trước/sau (wheel passive có thể đã cuộn xong trước khi handler chạy);
    // thay vào đó kiểm tra có sự kiện 'scroll' nào xảy ra quanh thời điểm wheel hay không.
    var t0 = performance.now() - 150;
    probePending = true;
    setTimeout(function () {
      probePending = false;
      if (!lenis || locked) return;
      if (lastScrollAt < t0) {
        probeFails++;
        if (probeFails >= 2) disableLenis('wheel không tạo ra sự kiện cuộn nào');
      } else probeFails = 0;
    }, 700);
  }
  function debugInfo() {
    var m = metrics();
    return {
      lenis: !!lenis, isStopped: lenis ? lenis.isStopped : null, locked: locked,
      lenisLimit: lenis ? lenis.limit : null, nativeLimit: m.limit, scrollTop: m.scroll,
      clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight,
      overflowY: getComputedStyle(scroller).overflowY, classes: scroller.className
    };
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
          content: content,
          eventsTarget: scroller,
          autoRaf: true,
          lerp: 0.1,                // khi có lerp, Lenis bỏ qua duration/easing (duration giữ lại theo cấu hình)
          duration: 1.2,
          smoothWheel: true,
          anchors: true,
          allowNestedScroll: true,  // lưới an toàn: tự cho vùng cuộn lồng nhau cuộn native, kể cả vùng chưa gắn data-lenis-prevent
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
    else scroller.addEventListener('wheel', onWheelProbe, { passive: true, capture: true });
    scroller.addEventListener('scroll', function () { lastScrollAt = performance.now(); }, { passive: true });
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
    }).observe(content, { childList: true });

    // Nội dung tải bất đồng bộ / mở <details> làm đổi chiều cao (bỏ qua log console đã cách ly)
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var t = list[i].target;
        if (t && t.nodeType === 1 && t.closest && t.closest('[data-lenis-prevent]')) continue;
        scheduleRefresh();
        return;
      }
    }).observe(content, { childList: true, subtree: true });
    content.addEventListener('toggle', scheduleRefresh, true);
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
    debug: debugInfo,           // gõ AntScroll.debug() trong Console để xem trạng thái cuộn
    get lenis() { return lenis; }
  };
})();
