# Bản đồ tính năng BSS B2B (Solution / Quote / Lock)

Nguồn: `SBCB2BBS-xxxx` = câu trả lời TS; `help.json:<topic>` = FAQ trong app Solution (monorepo origin/master `apps/cms/web/frontend/public/locales/en/help.json`, đúng tên setting UI); `sf:` = `apps/extensions/packages/storefront-ts/src/`; `be:` = `apps/backend/src/modules/`.

# Solution

## 0. Quy tắc chung (đọc trước khi kết luận "app không làm được")
- Thứ tự tính giá (storefront + checkout draft order): **PL → (nếu PL không áp) CP → VP/QB trên giá sau PL/CP → BOGO → DC (mã B2B ở cart)**. (sf:utils/price.ts:17-40; sf:modules/cp/core/CpProduct.ts:39 `if (variant.appliedPL) return`; help.json:how-b2b-prices-combine)
- PL và CP **không cộng dồn**: cùng khách + cùng sản phẩm thì PL thắng, CP bị bỏ qua dù CP rẻ hơn. (help.json:pl-create-price-list, how-b2b-prices-combine)
- VP **luôn cộng dồn** lên giá PL/CP (giảm chồng). Priority chỉ so trong cùng 1 module; CP priority 0 không "thắng" VP priority 5 — hai cái cộng nhau. (help.json:how-rule-priority-works)
- Nhiều rule cùng module (CP, PL, VP): rule **Priority nhỏ nhất** thắng (0 = cao nhất); bằng nhau → rule tạo trước thắng. Không bao giờ cộng 2 rule CP. (help.json:cp-create-rule; SBCB2BBS-5562)
- Setting **"When several rules match a product"** (Custom Pricing > Price display / Price Lists > Price display): By priority (mặc định) | Lowest price. Toàn store; cần storefront v3 hoặc v5 + Draft order checkout; POS luôn By priority. Có từ 11/2026; trước đó app lấy rule đầu tiên khớp, không so giá. (be:custom-pricing/services/custom-pricing-rule-select.service.ts:47-66; SBCB2BBS-5465)
- Điều kiện khách: nhiều tag trong 1 rule = **OR**, không có AND; muốn thu hẹp dùng 2 rule hoặc Exclude customers. (help.json:how-customer-targeting-works; SBCB2BBS-4971)
- Target theo **Company locations** (Shopify B2B): chỉ CP, PL, VP (và NT từ 11/2026, switch "All company locations" B2B-1666); module khác không có. Cần gói Advanced/Platinum. (help.json:how-customer-targeting-works, cp-create-rule)
- Chọn theo **Specific variants**, import/export CSV, PL, Public API, POS, tăng giá CP (`cp.increase_price`) = **Platinum/Enterprise**. Tag/collection gắn theo product nên không tách được nhóm variant → phải Specific variants. (be:shop/data/plan-entitlements.ts:20-27; SBCB2BBS-5619, 5232)
- Giá B2B chỉ có khi đơn **đi qua nút Checkout ở cart**. Mất giá khi: chưa login, nút express (Shop Pay/PayPal/G-Pay), vào thẳng /checkout, login tại trang Checkout, app tạo checkout lỗi. (help.json:checkout-b2b-price; SBCB2BBS-5261, 3735)
- Sản phẩm Draft/Unlisted/không search được qua search.js → không áp giá, không hiện VP. (SBCB2BBS-3488, 3288)
- Rule được nhúng vào trang (BSS_B2B.configData) → lộ trong page source là giới hạn; Lock không chặn được. Giá kín hoàn toàn → Shopify B2B native (company + catalog). (SBCB2BBS-4288, 5057)
- Shopify Markets Catalog price adjustment không tương thích (app tính trên variant.price). (SBCB2BBS-4444)
- Admin Shopify không thấy giá B2B; phải login storefront bằng customer có tag. Bật "B2B rules for logged-in customers only" (Settings > General) thì guest không thấy giá rule All. (help.json:first-wholesale-price)

## 0b. Checkout: version 3 / version 5, Draft order checkout vs Shopify checkout
- Mặc định (v1/v3, v5 "Draft order checkout"): cart có giá B2B/DC/EF/SR/TE/Orders Custom Fields → app tạo **draft order**, khách trả tiền xong thành order. Rule SR/EF/DC/TE target All/guest kéo cả khách lẻ vào luồng này. (help.json:checkout-b2b-price)
- Trên Draft order checkout:
  - **Shopify automatic discount KHÔNG áp** (BXGY, free ship tự động, discount app khác). Chỉ mã Shopify nhập tay, khi bật Settings > Shopify checkout settings > **Shopify discount**; mã cộng chồng lên giá B2B. (SBCB2BBS-5618, 5562)
  - Ngoại lệ: dev bật riêng theo domain cho draft nhận automatic discount (custom, không phải setting). (SBCB2BBS-5276, 5196)
  - Company location: địa chỉ bị khoá theo Location; "Use a different address" không dùng được. (SBCB2BBS-5667)
  - Shopify Net Terms của Company không hiện trừ khi bật "Assign draft orders to the Shopify company" + "Use Shopify Company Location payment terms" (cái sau cần Advanced+). (SBCB2BBS-5589)
  - Không custom UI checkout; /ea hiện giá gốc + discount trừ khi bật **Price override**. (SBCB2BBS-5210, 5549)
- **Version 5 + Checkout method = "Shopify checkout"** (từ 11/2026; Settings/Advanced settings > Checkout version): giá B2B áp bằng discount function "B2B Discount" ngay trên checkout gốc Shopify. (SBCB2BBS-5618, 5667; be:storefront-mode/compatibility.rules.ts:236-262)
  - Được: automatic discount Shopify chạy với khách B2B; Shopify giữ discount tốt hơn (so trên **tổng giỏ**, không theo dòng); company dùng được "Use a different address".
  - Mất/khác: rule CP/PL **tăng giá** → checkout thu giá Shopify; một số mã DC chỉ nhập ở cart; EF gộp 1 dòng "Extra fee"; SR thành **trần** (khách trả mức thấp hơn giữa SR và rate Shopify); TE ghi cờ tax-exempt lên customer, rule TE cho guest bị chặn. NT và Manual Order vẫn tạo draft order.
  - Điều kiện chuyển v5: đang v3 (v1 cần support), cấp thêm quyền, BOGO ≤200 rule bật (200 chỉ là giới hạn BOGO, không phải tổng rule). (SBCB2BBS-5663, 5667)

## 0c. Nhu cầu → module nên dùng (kiểm trước khi trả lời "không làm được")
- Giảm chồng trên giá B2B (negotiated + promo): phần promo đặt ở **PL** (đè CP, giữ nguyên rule CP), hoặc rule CP % gộp priority cao hơn; tầng theo số lượng = VP; tầng nhập mã = DC hoặc mã Shopify (bật Shopify discount). (SBCB2BBS-5562, 2409)
- Giá cố định theo SKU/variant, nhiều SKU khác giá → PL (Platinum); gói thấp hơn → mỗi giá 1 rule CP "Apply a decreasing price"/"Set a fixed price" + Import CSV (Import CSV cũng Platinum). (help.json:cp-create-rule; SBCB2BBS-5293)
- Giá B2B cao hơn retail → PL Set a fixed price (Apply when = always) hoặc CP tăng giá (Platinum); không dùng được trên POS và v5 Shopify checkout. (help.json:shopify-pos; compatibility.rules.ts:250-252)
- "Lấy giá thấp hơn giữa B2B và giá sale Shopify" → kiểu "Apply a decreasing price" (số tiền cố định); với % thì không làm được. Lấy rule rẻ nhất giữa nhiều rule → setting "When several rules match a product" = Lowest price (từ 11/2026). (SBCB2BBS-5389)
- Giá theo company / location → CP/PL/VP target Company locations (Advanced+); module khác dùng tag (Shopify Flow gắn tag theo company/location). (help.json:how-customer-targeting-works; SBCB2BBS-5197, 4863)
- Giá theo nước/currency → 1 rule/market (Specific markets); MC chỉ đổi hiển thị. (help.json:mc-setup-currencies)
- Free ship / phí ship B2B → SR (thay hẳn rate Shopify) hoặc range Free shipping của EF/DC (thắng SR); free ship theo nước/địa chỉ thật → discount Shopify (cần v5 Shopify checkout hoặc custom). (help.json:sr-create-rule; SBCB2BBS-5196)
- Phụ phí → EF. Thuế: hiển thị → TD; miễn thuế → TE/RF/AT. (help.json:te-setup)
- Thanh toán sau / duyệt đơn trước khi trả → NT (+ Credit limit); payment terms company → setting "Use Shopify Company Location payment terms" (11/2026). (SBCB2BBS-5482, 5670)
- Min/max/bội số → OL (ngưỡng, level variant/product/đơn) + QI (step). (SBCB2BBS-3846)
- Ẩn giá / khoá trang / chặn checkout theo nhóm → B2B Lock; báo giá / quick order / reorder → B2B Quotes. (help.json:new-customer-accounts; SBCB2BBS-5583)
- Khách B2B chỉ thấy sản phẩm B2B, chặn mua hàng retail-only → Shopify B2B catalog của company, Lock (ẩn + Checkout lock), hoặc custom. (SBCB2BBS-5644)

## CP — Custom Pricing
- Làm được: 1 rule = 1 mức điều chỉnh cho cả nhóm sản phẩm (All/collection/product tag/products/variants), theo khách (tag, customers, All, Logged-in, guest, company locations, markets, lịch). Kiểu: Decrease in percentage, Decrease a fixed amount, Apply a decreasing price, Set a fixed price, Increase. Quick create, Import CSV. (help.json:cp-create-rule)
- Cơ chế giá:
  - % và fixed amount tính trên **giá Shopify hiện tại** (không phải compare-at); nếu admin đã hạ giá sale thì CP giảm chồng lên giá sale. (help.json:cp-create-rule; SBCB2BBS-5389)
  - "Apply a decreasing price" chỉ áp khi giá nhập < giá Shopify → tự động "lấy giá thấp hơn" giữa BSS và Shopify. (SBCB2BBS-5389)
  - "Set a fixed price": không có quyền tăng giá (dưới Platinum/Enterprise) thì chỉ giảm ("Lowers prices only…"); có quyền + rule cho tăng thì nâng được lên đúng giá. (sf:modules/cp/core/CpUtilsConcrete.ts:45-50; be:shop/data/plan-entitlements.ts:21)
- Không làm được / giới hạn:
  - Không cộng 2 rule CP (giảm chồng); không so sánh % CP với giá sale Shopify. (SBCB2BBS-5562, 5389)
  - Mỗi sản phẩm 1 giá riêng → phải 1 rule/sản phẩm; 4.000 SKU → dùng PL. (SBCB2BBS-5293; help.json:cp-create-rule)
  - Không revert rule; export không có giá gốc/giá cuối; discount title chung cho CP và VP; không chọn được company-location market (chỉ REGION); giá đầu PDP không đổi theo quantity. (SBCB2BBS-4299, 4657, 5381, 4941, 3635)
- Dùng module khác khi:
  - Giảm chồng → xem 0c (PL cho phần promo, VP, DC). (SBCB2BBS-5562)
  - Giá cố định theo SKU, hoặc giá B2B > retail → **PL**. (SBCB2BBS-3592)
- Hay nhầm / cấu hình hay gặp:
  - "Rule đúng mà không áp" → kiểm: module bật, app embed trên **theme đang publish**, rule Enable + trong lịch, đúng customer có tag, PL đè, rule priority khác, Exclude trùng tag. (help.json:cp-create-rule; SBCB2BBS-4191)
  - Đúng ở checkout, sai ở PDP/cart → theme thiếu marker `bss-b2b-*` → Automatic installation/Ask support (đổi theme phải cài lại). (help.json:cp-display-prices; SBCB2BBS-4673)

## PL — Price List
- Làm được: giá riêng từng product/variant theo nhóm khách/company location/market; Set a fixed price + "Apply when" (always / only if lower / only if higher); Quick create; Import/Export CSV (SKU/handle/barcode). Gói Platinum. (help.json:pl-create-price-list, cp-create-rule)
- Không làm được / giới hạn:
  - "Apply a decreasing price" ở PL chuyển vào "Older options": rule cũ vẫn chạy, không chọn được cho rule mới. "Set a fixed price" (Apply when = always) áp đúng giá kể cả khi retail đang sale thấp hơn → khách B2B trả cao hơn khách lẻ. (SBCB2BBS-5389, 5241)
  - Rule sửa qua API lên storefront sau upload (≤1 lần/5 phút); giá gốc 0 + kiểu decreasing không chạy; export không đổi variant ID thành SKU. (SBCB2BBS-5293, 2879, 3171)
- Quan hệ: PL thắng CP cùng sản phẩm; VP cộng trên PL; POS: PL → CP → VP. (help.json:pl-create-price-list, shopify-pos)
- Hay nhầm: customer tag nằm cả ở Apply và Exclude → rule không áp. PL/CP dùng chung "Price display". Theme selectors của PL nằm dưới CP. (SBCB2BBS-4191; help.json:pl-display-prices)

## VP / QB — Volume Pricing (Quantity Break, bảng giá theo số lượng)
- Làm được: break theo quantity hoặc amount; "Apply to": Each product / Each variant / Each collection / All products that use this rule (one total — cộng số lượng nhiều sản phẩm). Bảng ở PDP/Cart/Mini cart, ẩn bảng vẫn giảm. (help.json:qb-create-rule, qb-display-prices)
- Cơ chế: tính trên giá sau PL/CP (giảm chồng). Mỗi sản phẩm dùng 1 rule VP priority cao nhất; item thuộc rule khác không được tính vào tổng. (help.json:qb-create-rule; SBCB2BBS-5562)
- Không làm được / giới hạn:
  - Không tương thích Shopify automatic discount / BXGY / app bundle (Kaching Bundles) trên draft order checkout. (SBCB2BBS-2991, 5495)
  - Checkout hiển thị /ea giá gốc + discount line (giới hạn Shopify). (SBCB2BBS-5549)
  - Không hiện trên sản phẩm Unlisted; bảng chỉ đổi vị trí qua `bss-b2b-qb-table`; Free plan: 1 rule, ≤2 tier. (SBCB2BBS-3288, 4949; help.json:plans-billing)
- Dùng module khác khi: cần 1 giá cố định theo SKU → PL; giảm thêm cho "đơn đạt X" kiểu mã → DC. Cộng số lượng nhiều SKU khác nhau → VP "All products that use this rule", không phải tách rule. (SBCB2BBS-5562)

## DC — Discount Codes (mã giảm giá B2B của app)
- Làm được: mã do app quản lý, khách nhập ở **ô Discount Code trên cart page** (block "BSS Discount Code"), giảm tiếp sau PL/CP/VP/BOGO; target khách; Quick create; Usage history. (help.json:dc-create-code; sf:utils/price.ts:27-28)
- Không làm được: mã DC không nhập được ở ô discount của Shopify checkout (draft); không dùng trên POS; block không hiện cho khách không khớp mã nào. Shopify không tra cứu được mã chỉ tạo trong app. (help.json:dc-create-code; SBCB2BBS-4639)
- Dùng khác khi: cần mã Shopify (BXGY, free ship) cùng giá B2B → bật "Shopify discount" ở Settings > Shopify checkout settings. (help.json:bogo-create-offer, checkout-settings)

## BOGO — Buy One Get One
- Trạng thái: BOGO v1 đã khai tử; BOGO mới vẫn được dev/TS hỗ trợ từ 10–11/2026 (dù SBCB2BBS-4994 10/2026 khuyên không dùng) → coi là đang hoạt động. (SBCB2BBS-5041, 5572, 5640)
- Làm được: giảm số lượng quà đủ điều kiện, tính trên giá B2B, trước DC; áp cả đơn Net Terms; block "BSS BOGO Cart" hiện tiến độ/nút Add gift. (help.json:bogo-create-offer)
- Không làm được: **không tự thêm quà vào giỏ** (khách tự thêm); "max N free" = số cái được tặng, không giới hạn thêm vào giỏ; label = tên rule, không dịch. (SBCB2BBS-5640, 5572, 5543)

## Shopify POS (Integrations > Shopify POS, tile "BSS B2B Price")
- Platinum/Enterprise. Thứ tự PL → CP → VP, luôn By priority; chỉ áp khi giá B2B thấp hơn (không tăng giá); không đọc rule company location/collection. Shop có automatic discount active → Shopify khoá API giảm giá thủ công trên POS. DC không dùng ở POS. (help.json:shopify-pos; SBCB2BBS-4579, 5388)

## NT — Net Terms (Pay later)
- Làm được: nút Pay later + popup form cho khách đã login khớp rule (guest không thấy); Order submission: "Submit all orders as drafts for review" (mặc định) / "Automatically submit orders"; ẩn nút Checkout thường; form thêm field (PO number, file upload, tax ID). (help.json:nt-setup, nt-settings; SBCB2BBS-5670)
- Không làm được / giới hạn: payment terms chỉ gắn vào đơn đặt bằng Pay later; trang Orders của NT chỉ xem, đánh dấu đã trả làm trong Shopify. Pay later không hiện cho khách không khớp rule là đúng thiết kế. (help.json:nt-setup, nt-manage-orders; SBCB2BBS-4516)
- Shopify Company payment terms: tới 10/2026 không đọc được (workaround tag + NT); từ 11/2026 có "Use Shopify Company Location payment terms" (khoá ở gói thấp) + "Assign draft orders to the Shopify company"; NT target Company locations. (SBCB2BBS-5197, 5482, 5589)
- Dùng khác khi: đặt đơn chưa trả → sửa ship → 1 invoice: NT "drafts for review" + sửa draft + Send invoice; hạn mức nợ → Credit limit. (SBCB2BBS-5670)

## Credit limit (add-on, tab trong Net Terms, từ 10/2026)
- Làm được: rule theo logged-in/tag/khách (ưu tiên Customer > Tag > Global); Warn only / Ask me to approve / Block Pay later; khoá khi có đơn quá hạn, temporary limit ≤90 ngày, tag bss-credit-hold/over/near, hiện còn lại cho buyer, cảnh báo trong MO. (help.json:credit-limit, nt-setup; be:credit-limit)
- Giới hạn: chỉ chặn Pay later (khách vẫn trả ngay được); đơn admin/POS không có payment terms không tính; chưa cấp "all orders" thì chỉ đọc 60 ngày đơn. (help.json:credit-limit)

## TE — Tax Exempt (VAT ID / EIN)
- Làm được: ô tax ID ở cart (app block), kiểm EU VAT (VIES), UK VAT, US EIN (EIN = Platinum); "Automatically exempt tax for valid tax IDs", giới hạn theo nước (theo tiền tố VAT, không theo địa chỉ); VAT lưu vào note + attribute đơn. (help.json:te-setup)
- Không làm được: không có điều kiện phủ định ("mọi khách trừ tag X"); tag OR; chỉ miễn thuế, không thêm thuế; không ghi vào field VAT/Tax ID gốc Shopify (API); VAT chỉ lưu trong Shopify admin (không nhập ô BSS) thì app không trừ thuế. (SBCB2BBS-5118, 4971, 4491, 5479)
- Dùng khác khi: miễn thuế cố định khi duyệt đăng ký → RF "Auto exempt tax…" hoặc AT "Mark customer as tax exempt"; thuế theo AND nhiều tag → đảo logic hoặc Shopify Flow. (help.json:te-setup; SBCB2BBS-4971)
- Hay nhầm: TE làm mất Shopify payment terms của company (đơn qua draft) → dùng NT. (SBCB2BBS-5129)

## TD — Tax Display
- Làm được: hiện giá Excl./Incl. VAT, "Let customers switch" (toggle chỉ storefront v3; v1 không có), override theo country/collection; Sync from Shopify. (help.json:td-create-rule; SBCB2BBS-5350, 5342)
- Không làm được: không đổi thuế thu ở checkout; không đọc thuế theo product/category của Shopify; không ép 1 mức cho mọi nước; không hiện 3 lớp giá; lệch làm tròn nhỏ giữa storefront và checkout là không tránh được. (help.json:td-create-rule; SBCB2BBS-4311, 5473, 2127, 2278)

## SR — Shipping Rate
- Làm được: rate theo range quantity/amount/weight, theo tag/market; Settings chọn lowest/highest rate (toàn shop); free ship = range giá 0. (help.json:sr-create-rule)
- Không làm được (draft checkout): rule khớp → rate app là shipping line duy nhất, mất rate Shopify/carrier/Local pickup; market theo market đang xem, đổi địa chỉ ở checkout không tính lại; ngưỡng tính trước discount code; không theo warehouse. (SBCB2BBS-3928, 1774, 5428, 5263)
- Quan hệ: free ship từ DC hoặc EF thắng SR. Trên v5 Shopify checkout, SR thành mức trần. (help.json:sr-create-rule; compatibility.rules.ts:259)
- Dùng khác khi: free ship theo từng nước trong 1 market / theo địa chỉ thật → discount free ship của Shopify (cần custom cho draft nhận automatic discount, hoặc v5 Shopify checkout); pickup cho B2B → workaround nút chọn pickup/shipping ở cart (custom). (SBCB2BBS-5196, 5516)

## EF — Extra Fee
- Làm được: phụ phí theo khách, product/collection/tag, tier quantity/amount, có range Free shipping; phí là custom line không SKU; "Automatically apply tax to Extra Fee". (help.json:ef-create-rule)
- Không làm được: theo variant/tồn kho/kho; setting dùng chung toàn shop; MO không thêm EF. (SBCB2BBS-5387; help.json:ef-settings, mo-create-order)

## OL — Order Limits
- Làm được: min/max quantity/amount; "Choose level to limit": mỗi variant (mặc định) / mỗi product / toàn đơn; "Block at checkout" (tắt mặc định, ≤200 rule) chặn cả /checkout trực tiếp. (help.json:ol-create-rule; SBCB2BBS-4464)
- Không làm được: Block at checkout tắt → /checkout trực tiếp bỏ qua; không kiểm POS; app tách line (gift app) làm OL bỏ qua. Popup chặn checkout ở cart là thiết kế. (help.json:ol-create-rule; SBCB2BBS-4079, 4147)
- Hay nhầm: "min áp từng SKU thay vì tổng giỏ" → đổi level sang toàn đơn. OL ≠ QI. (SBCB2BBS-4464, 3846)

## QI — Quantity Increments
- Làm được: step/min/max, kiểm ngay ở PDP; popup chặn checkout trong cart; "Cart enforcement" (Settings, tắt mặc định, chỉ storefront v3) tự sửa số. (help.json:qi-create-rule)
- Không làm được: không import CSV (chỉ export); /checkout trực tiếp, đơn API/import bỏ qua QI (validate client-side). (SBCB2BBS-5351, 4316)

## RF — Registration Forms + AT — Auto Tags
- RF làm được: form 1 trang (v2) trên trang store, multi-step (trong customer account), auto/manual approval, "Auto approve if email contains", "Assign tag when customer is approved", "Hide password field", tax ID field. (help.json:rf-create-form, new-customer-accounts)
- RF không làm được: New Customer Accounts bỏ /account/register → form v1 ở đó không hiện, publish lên trang riêng; data form v1 chỉ xem; conditional logic = Platinum; export không kèm file upload. (SBCB2BBS-5636, 5221, 3855, 5590)
- RF hay nhầm: khách pending vẫn thấy giá vì rule CP/Lock theo "Logged-in" → dùng tag duyệt. (SBCB2BBS-5630; help.json:cp-create-rule)
- AT làm được: event Customer created + Order created/paid/fulfilled/canceled, điều kiện theo câu trả lời RF, add/remove tag, mark tax exempt, "Apply to existing customers". AT không chạy khi customer update, không tự gỡ tag khi hết khớp (dùng Shopify Flow); chọn any/all điều kiện đúng. (help.json:auto-tags; SBCB2BBS-5203, 1985)

## MO — Manual Orders
- Làm được: admin tạo đơn với giá CP/PL/VP, SR làm B2B shipping rates, Company location hoặc Personal order, Payment due later, Send invoice, ≤499 dòng. (help.json:mo-create-order)
- Không làm được: không áp EF/OL/TE/NT; rule nhắm company location không áp; rule theo Market chưa lọc đúng nước khách → áp nhầm PL nước khác (bug, workaround rule priority cao hơn). (help.json:mo-create-order; SBCB2BBS-3996, 5556, 4289)

## MC — Multi-currency
- Chỉ đổi giá hiển thị + switcher, tỷ giá Shopify; khách trả bằng tiền store. Không ép mọi đơn B2B về 1 currency. Giá riêng theo nước → mỗi market 1 rule CP/PL (Specific markets). MC cấu hình sai có thể làm mất giá B2B. (help.json:mc-setup-currencies; SBCB2BBS-5633, 3886)

## Sales Reps / Recurring Orders / B2B Portal (add-on)
- Sales Reps: rep là customer account, đặt draft trong portal với giá B2B của khách, Maximum discount, commission; không dùng discount code; cần gói có NT. (help.json:sales-reps)
- Recurring Orders: draft mỗi kỳ với giá B2B ngày đó. B2B Portal: trang buyer (credit, đơn). (be:recurring-orders; help.json:b2b-portal)

## Solution KHÔNG có (chuyển app/giải pháp khác)
- Loyalty → Shopify Flow + tag + CP, hoặc app loyalty. Chia tồn kho theo nhóm khách, pickup theo tag, sửa UI checkout: không hỗ trợ. (SBCB2BBS-5664, 5188, 4880, 5210)

# Quote (BSS B2B Quotes / Customer Portal)
Nguồn code: `/home/bss-group/BSS/b2b_quote` — admin v2 `cms/web/client`, admin v1 `cms/web/frontend`, API `api/src/script-v2`.

## Chung
- Quote v1 (module QO/BK/NT/VO/CA/R4Q/RO/SR, không phát triển thêm) và Quote v2 (Quotes / Quick order / Sales agents / Integrations). Gói v2: Starter / Growth / Business / Enterprise. (SBCB2BBS-5173; client/helper/plan.helper.js:48-85)

## R4Q / RFQ — Request for Quote (Quote logic, form, widget)
- Làm được: nút Add to quote theo logic khách/sản phẩm; ẩn giá/ATC/Buy it now theo logic; template "Quote from cart"; form custom field/upload/Subtotal; New look (counter-offer) hoặc Classic; Translations R4Q/QO/RO. (locale r4q.logicDetail.hidePrice)
- Gói: Hide prices = Growth+; nút ở Collection page = Business+ (Quick View chỉ custom, cần Business); nút ở Cart page bị từ chối khi chưa Business (cần xác nhận); logic theo company = Enterprise. (SBCB2BBS-4568, 4803; plan.helper.js)
- Không làm được: dịch label field trong form; variant do app thứ 3 tạo; sản phẩm `seo.hidden`/bị chặn search.js → không có nút. (SBCB2BBS-5242, 5295, 2923, 4951)
- Hay nhầm: nút không hiện → chỉnh Settings > Placement (selector); nút trong Shadow DOM → dùng `bcp-custom.css`; Hide ATC hỏng khi PDP có block FBT của app khác; submit lỗi → Proxy URL trùng app khác. (SBCB2BBS-5508, 5629, 5024, 5209)

## Quotes — quản lý quote, convert Draft Order, Automations
- Làm được: sửa Quoted price/ship/thuế, gửi proposal, Convert → Draft Order → Send invoice, Automations (auto-convert/send, expiration, reminders), Quote PDF.
- Giới hạn: header email cố định, tên field trong email không dịch; "Send to" owner chỉ 1 email. (SBCB2BBS-5300, 4773, 4684)
- Hay nhầm: convert ra giá retail ở v1 vì thiếu company (v2 gửi purchasingCompany); Auto send proposal đổi status sang Under review. (SBCB2BBS-4879, 5313; api/src/script-v2/modules/r4q/internal.ts:1816)

## QO — Quick Order pages (Universal link, Variant table)
- Làm được: nhiều trang QO, lọc collection/price (type/vendor/tag = Growth+), import CSV, Universal link (1 URL liệt kê trang khách đủ điều kiện); tìm theo SKU từ 10/2026 (trước đó không). (SBCB2BBS-5112, 4350)
- Không làm được: trang cho Company customers cần Enterprise; không có điều kiện theo Location (workaround tag qua Flow); tối đa 2.500 sản phẩm; QO v1 không tương thích SR của Solution; Variant table không Translations, chỉ giá retail. (SBCB2BBS-4749, 4863, 5413, 5173, 4670, 4869)

## Sales agents (v2) / Sales Rep (v1)
- Agent đặt Draft Order thay retailer trên trang QO; bật "Let sales agents order for retailers"; 1 retailer thuộc 1 agent; "Reserve stock (hours)" ≤168. Cần Business/Enterprise. Sales Rep v1 ≤30 rule nếu không phải Premium/Business. (SBCB2BBS-5467; frontend/pages/configurations/sr/index.lazy.jsx:98)

## RO — Reorder; NT/CA/BK/VO (v1)
- Reorder = Growth+; reorder từng line phải custom. (SBCB2BBS-4534)
- Net Term, Company Account, Bundle Kit, Multi-variant Order chỉ có ở v1; lên v2 mất Staff Checkout/NT v1. (SBCB2BBS-4796; frontend/enums/shop.jsx)

## Quan hệ Quote ↔ Solution / Lock
- Giá quote mặc định lấy từ catalog Shopify, **không** gồm CP/PL/VP của Solution; muốn giá Solution thì nhập Quoted price, hoặc bật Integrations > "Apply B2B Solution pricing to company customers" (mặc định tắt; đặt giá ở cả 2 nơi thì giảm cộng dồn). Khách không dùng Shopify B2B: QO/quote cart dùng giá Solution ("Integrate prices and qty rules with B2B Solution App" = Growth+). (locale r4q.quoteDetail.solutionPriceNotice, integration.b2bSolutionPricing)
- TD toggle của Solution chưa tương thích QO; Solution không có QO/Reorder → dùng Quote. (SBCB2BBS-4184, 5583)
- Lock khoá được trang QO theo tag nhưng không lọc sản phẩm bên trong/không theo Location; ẩn widget/form Quote bằng Lock target Sections với selector `bcp-r4q-widget-main` / `bcp-r4q-form-wrapper`. (SBCB2BBS-4863, 3335)

# Lock (BSS B2B Lock / Login to access pages)
Nguồn code: `/home/bss-group/BSS/b2b_lock` — L = `b2b-login-access-management-cms/web/client/public/locales/en/locks.json`, H = `…/en/help.json`, D = `board/docs/`.

## Chung (Lock v2 "Locks")
- Lock Target → Access & Message → Exclude Pages. Condition trong 1 rule = **AND**, giữa rule = **OR** (khác Solution). ≤10 rule/lock. (L:160-162; H:716)
- Free chỉ "Entire store"; target khác, passcode, Checkout lock cần gói trả phí/trial. (H:254-270; SBCB2BBS-5092)
- Bắt buộc App Embed; theme mới/update phải Install code lại. Không áp cho Buy Button, Shop App, Shop Pay. (H:84)
- v1 và v2 không chạy song song. v1 = module Page/Price/Product restriction + "Login view prices" (auto install cũ, thiếu theme mới). Nâng v1→v2 TS làm từng case; từ 11/2026 nếu nâng làm đổi plan thì chưa hỗ trợ. (SBCB2BBS-5579, 5420, 5634)

## Price and add to cart (ẩn giá)
- Làm được: Hide price / "Keep price visible, hide Add to cart"; "Disable Add to cart" hoặc "Hide Add to cart"; theo tags/collections/products/variants; "Hide price on Google search". (L:300-331)
- Cơ chế: Liquid `bss-lock-condition` trong file giá/nút của theme → theme custom, cart drawer, quick add, giá vẽ lại bằng JS cần TS install. (SBCB2BBS-4602)
- Không làm được: không chặn `/cart/add.js`/permalink (→ Checkout lock); không ẩn Web Pixels `data-events`, `og:price`; không chặn dữ liệu BSS_B2B của Solution. (SBCB2BBS-5327, 4897, 4807, 4288)
- Hay nhầm: Disable ATC bị bypass trên vài trình duyệt/theme → đổi sang Hide (hoặc ngược lại khi theme can thiệp); khách login sai tag thấy "Price is locked" là đúng; khách pending thấy giá vì rule "Signed-in" + New Customer Accounts → dùng tag duyệt. (SBCB2BBS-4319, 3439, 5630)

## Products / Collections / Variants
- Products: "Fully Hide Product" hoặc chỉ khoá PDP. Predictive search JS → fix "Remove hidden products from search suggestions" (support bật); khoảng trống collection → "Fill gaps left by hidden products". (L:275-277; SBCB2BBS-5225)
- Collections: Hide collection cards / product cards / product pages / navigation menu; nhóm khách thấy hàng khác nhau → ẩn theo collection. (H:518; SBCB2BBS-5460)
- Ẩn sản phẩm chỉ là ẩn, không chặn mua nếu đã vào giỏ bằng đường khác → Checkout lock. (SBCB2BBS-5644)

## Pages, blogs, URLs / Sections
- Pages/URLs: "Exact URL"/"Starts with", path bắt đầu `/`. Khoá page không ẩn menu item → target Sections (Native/Custom CSS selector), cũng dùng cho block app thứ 3, header. Menu Shopify/Customer Account không đồng bộ theo rule. (SBCB2BBS-3889, 5639, 4199, 4490)

## Entire store / Access Denied / Login redirect
- Message: Login form / Sign-up form / Custom message / Custom page; redirect sau login: Current/Custom/Account/"Redirect by customer tag"; Exclude Pages nên tick Customer areas. (L:1049-1095, 1340-1375)
- New Customer Accounts: Login form/Sign-up form "NOT SUPPORTED" → dùng Custom message/Custom page; `return_to` bị bỏ qua. Không nhúng form RF của Solution inline → đặt link login/trang RF trong message. (H:850; SBCB2BBS-4671, 3310)
- Access Denied Message: FAQ nói có editor HTML, TS 09/2026 nói chỉ text (cần xác nhận). Không có ảnh nền cho Custom Message. (H:863; SBCB2BBS-4272, 5033)

## Conditions
- Cần login: Signed-in, Tag, Specific customers, Email domain, Company, Request access. Guest dùng được: Passcode, Secret link, Age, Date, URL parameter, Market, Location, IP. "Reverse access rule" đảo được (trừ Passcode/Secret link/Date/Request access). (H:1033, 983)
- Request access bắt buộc login; Date "sau X" AND "trước Y" bất khả thi → không bao giờ mở; 1 passcode chung page + collection trên v1 phải custom. (SBCB2BBS-4323, 5584, 5420)

## Checkout lock (Shopify Functions)
- Lock (chặn checkout + error), Payment ("Hide Payment & Express Checkout Options", hide all hoặc theo tên method), Shipping (ẩn method). Cần gói trả phí/trial. (D/checkout-lock/*)
- Giới hạn: Payment/Shipping chỉ ẩn, không chặn; Shopify giới hạn **25 payment customization active toàn store** (tính cả app khác). (SBCB2BBS-477)
- Mâu thuẫn: SBCB2BBS-4868 (10/2026) nói không ẩn riêng được ACH, nhưng Payment rule có "hide specific methods" → cần xác nhận (có thể store v1/plan thấp).

