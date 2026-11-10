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

## Hàng đợi duyệt (task Todo mới giao cho bạn → phân tích → duyệt solution)

Mặc định (`AUTO_ANALYZE=1`) bước 1–2 tự chạy, không cần bạn duyệt: task mới vào hàng đợi là phân tích ngay, **không** đổi status trên BOSS (task vẫn ở Todo). Chỉ khi bạn tự bấm Duyệt (task thêm tay, hoặc chạy lại task lỗi) thì mới chuyển Todo → In Progress như bước 2. Bật/tắt ngay trên trang bằng nút **Tự động phân tích** ở thanh trên cùng (lưu ở `data/settings.json`, giữ qua lần khởi động lại; `AUTO_ANALYZE=0` chỉ là giá trị mặc định khi chưa từng bấm). Tắt thì task mới vẫn vào hàng đợi nhưng nằm ở "chờ duyệt phân tích" cho tới khi bạn bấm Duyệt. Bước 3 (comment, DevHub) luôn cần bạn duyệt.

1. `lib/poller.mjs` thấy task **mới giao cho bạn ở trạng thái Todo** (hoặc vừa quay lại Todo) → `lib/pipeline.mjs` đưa vào panel "Hàng đợi duyệt" ở trạng thái *chờ bạn duyệt phân tích*. Chưa chạy gì. Task Todo có từ trước: bấm "Đưa vào hàng đợi" ở bảng "Giao cho tôi".
2. Bấm **Duyệt** → server đọc status task trên BOSS: còn **Todo** thì chuyển sang **In Progress** (`update_task`, bằng `BOSS_TOKEN`, thiếu quyền `mcp:task:write` thì qua connector BOSS của Claude với profile chỉ có `read_task`/`update_task`); đã ở status khác thì giữ nguyên. Không chuyển được thì dừng, báo lỗi, chưa phân tích. Sau đó server **đọc sẵn** task, comment (kèm file đính kèm) và đoạn Crisp quanh ngày tạo task (lùi tối đa 21 ngày trước đó), đổi HTML thành chữ thường (giữ link, code, ảnh), tải mọi ảnh vào `boss-autofix-logs/img/<ID>/`, rồi đưa tất cả vào prompt để Claude không mất các lượt đầu đọc lại (Claude vẫn tự đọc thêm phần bị cắt hoặc task tiền lệ). Luật của app chỉ gửi phần hợp với loại task (luật cài module chỉ cho task install). Phiên phân tích chỉ nạp các tool cần dùng (`--tools`). Các bước máy móc (ghi/bật DevHub, chuyển status, đăng comment đã duyệt) chạy **Sonnet**; phân tích, hỏi lại và kiểm chứng vẫn chạy model mặc định (`CLAUDE_MODEL`, Opus). Sau đó chạy `claude -p "/analyze-boss-task <ID>"` với **`--permission-mode auto`, giống khi chạy trong CLI**: được dùng Bash (git fetch/log/show để đọc `origin/master`, ls, cat, curl), Grep/Read, subagent, WebFetch, `devhub_read`, chrome-devtools; hook `boss-browser-guard` vẫn giữ store khách chỉ đọc. Chỉ cấm những việc phải chờ bạn duyệt: comment, ghi DevHub, đổi task, sửa file, git commit/push, gõ/điền trên trình duyệt. Mỗi lần một task. Kết quả (tóm tắt, nguyên nhân, solution, bản nháp comment, code DevHub nếu có) hiện trong thẻ task, kèm **báo cáo đầy đủ của skill (mở sẵn)**, số ảnh đã tải và danh sách thao tác bị chặn (nếu có, kết quả có thể thiếu bằng chứng).
   Trong lúc phân tích, Claude tự kiểm tra bằng **Chrome của bạn qua chrome-devtools**, chỉ đọc. Mỗi việc mở một tab riêng và đóng khi xong:
   - Task liên quan order/checkout/giá/thuế/shipping/email/quote/API lỗi: tra **Sentry tự host** (`sentry.bss-b2b.solutions`, GET API rồi đọc snapshot). Chrome phải đăng nhập SSO Sentry sẵn.
   - Lỗi hiển thị/hành vi trên storefront: mở **store khách** và xem console, network, snapshot, screenshot.
   - Không click, không fill, không `evaluate_script`. Store có mật khẩu hoặc cần đăng nhập thì ghi là không kiểm tra được.
   - File lưu ở `boss-autofix-logs/{img,sentry,store}/<TASK-ID>/`; server tạo sẵn thư mục trước mỗi lần chạy.
   - Kết quả hiện ở mục "Đã kiểm tra" trong thẻ.
   **Task hỏi cách dùng:**
   - Phân tích tách **từng câu hỏi**. Mỗi câu được trả lời thẳng: câu đầu là kết luận, kèm căn cứ (code `file:line`, knowledge, task đã Resolved, hoặc store/admin chỉ đọc). Không có căn cứ thì ghi "chưa chắc", không đoán.
   - Sau đó một **phiên Claude mới, độc lập** (chỉ đọc) tự đọc lại task. Phiên này tìm câu bị sót hoặc hiểu sai, rồi tự mở căn cứ để kiểm từng câu trả lời: đúng / sửa / chưa chắc.
   - Câu trả lời đã sửa và comment viết lại thay cho bản nháp. Comment theo mẫu: Tóm tắt / Câu hỏi n / Trả lời / Hướng dẫn gửi khách (EN) / Nguồn.
   - Thẻ hiện từng câu với nhãn ✓ / ✎ / ?. Kiểm chứng lỗi thì giữ bản đầu và ghi rõ.
   Kết quả chưa đúng ý: gõ câu hỏi vào ô **"Hỏi lại Claude về kết quả này"** trong thẻ (Ctrl+Enter để gửi). Câu hỏi được gửi vào **cùng phiên phân tích** (`claude -p --resume <session>`, vẫn chỉ đọc), nên Claude có đủ ngữ cảnh lần đầu. Nếu kết luận thay đổi, Claude trả về khối JSON mới. Thẻ tự cập nhật tóm tắt, nguyên nhân, solution, bản nháp comment và code DevHub, chỉ với phần chưa gửi/ghi. Nếu không đổi thì chỉ trả lời. Mỗi lần một câu, có nút Dừng. Câu hỏi và câu trả lời lưu trong thẻ.
3. Duyệt lần hai, từng việc riêng:
   - **Duyệt & comment lên task**: gửi đúng nội dung trong ô (bạn sửa được) dưới dạng HTML theo template Root Cause / Solution / Technical Details / Result. Thử bằng `BOSS_TOKEN` trước; token không có `mcp:task:comment:write` thì gửi qua connector BOSS của Claude với đúng HTML đó.
   - Nếu phân tích có đề xuất code DevHub, nút **Duyệt** đổi thành "Duyệt: comment lên task + thêm code DevHub". Bấm nút đó thì vừa comment, vừa **tự thêm code vào DevHub**. Muốn thêm code mà không comment thì bấm "Chỉ thêm code DevHub".
     - Code lấy từ ô code, bạn sửa được trước khi duyệt.
     - **Giữ nguyên code DevHub đang có**, chỉ nối thêm một block mới ở cuối.
     - Block mới do server tạo: mọi dòng đều comment, có nhãn `// [<ID>] autofix-boss <ngày> START — CHỜ XÁC NHẬN … // [<ID>] END`. Bật code vẫn bằng `/autofix-boss confirm <ID>`.
     - Việc ghi qua connector BOSS của Claude (`devhub_read` / `devhub_write`, `support_key="js"`). Profile chỉ có 2 tool đó. Token của app không có quyền `mcp:devhub:*`.
     - Trước khi lưu, Claude ghi lại version DevHub hiện tại. Sau khi lưu, Claude đọc lại và kiểm tra code cũ còn nguyên, block mới đã có. Không xác nhận được thì thẻ báo "Cần kiểm tra lại DevHub", kèm version để restore.
     - Không ghi khi:
       - App không nằm trong `DEVHUB_APPS` (mặc định `Lock`).
       - Phân tích không có domain `.myshopify.com`.
       - DevHub đã có block của task.
       - Store Lock là **bản cũ**: HTML storefront có `bss-ltap-hide-price`. Với shop bản cũ, lưu DevHub làm app ghi snippet vào theme khách.
       - Không mở được storefront hoặc store có mật khẩu.
     - Solution: theo code `monorepo` (`support.service.ts` → `storefront-sync.service.ts`), khi lưu thì app chỉ ghi DB và app metafield, không ghi theme. Muốn bật thì đặt `DEVHUB_APPS=Lock,Solution`. Quote chưa có DevHub.
   - **Task cài module vào theme** (Install CP/PL/VP… vào draft theme): phân tích làm theo cách team đã làm ở các task Resolved (5575, 5558, 4919, 4710). Claude lấy ID theme đích (link preview, Crisp, admin chỉ đọc), mở theme đó bằng `?preview_theme_id=`, đọc `themeConfig.ts` trong monorepo, dò selector thật trên từng trang (collection, sản phẩm, search, quick view, mini cart, cart) rồi soạn code DevHub dùng `window.bssB2BHooks.filters['custom:config_theme/installation']`, **chỉ chạy khi `Shopify.theme.id` là theme đích** (live theme không bị ảnh hưởng). App không tự bật app embed hay sửa Liquid (đó là sửa theme): việc nào cần thì ghi thành hướng dẫn cho khách/CS trong comment. Thử fix chạy trên trang sản phẩm của theme đích (`?preview_theme_id=`), sau đó duyệt/ghi/bật như mọi code DevHub khác. `.env` hiện đặt `DEVHUB_APPS=Lock,Solution`.
   - **Thử fix trước khi bật** (`lib/trial.mjs`): khi phân tích đề xuất code DevHub kèm `devhub.test` (gồm `path`, `check` = biểu thức JS trả `true` khi hết lỗi, và `ready` tuỳ chọn), server tự chạy thử ngay sau khi phân tích xong.
     - Thử bằng **Chrome headless riêng**, profile trống, khách vãng lai. Mọi request khác GET/HEAD/OPTIONS đều bị chặn, nên trang và code không ghi được gì lên store.
     - Lần 1 là trang như khách thấy: `check` phải ra `false`, tức là tái hiện được lỗi.
     - Lần 2 là cùng trang có code đề xuất: `check` phải ra `true` và không có lỗi console mới. Với **B2B Solution**, code được chèn vào `<script id="bss-b2b-customize">` ngay trong HTML (bản trang chỉ ở máy), đúng chỗ app embed in code DevHub, trước khi app khởi tạo; nhờ vậy thử được cả code cài đặt (hook `custom:config_theme/installation`). Trang không có script đó nghĩa là app embed chưa bật trên theme → "không có kết quả". App khác: chạy code sau khi trang tải xong.
     - Thẻ hiện ảnh trước và sau, cùng kết luận: ĐẠT / chưa đạt / không tái hiện được / không có kết quả (vd store có mật khẩu).
     - Trang, biểu thức kiểm tra và code sửa được ngay trong thẻ, rồi bấm "Thử lại". Đường dẫn chỉ nhận path trên đúng domain của store.
     - Nếu code bị sửa trước khi vào DevHub, server tự thử lại với đúng code trong DevHub.
     - Ảnh lưu ở `boss-autofix-logs/store/<ID>/`.
   - **Bật code trên store**, sau khi block đã nằm trong DevHub:
     - Bấm nút này nghĩa là bạn xác nhận, giống `/autofix-boss confirm`.
     - Claude bỏ comment **đúng block của task**, đổi nhãn thành `ĐÃ XÁC NHẬN <ngày>`. Phần còn lại của DevHub giữ nguyên, có kiểm tra độ dài sau khi lưu.
     - Sau đó server mở store thật (không chạy code gì) tối đa 3 lần, cách nhau 20 / 30 / 60 giây vì có cache:
       - Hết lỗi, không có lỗi console mới: báo "Code đang chạy trên store".
       - Có lỗi console mới: **tự comment lại block** (theo autofix-boss 3B-xác nhận bước 3).
       - Vẫn chưa thấy hết lỗi: để nguyên code và báo bạn xem lại.
     - Nút chỉ hiện "Bật code trên store" khi lần thử **ĐẠT với đúng code trong DevHub**. Trường hợp khác phải bấm hai lần "Bật dù chưa thử đạt".
4. "Xong" hoặc "Bỏ qua" để ẩn thẻ. Trạng thái lưu ở `data/pipeline.json`; việc đang chạy khi server tắt sẽ hiện là lỗi để chạy lại, không coi là xong.

### Học từ task (`lib/learn.mjs`)

1. **Phản hồi:**
   - Khi bấm Xong hoặc Bỏ qua, app ghi lại task. Nút Bỏ qua hỏi thêm lý do: sai nguyên nhân/solution, đã xử lý ở chỗ khác, không cần xử lý, khác.
   - App đọc comment đầu tiên **của bạn** trên BOSS (`read_task_comments`, cờ `isMine`) và so với bản nháp: giữ nguyên / sửa một phần / viết lại.
   - Trong 7 ngày sau đó, cứ 30 phút app đọc lại comment, vì bạn có thể comment muộn hoặc CS trả lời thêm. Task quay lại Todo thì đánh dấu "bị mở lại".
   - Dữ liệu lưu ở `data/feedback.json`.
2. **Bài học:**
   - Một lượt Claude Sonnet chạy khi có dấu hiệu phân tích chưa tốt: bạn sửa hoặc viết lại bản nháp, bỏ qua vì sai, phải hỏi lại trong chat, kiểm chứng phải sửa câu trả lời, thử fix hoặc bật code không đạt, hoặc task bị mở lại.
   - Lượt này không dùng tool nào, mất khoảng $0.03 và rút ra 0–3 bài học ngắn.
   - Bài học nằm ở `data/lessons.json`, **chờ bạn duyệt** trong panel "Học từ task". Bạn sửa được nội dung trước khi duyệt.
   - Chỉ bài học đã duyệt mới được thêm vào prompt phân tích, của đúng app hoặc mục "Chung".
3. **Kho case:**
   - Mỗi task có comment của bạn thành một case trong `data/cases.json`: triệu chứng và câu trả lời bạn đã đăng.
   - Nguyên nhân do app phân tích chỉ được giữ trong case khi bạn không viết lại bản nháp.
   - Khi phân tích, app đưa vào prompt tối đa 5 case giống nhất (cùng app, trùng từ khoá), kèm đường dẫn file để Grep thêm.

Lần đầu chạy, app học luôn từ các task cũ đã xong hoặc đã bỏ qua trong hàng đợi (backfill). `LESSON_MODEL` mặc định là `sonnet`.

Các thao tác này chỉ nhận từ trang mở ở `http://127.0.0.1:4317` hoặc `localhost` trên chính máy đó (kiểm tra `Origin`, JSON, không qua proxy), nên trang web khác hay máy qua Tailscale không bấm hộ được.

Biến `.env`: `PIPELINE=0` để tắt, `CLAUDE_BIN`, `CLAUDE_CWD` (mặc định thư mục cha của app, tức `BSS`), `CLAUDE_MODEL` (mặc định `opus`), `ANALYZE_TIMEOUT_MIN` (mặc định 30).

### Kho tiền lệ của team (`lib/teamcases.mjs`)

- Server đồng bộ các task **Resolved của cả team** (180 ngày, sau đó mỗi 6 giờ chỉ lấy task mới hoặc vừa đổi): triệu chứng (description đã bỏ dòng mẫu) và câu trả lời của TS (comment có Root Cause / Solution… của người `-TS`/`-DEV`, giữ nguyên code). Lưu ở `data/team-cases.json` và `data/team-cases.jsonl` (mỗi dòng một task, để Claude Grep).
- Mỗi lần phân tích, 5 task giống nhất (BM25 theo title + triệu chứng, ưu tiên cùng app) được đưa sẵn vào prompt, kèm câu trả lời TS (tối đa 1.800 ký tự mỗi task). Claude vẫn phải kiểm chứng có cùng nguyên nhân trước khi dùng.
- Cùng với đó: các bài học đã duyệt **liên quan nhất** tới task (không còn là 20 bài mới nhất), và 2 comment **thật của bạn** cùng app/loại task làm mẫu giọng văn, độ dài cho bản nháp comment.

### Chấm mù độ chuẩn (`lib/evaluate.mjs`, `scripts/eval.mjs`)

```
node --env-file=.env scripts/eval.mjs --n 12            # 12 task bạn đã trả lời, chia đều theo loại
node --env-file=.env scripts/eval.mjs --n 8 --team 6    # thêm 6 task gần nhất của team
node --env-file=.env scripts/eval.mjs --keys SBCB2BBS-5570,SBCB2BBS-5583
node --env-file=.env scripts/eval.mjs --dry             # chỉ xem sẽ chấm task nào
```

- Phân tích lại task đã Resolved **như task mới**: chỉ có comment, tin Crisp, ảnh trước lúc có câu trả lời; task đó và tiền lệ Resolved sau mốc đó bị loại khỏi kho; hook `scripts/eval-guard.mjs` chặn mọi lần đọc lại chính task, Crisp của task, DevHub, file kho/nhật ký của app.
- Một phiên Claude khác chấm theo ý (không theo câu chữ) so với comment thật: nguyên nhân, cách xử lý, từng câu hỏi, chi tiết bịa, ý bỏ sót, kết luận **duyệt được / sửa nhẹ / sai**, điểm 0–10.
- In bảng theo loại task, gồm số ca "sai mà tự tin cao" (thứ sẽ lọt qua nếu tự duyệt theo độ tự tin). Kết quả lưu `data/eval/<run>.json`. Chỉ đọc: không ghi BOSS, DevHub hay store. Lưu ý: code đọc là `origin/master` hiện tại, có thể đã có fix của chính task đó.

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

Mỗi task trong "Hàng đợi duyệt" là một agent: đi vào từ cửa cuối hành lang, tới ngồi ở phòng của app task đó (không rõ app thì phòng chung), làm việc khi đang chuyển status / phân tích / gửi comment / ghi DevHub, giơ bong bóng "Chờ duyệt" khi cần bạn (duyệt solution, lỗi), và đi ra cửa khi task được bấm Xong hoặc Bỏ qua. Bấm vào agent → "Xem trong hàng đợi".

Toà nhà còn có căn tin (phiên rảnh ngồi ăn khi sofa đã kín) và phòng giám đốc: giám đốc là bạn, nhãn trên đầu cho biết có bao nhiêu phiên đang chờ bạn duyệt. Khu phố xung quanh (`public/city.js`) gồm 4 con đường với ngã tư, đèn giao thông, vạch qua đường, các toà nhà, dãy cửa hàng, bãi đỗ xe, công viên có hồ và đài phun nước, xe cộ (buýt, ô tô, taxi, xe tải, van, cảnh sát, cấp cứu, xe máy, xe đạp) và người đi bộ. Thu nhỏ dưới 65% thì chỉ còn nhãn của phiên chờ duyệt và giám đốc.

## Xem từ nhiều máy (nhà + công ty) qua Tailscale

Mỗi máy chạy server và hooks của riêng nó; trang mở ở máy nào cũng kết nối thêm tới máy kia và gộp lại (máy tắt thì hiện "offline").

1. Cài Tailscale trên Windows ở cả hai máy, đăng nhập cùng một tài khoản. Bật HTTPS trong trang quản trị Tailscale (DNS → HTTPS Certificates).
2. Trên mỗi máy (PowerShell): `tailscale serve --bg 4317` → ghi lại địa chỉ `https://<tên-máy>.<tailnet>.ts.net`. Không dùng `tailscale funnel` (sẽ mở ra internet).
3. `.env` mỗi máy: `MACHINE_NAME` (Nhà / Công ty), `PEERS` = địa chỉ của máy kia, `BOSS_TOKEN`.
4. Xem từ điện thoại hoặc máy bất kỳ trong tailnet: mở địa chỉ của một trong hai máy.

`POST /hooks` từ chối mọi request đi qua proxy (có `X-Forwarded-For` hoặc `Tailscale-User-Login`), nên chỉ máy đó gửi được sự kiện cho chính nó.
