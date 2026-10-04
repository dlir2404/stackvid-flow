# StackVid Flow (Chrome Extension MV3)

> **High-Performance, Clean-Room Chrome Extension Bridge for Google Flow & Veo 3.1 Automation.**  
> Connects local/remote Chrome profiles to the StackVid Video Automation Platform.

---

## ⚡ Tính Năng Cốt Lõi

1. **Clean-Room Anti-Bot Shield (`flow-guard.js`):**
   - Chạy ở `document_start` trong MAIN execution world.
   - Bắt giữ con trỏ hàm `grecaptcha.enterprise.execute` gốc trước khi mã frontend của Google Flow kịp ghi đè (`x2a`).
   - Tích hợp lớp bảo vệ dự phòng động (`Object.assign` neuter) vô hiệu hóa hoàn toàn mã độc `extension_hijack_detected`.

2. **Cơ Chế Worker Độc Lập Cho Từng Profile (Multi-Profile Fleet Node):**
   - Mỗi Chrome Profile chạy 1 instance `stackvid-flow` duy nhất.
   - Tự động nhận diện tài khoản Google (`accountEmail`) đang đăng nhập.
   - Kết nối hai chiều qua WebSocket tới StackVid Flow Service (`ws://127.0.0.1:9222`).

3. **Giao Diện Terminal HUD Đặc Trưng Của StackVid:**
   - 100% typography `Geist Mono` monospace, tone pitch-black `#000000`, viền hairline `rgba(255, 255, 255, 0.08)`.
   - Hiển thị telemetry số lượng request thành công/thất bại, active jobs và terminal log realtime.
   - Tích hợp Chrome Side Panel Workbench với công cụ kiểm tra mint captcha chẩn đoán.

---

## 📦 Hướng Dẫn Cài Đặt (Developer Mode)

1. Mở trình duyệt Chrome / Edge / Brave / AdsPower / Antidetect Browser.
2. Truy cập `chrome://extensions/`.
3. Bật công tắc **Chế độ dành cho nhà phát triển (Developer mode)** ở góc trên bên phải.
4. Bấm nút **Tải phần mở rộng đã giải nén (Load unpacked)**.
5. Chọn thư mục dự án:
   ```
   /Users/dlir/code/stackvid-flow
   ```

---

## 🚀 Hướng Dẫn Sử Dụng

1. Mở một tab truy cập `https://flow.google.com/` và đăng nhập tài khoản Google của bạn.
2. Bấm vào icon **StackVid Flow** trên thanh tiện ích của Chrome.
3. Badge trạng thái sẽ tự động nhận diện:
   - `TAB READY: your.email@gmail.com`
   - `CONNECTED (ws://127.0.0.1:9222)`
4. Mọi yêu cầu render ảnh/video được điều phối từ StackVid Backend sẽ tự động được thực thi trên tab này và trả kết quả về theo thời gian thực.
