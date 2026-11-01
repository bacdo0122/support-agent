# Phòng Support (support-office)

Dashboard chạy local: hàng đợi Help Desk BOSS của 3 app (Solution / Quote / Lock), worklog của bạn, và các phiên Claude Code đang chạy (nhận qua hooks, đẩy lên trình duyệt bằng SSE).

Không cần cài thư viện: Node ≥ 22.

## Chạy

```bash
cp .env.example .env      # điền BOSS_TOKEN
npm start                 # http://127.0.0.1:4317
npm test
```

`BOSS_TOKEN` là personal access token của BOSS MCP (`https://boss.bss-b2b.solutions/mcp`), cần quyền `mcp:task:search` và `mcp:task:worklog:read`. Không có token thì app vẫn chạy, chỉ thiếu phần BOSS.

## Cách hoạt động

- `lib/boss.mjs`: MCP client tối giản (Streamable HTTP): `initialize` một lần, sau đó `tools/call`; tự đi theo `nextCursor`.
- `lib/poller.mjs`: mỗi `BOSS_POLL_SECONDS` gọi `search_tasks` cho các task **Todo** (trạng thái khác không hiển thị; đổi trong `QUEUE_STATUSES`) và `search_worklogs` của bạn; so với lần trước để báo task Todo mới, lên Urgent, hoặc không còn ở Todo. Lần trước lưu ở `data/state.json`.
- `lib/sessions.mjs`: nhận JSON của hook Claude Code ở `POST /hooks`, giữ trạng thái từng phiên (đang làm / chờ duyệt / đang nghỉ / đã đóng), bắt mã `SBCB2BBS-xxxx` từ prompt hoặc từ lời gọi tool BOSS.
- `GET /events`: SSE (`snapshot`, `boss`, `session`, `feed`). `GET /api/state`: JSON. `POST /api/poll`: tải BOSS ngay.

## Hooks

Đã khai báo trong `~/.claude/settings.json` cho SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop, SessionEnd:

```bash
curl -s -m 1 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:4317/hooks 2>/dev/null || true
```

Hook chạy `async`, nên khi server tắt thì Claude Code không bị chậm hay báo lỗi. Muốn tắt: xoá khối `hooks` trong file đó hoặc dùng `/hooks`.

Server chỉ nghe trên `127.0.0.1` vì sự kiện hook chứa lệnh và đường dẫn file.

Cài hooks trên máy khác: `node scripts/install-hooks.mjs` (chạy lại nhiều lần vẫn an toàn, có backup `settings.json.bak`; gỡ bằng `--remove`).

## Văn phòng isometric

Tab "Văn phòng" (`public/office.js`, canvas, không dùng thư viện): mỗi phiên Claude Code là một người ngồi ở phòng của app (lấy theo task hoặc theo tên thư mục), phiên đang chờ bạn có bong bóng "! Chờ duyệt", phiên xong lượt ra phòng nghỉ, trợ lý (subagent) đứng cạnh bàn. Task BOSS ở trạng thái Todo là khách xếp hàng trước quầy mỗi phòng (áo đỏ = Urgent). Bấm vào một người để xem chi tiết; nút "Toàn màn hình" để treo trên màn hình phụ.

Toà nhà còn có căn tin (phiên rảnh ngồi ăn khi sofa đã kín) và phòng giám đốc: giám đốc là bạn, nhãn trên đầu cho biết có bao nhiêu phiên đang chờ bạn duyệt. Khu phố xung quanh (`public/city.js`) gồm 4 con đường với ngã tư, đèn giao thông, vạch qua đường, các toà nhà, dãy cửa hàng, bãi đỗ xe, công viên có hồ và đài phun nước, xe cộ (buýt, ô tô, taxi, xe tải, van, cảnh sát, cấp cứu, xe máy, xe đạp) và người đi bộ. Thu nhỏ dưới 65% thì chỉ còn nhãn của phiên chờ duyệt và giám đốc.

## Xem từ nhiều máy (nhà + công ty) qua Tailscale

Mỗi máy chạy server và hooks của riêng nó; trang mở ở máy nào cũng kết nối thêm tới máy kia và gộp lại (máy tắt thì hiện "offline").

1. Cài Tailscale trên Windows ở cả hai máy, đăng nhập cùng một tài khoản. Bật HTTPS trong trang quản trị Tailscale (DNS → HTTPS Certificates).
2. Trên mỗi máy (PowerShell): `tailscale serve --bg 4317` → ghi lại địa chỉ `https://<tên-máy>.<tailnet>.ts.net`. Không dùng `tailscale funnel` (sẽ mở ra internet).
3. `.env` mỗi máy: `MACHINE_NAME` (Nhà / Công ty), `PEERS` = địa chỉ của máy kia, `BOSS_TOKEN`.
4. Xem từ điện thoại hoặc máy bất kỳ trong tailnet: mở địa chỉ của một trong hai máy.

`POST /hooks` từ chối mọi request đi qua proxy (có `X-Forwarded-For` hoặc `Tailscale-User-Login`), nên chỉ máy đó gửi được sự kiện cho chính nó.
