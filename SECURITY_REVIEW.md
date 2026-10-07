# Kiểm tra dữ liệu ra ngoài và dấu hiệu keylogger

Ngày kiểm tra: 2026-10-06. Phạm vi: repository ChatGPT_Local, cấu hình cục bộ và một số kiểm tra HTTP/TCP chỉ đọc trên server đang chạy. Không sửa mã ứng dụng, đổi token, bật upstream, chạy tunnel hoặc khởi động lại server.

## Kết luận

Chưa phát hiện mã keylogger hoặc đích gửi dữ liệu ngầm được hard-code trong mã ứng dụng đã rà soát. Tuy nhiên, có lỗi lộ thông tin xác thực đã xác nhận trên server đang chạy. Không nên coi bản hiện tại là an toàn để mở công khai qua tunnel.

Đây là công cụ truy cập máy từ xa: nội dung file và kết quả lệnh có thể được trả cho MCP client, bao gồm ChatGPT khi được kết nối. “Local” không có nghĩa là mọi dữ liệu luôn ở trên máy.

## Phát hiện cần xử lý

### 1. Nghiêm trọng khi public: `/health` công khai token MCP

- `src/index.ts:102` ghép token vào đường dẫn MCP; `src/index.ts:157` đăng ký `/health` không xác thực; `src/index.ts:167` trả `mcpEndpoints: MCP_PATHS`.
- Bản build cũng chứa lỗi tại `dist/index.js:129`.
- GET `http://127.0.0.1:3000/health` không gửi thông tin xác thực trả HTTP 200. Đã so sánh trong bộ nhớ và xác nhận endpoint trả về chứa đúng `MCP_TOKEN` trong cấu hình; không in token ra báo cáo.
- Gửi Origin kiểm thử nhận `Access-Control-Allow-Origin: *` (`src/index.ts:97`). Khả năng một website truy cập localhost còn phụ thuộc bảo vệ của trình duyệt; chưa kiểm thử khai thác từ trình duyệt.
- Nếu tunnel chuyển tiếp toàn bộ cổng 3000 như `tunnel.ps1:47`, người biết địa chỉ tunnel có thể đọc `/health` để lấy đường dẫn xác thực. MCP sau đó có quyền đọc/ghi file và chạy lệnh theo quyền tài khoản chạy server.

Khắc phục: endpoint health công khai chỉ trả trạng thái tối thiểu; bỏ token, endpoint có token và thông tin workspace khỏi phản hồi. Giới hạn Origin/CORS và kiểm tra Host phù hợp. Nếu đã public bản này, thay MCP token sau khi vá; chỉ đổi token mà giữ lỗi thì token mới vẫn bị lộ.

### 2. Cao: Admin API trả toàn bộ `.env`, không có token quản trị

- Cấu hình kiểm tra có `ADMIN_TOKEN` rỗng. `src/admin/localhost-guard.ts:21` bỏ xác thực khi token rỗng.
- `src/admin/routes.ts:104` trả toàn bộ biến trong `.env`, không che bí mật.
- GET `http://127.0.0.1:3001/api/config/env` không xác thực trả HTTP 200, chứa cả MCP token và API key tunnel. Báo cáo chỉ ghi nhận sự hiện diện, không lưu giá trị.
- Request thử với Host và Origin `audit.invalid:3001` vẫn được chấp nhận. Guard chỉ kiểm tra địa chỉ socket, thiếu kiểm tra Host/Origin: có rủi ro DNS rebinding; chưa thực hiện chuỗi khai thác từ trình duyệt.
- Cổng quản trị đang bind `127.0.0.1`, do đó kết quả này không đồng nghĩa cổng 3001 đang mở trực tiếp ra Internet.

Khắc phục: yêu cầu xác thực quản trị, kiểm tra Host/Origin và không trả bí mật qua API cấu hình; giữ bind loopback. Khi có bằng chứng API key đã bị lộ cho bên không tin cậy, thu hồi/thay key đó.

### 3. Cao về phạm vi quyền: không có sandbox trong server

- `src/lib/path-security.ts:25`: `setFullDiskAccess` không làm gì, `getFullDiskAccess` luôn trả true; `validatePath` chỉ chuẩn hóa đường dẫn.
- `src/lib/permissions.ts:25`: không chặn lệnh; các hàm kiểm tra quyền ghi/chạy lệnh không áp đặt giới hạn.
- Đặt `WORKSPACE_PATH` hoặc thêm `FULL_DISK_ACCESS=false` không tạo ranh giới truy cập trong bản code này.
- `CHATGPT_AUTO_APPROVE=true` đang bật. `src/lib/tool-annotations.ts:20` đánh dấu cả thao tác nguy hiểm là `destructiveHint: false`. Đây chỉ là metadata cho client, không phải cơ chế cấp quyền phía server.

Khắc phục: dùng tài khoản hệ điều hành có quyền hạn chế; triển khai giới hạn đường dẫn/lệnh thực sự nếu cần. Khai báo đúng mức rủi ro của tool. Mức ảnh hưởng của hai lỗi trên tăng mạnh vì quyền máy rộng.

## Dữ liệu có thể đi tới đâu?

| Luồng | Dữ liệu / điều kiện | Quan sát |
|---|---|---|
| MCP client, ví dụ ChatGPT | Kết quả đọc file, tìm kiếm, stdout/stderr và dữ liệu tool khác khi được gọi | Chức năng chính của server |
| MCP initialization | Hướng dẫn project, memory, skills, đường dẫn workspace, thông tin OS và Git | Tự xây context tại `src/lib/instruction-context.ts:35`, đưa vào server instructions |
| Cloudflare Tunnel | Chuyển tiếp HTTP giữa client và server local khi chạy tunnel | `tunnel.ps1:47`; không thấy tiến trình cloudflared lúc chụp trạng thái |
| OpenAI tunnel client | Script truyền API key qua môi trường và cấu hình server local cho binary | `openai-tunnel.ps1:124`; không thấy tiến trình tunnel-client lúc kiểm tra; chưa xác minh binary hoặc hostname control plane thực tế |
| MCP upstream HTTP / tiến trình stdio | Gửi tên tool, arguments và nhận kết quả; tiến trình con có thể tự truy cập mạng | `src/lib/mcp-upstream-manager.ts:223` và `:374`; cả cấu hình trên đĩa và API server đều có 7 upstream, tất cả tắt |
| Tải phần mềm | GitHub tải tunnel-client; esbuild có fallback tải binary từ registry.npmjs.org | Không thấy mã gửi nội dung project trong các đoạn tải đã đọc |
| Shell, hook, Node REPL | Mã/lệnh được gọi có thể gửi dữ liệu tới địa chỉ bất kỳ | Không có allowlist mạng; phụ thuộc lệnh hoặc plugin được thực thi |

Các upstream được cấu hình chủ yếu trỏ loopback. Upstream Colab đang tắt có tham chiếu `pypi.org` và `github.com` trong lệnh cài/chạy. Không có bằng chứng những đích này đang nhận dữ liệu trong phiên kiểm tra.

Tại lần chụp TCP, PID server 644 chỉ có listener `127.0.0.1:3000`, `127.0.0.1:3001` và kết nối loopback. Đây là ảnh chụp một thời điểm, không chứng minh lịch sử không có kết nối ra ngoài.

## Ghi phím và dữ liệu lưu trên máy

- Không thấy các API/hook ghi phím như GetAsyncKeyState, SetWindowsHook, iohook, uiohook, pynput, hoặc mã đọc clipboard/keylogger trong các lượt tìm kiếm mã ứng dụng và build.
- Không tìm thấy endpoint telemetry/webhook hard-code đáng ngờ trong các đường mạng ứng dụng đã rà soát.
- Có audit log, lịch sử lệnh và checkpoint: `.mcp-audit.log`, `.mcp-state/`, `.mcp-checkpoints/`. Chúng ghi hoạt động tool, lệnh hoặc bản sao file; đây không phải ghi phím toàn hệ thống.
- `src/lib/activity-log.ts:233` giữ arguments của tool trong bộ nhớ; `src/tools/shell.ts:67` ghi nguyên lệnh vào audit; `src/lib/global-shell-state.ts` lưu 20 lệnh gần đây. Bí mật trong lệnh/nội dung có thể bị giữ lại.
- Kiểm tra 505 bản ghi audit và shell state không gặp mẫu keylogger đã tìm. Các URL tìm thấy trong hai nguồn này là namespace XML `schemas.microsoft.com`, không đủ để kết luận có kết nối mạng tới đó.
- So sánh chính xác MCP token và tunnel API key hiện tại với audit, một file shell state và 135 file checkpoint: không có file trùng giá trị. Điều này không loại trừ key cũ, mã hóa hoặc bí mật khác.
- Source có tích hợp Computer Use (`src/tools/node-repl.ts:35`), tự chấp nhận elicitation tại dòng 52 nếu plugin được bật. Cấu hình plugin không có nên mặc định tắt; module này chưa có trong bản build trên đĩa. Đây là khả năng điều khiển máy theo tool, chưa phải bằng chứng keylogger.
- Post-edit hooks đang tắt và danh sách rỗng. Source còn có khả năng nạp/chạy Codex plugin hooks; chưa kiểm toán nội dung plugin nằm ngoài repository.

## Dependency, bản build và giới hạn

- Kiểm tra 114 package manifest đã cài; lifecycle install tìm thấy là `esbuild` chạy `node install.js`. Root package không có preinstall/install/postinstall.
- Không phát hiện tên dependency keylogger trong lockfile qua các mẫu đã tìm. Chưa kiểm toán toàn bộ mã dependency, xác minh checksum với registry hoặc tra cứu đầy đủ CVE.
- Có 43 module TypeScript nhưng 38 module JavaScript trong dist. Năm module chưa có build: codex-hooks, mcp-oauth-provider, plugin-config, node-repl, ponytail. Bản dist cũ hơn source; không thể suy luận mọi tính năng source đang chạy. Riêng hai lỗi lộ bí mật đã xác nhận trực tiếp trên HTTP.
- `.env` không được Git track hiện tại; các file cấu hình upstream/post-edit hooks có được track. Không kết luận về toàn bộ lịch sử Git.
- Không quét malware toàn Windows, driver, persistence, RAM hoặc toàn bộ lưu lượng mạng. Không chạy lệnh khai thác hay đọc file tùy ý qua MCP để chứng minh quyền thực thi.

Ưu tiên xử lý: vá `/health` và Admin API, thay token đã có nguy cơ lộ, giới hạn quyền server, sau đó kiểm tra lại trước khi mở tunnel. Chưa có bằng chứng dự án đang bí mật ghi phím; các lỗi xác thực kể trên vẫn là rủi ro thực tế cần sửa.
