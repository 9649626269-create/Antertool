# Lenis trong Antares Manager

- Phiên bản: `lenis@1.3.27`, nạp từ unpkg (CSS trong `index.html`, JS có dự phòng `/vendor/lenis.min.js`).
- Muốn chạy offline/LAN không internet: tải `lenis.min.js` (và `lenis.css` nếu muốn) vào `src/web/public/vendor/`.
  Không có Lenis thì giao diện tự dùng cuộn native, mọi tính năng vẫn chạy.
- Lenis chạy trên `#tab-content` (không phải `window`) vì app-shell cố định 100dvh, trang không cuộn.
- Vùng cuộn lồng nhau: `data-lenis-prevent` (log console, sidebar, modal, menu nhảy mục) + `allowNestedScroll: true` làm lưới an toàn.
- Modal/drawer mở -> `lenis.stop()`, đóng -> `lenis.start()` (theo dõi class `.open`, xem `scroll.js`).
- Đổi tab/bot -> về đầu trang; cập nhật live -> giữ nguyên vị trí cuộn.
- API: `window.AntScroll.scrollTo(target, opts)`, `.top()`, `.stop()`, `.start()`.
- Cấu trúc DOM: `#tab-scroll` (wrapper cuộn) > `#tab-content` (content, render bằng innerHTML).
- Lưới an toàn: nếu wheel không tạo ra sự kiện cuộn 2 lần liên tiếp, Lenis tự bị tắt (console.warn) và dùng cuộn native.
- Chẩn đoán: mở Console trình duyệt, gõ `AntScroll.debug()`.
