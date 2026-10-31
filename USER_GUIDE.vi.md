# Memory Weaver — Hướng dẫn sử dụng

> Phiên bản tài liệu: v0.9.2. [English](USER_GUIDE.md) · **Tiếng Việt** — Tổng quan nhanh: [README.vi.md](README.vi.md).
> Thư mục extension tuỳ cách cài: cài bằng Git URL tạo `data/<user>/extensions/SillyTavern-MemoryWeaver/`; chép tay thì tên thư mục do bạn đặt.
> Giao diện mặc định là **English**; chọn **Tiếng Việt** (hoặc **Tự động** — theo ngôn ngữ của SillyTavern) ở ô **Ngôn ngữ** trên cùng Extensions → Memory Weaver. Chỉ giao diện được dịch — prompt gửi cho AI giữ nguyên. Hướng dẫn này dùng nhãn tiếng Việt.

## Mục lục

1. [Khái niệm cốt lõi](#1-khái-niệm-cốt-lõi)
2. [Bắt đầu](#2-bắt-đầu)
3. [Nút trên send form](#3-nút-trên-send-form)
4. [Dashboard](#4-dashboard)
5. [Quản lý memory](#5-quản-lý-memory)
6. ["AI có nhớ chuyện này không?"](#6-ai-có-nhớ-chuyện-này-không)
7. [Cốt truyện theo chương](#7-cốt-truyện-theo-chương)
8. [AI gộp & dọn memory, hoàn tác một lượt](#8-ai-gộp--dọn-memory-hoàn-tác-một-lượt)
9. [Lịch trình](#9-lịch-trình)
10. [Vector recall — tìm memory cũ theo chủ đề](#10-vector-recall--tìm-memory-cũ-theo-chủ-đề)
11. [AI cập nhật memory thế nào](#11-ai-cập-nhật-memory-thế-nào)
12. [Dùng trong chat Storyline](#12-dùng-trong-chat-storyline)
13. [Slash commands](#13-slash-commands)
14. [Tham khảo cài đặt](#14-tham-khảo-cài-đặt)
15. [An toàn dữ liệu & riêng tư](#15-an-toàn-dữ-liệu--riêng-tư)
16. [FAQ & xử lý sự cố](#16-faq--xử-lý-sự-cố)

---

## 1. Khái niệm cốt lõi

- **Memory** = một fact ngắn đã được xác lập trong truyện: `"Alice biết lối đi bí mật dưới sàn thư viện"`, `"USER bị thương vai trái"`, `"Ngày 13: hẹn đi ăn sáng với Mai"`. Mỗi memory có: nội dung, **tên liên quan** (entity — nhân vật/vật/nơi), **mức quan trọng** (1 Thường / 2 Quan trọng / 3 Cốt lõi), thời gian tạo và đoạn tin gốc.
- **Tin được đếm** = tin hội thoại thật. Tin hệ thống, tool call, tin narrator rỗng **không được đếm** — mọi ngưỡng và thanh tiến độ đều đếm tin thật.
- **Con trỏ** = "đã ghi nhớ tới tin nào". Đây là chỉ số nội bộ; dashboard hiển thị dưới dạng số tin đã ghi nhớ.
- **Mức quan trọng** quyết định thứ tự trong prompt: Cốt lõi (3) luôn đứng trên. Khi kho đầy (mặc định 150 memory, tối đa chỉnh được 500), mục trùng / tạm thời / ít quan trọng + cũ bị lược trước; mục đã 🔒 khoá hoặc 📌 ghim không bao giờ bị lược.
- **Kho** = local variable `memoryWeaverState` của chat, **riêng từng chat**. Tắt extension hay xoá memory là thao tác hợp lệ — extension không tự "phục hồi" thứ bạn cố tình xoá.

## 2. Bắt đầu

1. Cài extension (Extensions → Install extension → dán URL repo → *Install just for me*).
2. Mở một chat bất kỳ → nút **🧠 Memory** xuất hiện cạnh ô gửi tin.
3. Mặc định ở chế độ **Tự động**. Cứ chat bình thường — sau mỗi 20 tin hội thoại (mặc định), lượt AI ngầm tự chạy và tạo memory đầu tiên.
4. Bấm nút 🧠 để mở **dashboard** — xem tiến độ, duyệt memory, sửa/xoá, thêm tay.

Yêu cầu duy nhất: LLM bạn đang dùng để chat (lượt ghi nhớ dùng chính connection đó).

## 3. Nút trên send form

Nút **🧠 Memory** cạnh ô chat:

- **Badge `13/20`** — số tin mới / ngưỡng ở chế độ **Tự động**: còn bao nhiêu tin nữa thì tự ghi nhớ. Ở chế độ khác badge hiện **`N chờ`** (N tin chưa ghi nhớ).
- **`sẵn sàng`** (viền xanh) — đủ ngưỡng, câu trả lời AI kế tiếp sẽ kích hoạt lượt ghi nhớ.
- **`đang ghi…`** (hoặc `đang ghi… (N)` khi đang **Ghi nhớ toàn bộ**) — một lượt ghi nhớ đang chạy.
- **`lỗi`** (đỏ) — lần chạy cuối thất bại, state không hợp lệ, hoặc bị chặn bởi tin quá dài. Bấm → mở thẳng tab **Tình trạng**.
- **`cần xem`** (vàng) — lịch sử chat đã bị sửa/xoá sau khi được ghi nhớ (hoặc phần ghi nhớ từ bản cũ chưa đối chiếu). Không phải lỗi. Bấm → tab **Tình trạng** để **Rà soát lại** hoặc **Bỏ qua**.
- **`N hẹn`** — có N hẹn đến hạn. Bấm → tab **Lịch trình**.
- **`tắt`** (mờ) — extension đang tắt.

Trên điện thoại chỉ còn icon + badge. Nút nằm sau nút Character Sheet nếu có cài character-state. Mất nút → tải lại trang (F5).

## 4. Dashboard

Mở bằng nút 🧠 hoặc `/memories`. Bố cục:

- **Đầu trang** — trạng thái (vd "Tự động · lần tới sau N tin" / "Đang ghi nhớ…" / "Đang tắt"), nút **Ghi nhớ ngay** và menu **⋯**: *Quét lại 60 tin gần nhất*, *AI gộp & dọn memory*, *Xuất memory ra file .md*, *Nhập memory từ file .txt/.md*, *Đồng bộ lại vector index* (khi bật vector recall), *Xoá toàn bộ lịch trình…*, *Xoá toàn bộ memory…*.
- **Thanh tiến độ mảnh** — đã ghi nhớ X / Y tin, số tin đang chờ + kết quả lần chạy cuối. Chat dài chưa ghi nhớ có nút **Ghi nhớ toàn bộ** (bấm **Dừng** để dừng).
- **Băng cảnh báo** — chỉ hiện khi có việc cần xử lý, kèm nút sửa ngay (*Thử lại*, *Rà soát lại*, *Bỏ qua tin này*, *Bật lại*, *Đặt N token*…).
- **5 tab**:
  - **Memories** — danh sách chính ([mục 5](#5-quản-lý-memory)).
  - **Trong prompt** — đúng khối `[Chat Memories]` AI sẽ thấy ở tin kế tiếp: bao nhiêu memory được chèn, bao nhiêu token, theo nhóm (Đã ghim / Nền tảng / Cảnh hiện tại / Cốt lõi / Gần đây), khối lịch trình đi kèm, nút **Sao chép khối**, và ô chẩn đoán ([mục 6](#6-ai-có-nhớ-chuyện-này-không)). **Khi AI "quên", xem tab này trước.**
  - **Cốt truyện** — các chương tóm tắt ([mục 7](#7-cốt-truyện-theo-chương)).
  - **Lịch trình** — hẹn & ngày trong truyện ([mục 9](#9-lịch-trình)).
  - **Tình trạng** — mọi cảnh báo + nút xử lý, thống kê, **lịch sử 10 lần chạy** (kết quả, đoạn tin, model, thời gian, token ước tính, *Xem thay đổi* + *Hoàn tác lượt này*), **Dọn memory trùng lặp**, vector recall, **Công cụ** (Quét lại 60 tin gần nhất, AI gộp & dọn memory, Xuất file .md, Nhập file).

Chỉ có **một thanh cuộn**; thanh tab (và thanh lọc trên màn hình rộng) dính trên cùng. Dashboard **không nhảy vị trí** khi dữ liệu đổi; ô đang gõ, con trỏ gõ và bản nháp được giữ.

## 5. Quản lý memory

- **Tìm không cần dấu**: gõ "sieu thi" vẫn ra "siêu thị".
- **Lọc**: chip mức độ (Tất cả / Cốt lõi / Quan trọng / Thường) + chip tên (các tên nhiều nhất; còn lại ở ô *Lọc theo tên khác*) + lọc **Trong prompt / Không trong prompt**. **Sắp xếp**: Mới nhất trước / Quan trọng trước / Theo dòng truyện / Cũ nhất trước.
- **AI đang thấy** (chấm xanh) trên một dòng = memory đó đang nằm trong khối được chèn vào prompt.
- **Sửa** (bút chì): sửa tại dòng → **Lưu** (Ctrl+Enter), **Esc** để huỷ. Nội dung trùng y hệt memory khác bị chặn.
- **Xoá** (thùng rác): có **hoàn tác 1 cấp** — bấm toast ngay sau đó (~8 giây).
- **🔒 Khoá**: AI không được sửa/xoá, không bao giờ bị lược khi đầy kho. Bạn vẫn sửa/xoá được. Khoá **không** bắt AI phải thấy memory đó.
- **📌 Ghim vào prompt** (tách khỏi khoá từ v0.8): memory **luôn** được chèn cho AI ở mọi lượt (và tự được khoá). Tối đa 10 memory, chiếm tối đa ~35% dung lượng khối — dành cho fact "không được phép quên" (quan hệ, bí mật, lời hứa).
- **Mở tin gốc**: bấm "tin #A–B" (hoặc "≈ tin #N" với memory cũ) để nhảy tới đoạn chat đã sinh ra memory.
- **Thẻ nhân vật + gộp tên**: bấm chip một tên → thẻ thống kê; nếu có tên na ná ("Yamada Rika", "Rika-chan") → **Gộp N tên vào "Rika"**; hoặc **Đổi tên…** (gõ một tên đã có để gộp). Có hoàn tác. Thẻ cũng có **AI dọn memory của tên này**.
- **Chọn nhiều**: tick ô đầu dòng (hoặc **Chọn tất cả đang hiện**) → thanh dưới cùng: **Ghim vào prompt / Khoá / Mở khoá / Đổi mức… / Xoá / Bỏ chọn**.
- **Thêm tay**: nút **Thêm memory** (Ctrl+Enter để thêm), hoặc `/memories action=add entity=Alice importance=3 <nội dung>`.
- **Xuất / nhập file**: menu ⋯ hoặc tab Tình trạng → Công cụ (xuất `.md`, nhập `.txt/.md`). Dòng không an toàn khi nhập bị từ chối và được đếm.
- **Quét lại 60 tin gần nhất**: cho AI đọc lại đoạn cuối — **không** đặt lại phần đã ghi nhớ (con trỏ giữ nguyên); memory hiện có được giữ, trùng bị lọc. Dùng khi kho trống dù chat đã được đánh dấu là đã ghi nhớ.
- **Rà soát lại / Bỏ qua**: khi bạn sửa/xoá/swipe tin đã được ghi nhớ, nút chuyển **cần xem** và tab Tình trạng báo "Lịch sử từ tin #N đã bị sửa/xoá…". **Rà soát lại** cho AI đọc lại đúng đoạn đó và sửa memory cho khớp; **Bỏ qua** nếu thay đổi không quan trọng. Nếu chat bị xoá ngắn hơn phần đã ghi nhớ, dùng **Chấp nhận lịch sử hiện tại**; phần ghi nhớ từ bản cũ có nút **Đánh dấu đã kiểm tra**.
- **Bỏ qua tin quá dài**: nếu một tin cực dài chặn lượt ghi nhớ, bấm **Bỏ qua tin này** trên cảnh báo (hoặc bấm toast). Tin đó không chặn lại nữa và tự quay lại hàng chờ nếu được rút ngắn.
- **Ghi nhớ toàn bộ**: chat dài chưa ghi nhớ → chạy liên tục từng lượt tới hết (bấm lại để dừng).

## 6. "AI có nhớ chuyện này không?"

Tab **Trong prompt** → ô **AI có nhớ chuyện này không?** — gõ điều AI vừa quên (không cần dấu). Mỗi memory khớp có kết luận:

- **Đang trong prompt** (xanh) — AI có thấy; nếu vẫn quên là do model: thử **Ghim vào prompt** hoặc **Nâng Cốt lõi**.
- **Không vừa dung lượng** — đủ điều kiện nhưng hết chỗ: **Ghim vào prompt** hoặc **Đặt N token**.
- **Bị bộ lọc loại** (khi không dùng vector) — không phải Cốt lõi, không gắn USER/nhân vật, không thuộc nhóm mới nhất: **Nâng Cốt lõi** hoặc **Ghim**.
- **Lượt này chưa liên quan** — không được nhắc trong các tin gần nhất, không có kết quả vector; sẽ được kéo lên khi cảnh liên quan.
- **"Chuyện này ở tin #N — CHƯA được ghi nhớ"** — fact còn nằm trong phần chat chưa xử lý: **Ghi nhớ ngay** / **Mở tin**.
- Không thấy ở đâu → **Thêm memory này** (điền sẵn nội dung).

## 7. Cốt truyện theo chương

- Sau lượt ghi nhớ, khi đã có thêm ~100 tin **đã ghi nhớ** kể từ chương trước (chỉnh ở Cài đặt → Tính năng → *Mỗi chương ≈ số tin*), AI viết một chương: tin #A–B, tên chương, tóm tắt.
- Khối **"câu chuyện tới giờ"** được đưa vào prompt chính và vào lượt ghi nhớ (ngân sách mặc định 600 token); khi quá dung lượng, chương cũ chỉ còn tên.
- Tab **Cốt truyện**: **Viết chương tiếp theo** / **Viết lại chương cuối**; mỗi chương **Sửa** / **Khoá** (AI không viết lại) / **Xoá**. Chương bị cũ do sửa/xoá tin trong đoạn của nó được đánh dấu kèm **Viết lại chương này**.
- Trần 60 chương: khi đầy, hai chương cũ nhất được gộp lại.

## 8. AI gộp & dọn memory, hoàn tác một lượt

- **AI gộp & dọn memory**: menu ⋯, tab Tình trạng → Công cụ, hoặc thẻ nhân vật (**AI dọn memory của tên này**). AI chỉ **sửa/xoá** (không thêm): gộp câu diễn đạt lại, thay fact cũ bằng fact mới, bỏ chi tiết vụn, chuẩn hoá tên, cân lại mức Cốt lõi. Không đụng mục khoá/ghim. Tự chạy sau mỗi N lượt tự động nếu đặt *Tự cho AI gộp & dọn memory sau mỗi N lượt* > 0 (mặc định 0 = chỉ bấm tay).
- **Hoàn tác lượt**: tab Tình trạng → **Xem thay đổi** dưới một lượt chạy (thêm / sửa trước → sau / xoá) → **Hoàn tác lượt này**. Lưu cho 3 đợt chạy gần nhất; cả đợt (mọi đoạn của một lần chạy) được hoàn tác cùng lúc. Memory bạn đã sửa sau lượt đó được giữ nguyên (bỏ qua). Không hoàn tác được nếu lượt quá lớn hoặc đã xoá toàn bộ memory sau đó. Các tin đã đọc **không** tự được ghi nhớ lại — dùng **Rà soát lại** hoặc **Quét lại** nếu cần.
- **Dọn memory trùng lặp** (tab Tình trạng): **Tìm memory trùng** → mỗi cụm có **Gộp N thành 1** (có hoàn tác). Không bao giờ tự gộp.

## 9. Lịch trình

Dành cho **hẹn hò, lời hứa, sự kiện tương lai** — thứ memory thường hay "quên đúng lúc".

### Thêm hẹn
Tab **Lịch trình** → **Thêm hẹn**:
- **sau … tin** (khuyên dùng — tự đếm, không phụ thuộc AI), hoặc
- **vào ngày truyện …** (cần đặt **Ngày trong truyện** ở đầu tab — nút −/+ — hoặc `/memories action=clock day=13`).
- Nhập **Nội dung hẹn**, **Tên liên quan**, **Nhắc trước** (mặc định 5 tin / 1 ngày), **Nhãn** (trống = tự tạo) → **Lưu hẹn**.
- Nếu bật *AI được tự ghi hẹn khi ghi nhớ* (tắt mặc định), lượt ghi nhớ cũng có thể tự tạo hẹn và gắn mốc ngày truyện.

### Hành vi
- Bình thường block `[Schedule]` liệt kê ngắn gọn trong prompt.
- **Đến gần hạn** → block `[Schedule — DUE NOW]` được đẩy gần cuối context (model không thể bỏ lỡ) + bạn nhận toast một lần.
- **Quá hạn** → dòng chuyển "quá hạn", nhắc liên tục cho tới khi bạn xử lý. Không bao giờ tự biến mất (trừ khi bật *Tự đánh dấu "bỏ lỡ"*: hẹn quá hạn lâu — 10 tin / 10 ngày sau hạn + nhắc trước — được AI đánh dấu bỏ lỡ).

### Vòng đời mỗi hẹn
- ✓ **Đã xảy ra** — đánh dấu hoàn tất + **tự lưu thành memory** với nguồn "từ lịch trình".
- **Dời +10** (hẹn theo tin) / **Dời +1 ngày** (hẹn theo ngày); số tuỳ ý qua menu ⋯ → **Dời tuỳ chọn…**.
- Menu ⋯ — **Sửa** (nội dung / nhãn / nhắc trước), **Đánh dấu bỏ lỡ** (để AI biết chuyện đó đã trôi), **Huỷ hẹn**.
- Hẹn đã xong / huỷ / bỏ lỡ nằm trong mục thu gọn **Đã xong / huỷ / bỏ lỡ (N)**.

### Xoá
"Xoá toàn bộ memory" **không** đụng lịch trình. Xoá lịch trình riêng bằng menu ⋯ → **Xoá toàn bộ lịch trình…** hoặc `/memories action=sched_clear`. Tối đa 20 hẹn đang chờ mỗi chat (chỉnh được).

## 10. Vector recall — tìm memory cũ theo chủ đề

> Thử nghiệm, **tắt mặc định**. Bật trong Cài đặt → Tính năng → *Vector recall*.

Khi chat có hàng trăm memory, khối canon chỉ đủ chỗ cho các dòng quan trọng nhất. Vector recall bổ sung: dùng **Vector Storage của ST** (model embedding local chạy phía server, miễn phí) đánh chỉ mục toàn bộ memory của chat, và mỗi lượt trả lời tự tìm các memory **liên quan tới chủ đề hiện tại** — kể cả memory ngày đầu.

- Chỉ mục **riêng từng chat** — chat khác không bao giờ lẫn memory.
- Trạng thái xem trong cài đặt (dòng "Vector recall: …", nút **Đồng bộ lại**) hoặc tab Tình trạng.
- **Recall đúng lượt**: trước khi AI trả lời, extension chờ tối đa *Chờ vector recall trước khi AI trả lời* (mặc định 1500 ms, 0 = không chờ) để kết quả theo tin mới nhất kịp vào prompt. Tắt chèn vào prompt thì không chờ.
- Tắt đi → hành vi quay về chính xác như bản không-vector. Lỗi network/index → tự dùng cách chọn dự phòng, không bao giờ chặn chat.
- Lần đầu bật, server cần tải model embedding (một lần). Theo dõi bằng `/memories action=vindex`; xem recall đang chọn gì bằng `/memories action=recall [câu tra]`.

## 11. AI cập nhật memory thế nào

Lượt ghi nhớ (mỗi N tin hoặc bấm tay) nhận: **đoạn tin mới** (tối đa 60 tin được đếm mỗi đoạn, mặc định tối đa 2 đoạn mỗi lượt, trong *ngân sách token cho một lượt* — mặc định 12000; tin để nguyên, **không** bị cắt; một tin vượt cả ngân sách sẽ chặn lượt chạy và hỏi bạn có bỏ qua không) + **câu chuyện tới giờ** + **memory hiện có** (mặc định tối đa 150 mục), rồi trả về một bản vá:

- `add` — fact mới (tự chống trùng: chế độ *Chính xác* chặn nội dung giống hệt, *Gần nghĩa* chặn cả câu diễn đạt lại).
- `update` — viết lại memory cũ khi thông tin thay đổi (theo id).
- `delete` — xoá memory sai hoặc đã bị thay thế.

Model không tự bịa memory ngoài lượt này; lượt lỗi thì **giữ con trỏ** (không mất tin) và thử lại sau khi đủ ngưỡng tin mới; patch rỗng hợp lệ vẫn đẩy con trỏ tới cuối đoạn. Mọi thay đổi đều được chuẩn hoá + chống trùng + lược kho (vượt *Số memory tối đa* thì lược mục trùng / tạm thời / ít quan trọng + cũ trước; mục khoá/ghim không bao giờ bị lược). AI không thể sửa/xoá mục đã khoá — thông báo sẽ ghi số thao tác bị bỏ qua.

## 12. Dùng trong chat Storyline

Trong chat Storyline, khối standalone bị Storyline thay toàn bộ prompt (cơ chế cấu trúc, không phải bug) — memory đến được với model qua function **memory_keeper** của Storyline:

1. Storyline Editor → Advanced → Story Functions → thêm **Memory Keeper** (Default On).
2. Từ Storyline v0.1.20 + Memory Weaver v0.4.0: bridge gọi **recall API** của Memory Weaver — gồm cả vector recall, chờ tối đa 400 ms (`retrieval.waitBudgetMs`) trước khi chụp prompt.
3. Lịch trình hiện **chưa** được chiếu vào prompt Storyline.

## 13. Slash commands

Hành động luôn truyền qua tham số có tên `action=` (mặc định `view`); tham số có tên đứng **trước** phần nội dung, nội dung là phần còn lại không tên.

```
/memories                                              — mở dashboard (= action=view)
/memories action=add entity=Alice entity=Bob importance=3 <nội dung>
/memories action=summarize                             — chạy ghi nhớ ngay
/memories action=recall [câu tra]                      — xem vector recall đang chọn gì (cần bật vector recall)
/memories action=delete id=<id>
/memories action=clear                                 — xoá toàn bộ memory (giữ lịch trình; hỏi trước)
/memories action=sched_add when=after:40 lead=5 Ăn sáng với Alice
/memories action=sched_add when=day:13 entity=Bob Đấu kiếm với Bob
/memories action=sched_done id=<id>                    — hoàn thành (+ tự lưu thành memory)
/memories action=sched_cancel id=<id>                  — huỷ hẹn
/memories action=sched_miss id=<id>                    — đánh dấu bỏ lỡ
/memories action=sched_postpone id=<id> amount=10      — dời hạn
/memories action=sched_clear                           — xoá sạch lịch trình (hỏi trước)
/memories action=clock day=13                          — đặt "hôm nay" của truyện
/memories action=vindex [rebuild=true]                 — trạng thái / dựng lại vector index
```

Không có `entity=` thì `add` gắn nhân vật đang chat (hoặc `USER`); mức quan trọng mặc định 2. `lead` = nhắc trước bao nhiêu tin (hẹn `after`) hoặc bao nhiêu ngày (hẹn `day`).

## 14. Tham khảo cài đặt

Extensions → Memory Weaver. Ô **Ngôn ngữ** nằm trên cùng; ngay dưới là nút **⚡ Bật chế độ Siêu thông minh** (xem bảng thứ hai); **Khôi phục cài đặt cũ** đưa mọi giá trị về như trước khi bật (hỏi trước nếu việc đó làm *Số memory tối đa* nhỏ hơn số memory đang có).

| Mục | Cài đặt | Mặc định | Ý nghĩa |
|---|---|---|---|
| (trên cùng) | Ngôn ngữ | English | **English** / **Tiếng Việt** / **Tự động (theo SillyTavern)** — chỉ ngôn ngữ giao diện (prompt gửi cho AI không bao giờ bị dịch). Đổi là cài đặt, badge trên send form và dashboard đang mở hiển thị lại ngay |
| Cơ bản | Bật Memory Weaver | bật | Công tắc tổng |
| Cơ bản | Cách ghi nhớ | Tự động | **Tự động** (AI tự ghi nhớ sau mỗi N tin) / **Bấm tay** (chỉ chạy khi bấm "Ghi nhớ ngay") / **Chỉ ghi tay** (AI không tự ghi gì) |
| Cơ bản | Ghi nhớ sau mỗi | 20 tin | Số tin hội thoại giữa 2 lượt (5–100) |
| Cơ bản | Đưa memory vào prompt | bật | Chèn khối [Chat Memories] |
| Cơ bản | Dung lượng memory trong prompt | 600 token | Ngân sách khối memory (100–4000) |
| Tính năng | Tóm tắt truyện theo chương | bật | Viết và chèn "câu chuyện tới giờ" |
| Tính năng | Mỗi chương ≈ số tin | 100 | 20–400 |
| Tính năng | Token cho khối tóm tắt | 600 | 100–4000 |
| Tính năng | Lịch trình | bật | Tab lịch trình + chèn [Schedule] |
| Tính năng | AI được tự ghi hẹn khi ghi nhớ | tắt | Thử nghiệm |
| Tính năng | Tự đánh dấu "bỏ lỡ" hẹn quá hạn lâu | tắt | Cần bật dòng trên |
| Tính năng | Vector recall | tắt | Tìm memory cũ theo chủ đề (thử nghiệm) |
| Nâng cao | Ngân sách token cho một lượt ghi nhớ | 12000 | 2000–32000 (ước tính) |
| Nâng cao | Số đoạn xử lý tối đa mỗi lượt | 2 | 1–10 (mỗi đoạn ≤ 60 tin) |
| Nâng cao | Số memory tối đa mỗi chat | 150 | 20–500; đầy thì lược |
| Nâng cao | Token tối đa cho khối lịch trình | 120 | 40–400 |
| Nâng cao | Số hẹn đang chờ tối đa mỗi chat | 20 | 5–100 |
| Nâng cao | Số memory cũ AI xem lại mỗi lượt ghi nhớ | 150 | 50–300 |
| Nâng cao | Tự cho AI gộp & dọn memory sau mỗi N lượt tự động | 0 | 0 = chỉ bấm tay (0–50) |
| Nâng cao | Chờ vector recall trước khi AI trả lời | 1500 ms | 0 = không chờ (0–5000) |
| Nâng cao | Chống trùng lặp khi thêm memory | Chính xác | **Chính xác** (chỉ nội dung giống hệt) / **Gần nghĩa** (cả câu diễn đạt lại, thử nghiệm) |
| Nâng cao | System prompt riêng cho lượt ghi nhớ | (trống) | Trống = mặc định; định dạng đầu ra luôn được giữ |

Chế độ **Siêu thông minh** đặt:

| Cài đặt | Giá trị |
|---|---|
| Dung lượng memory trong prompt | 2000 token |
| Ngân sách token cho một lượt ghi nhớ | 24000 |
| Số đoạn xử lý tối đa mỗi lượt | 4 |
| Số memory cũ AI xem lại | 250 |
| Số memory tối đa | 300 |
| Chống trùng lặp | Gần nghĩa |
| Chờ vector recall | 2000 ms |
| Vector recall · AI tự ghi hẹn · Chương | bật |
| Mỗi chương ≈ số tin / token khối tóm tắt | 80 / 1000 |
| Tự gộp & dọn memory | mỗi 5 lượt |

## 15. An toàn dữ liệu & riêng tư

- Memory + chương + lịch trình + đồng hồ truyện nằm trong **local variable của chính chat đó** — xoá chat là mất theo, không server nào lưu riêng.
- **Vector index** là dữ liệu phái sinh lưu trên máy chạy ST (`data/<user>/vectors/`) — xoá index chỉ mất chỉ mục, memory vẫn nguyên và tự index lại; xoá chat dọn luôn index của chat đó.
- Với model embedding local, nội dung memory được xử lý **trên máy bạn**. Nếu chọn embedding source cloud, nội dung được gửi tới nhà cung cấp đó.
- Không chia sẻ dữ liệu giữa các chat; ngoài LLM API đang cấu hình (khi chạy lượt ghi nhớ / viết chương / dọn kho), không gửi đi đâu khác.

## 16. FAQ & xử lý sự cố

**H: AI vẫn quên dù đã có memory?**
Tab **Trong prompt** → **AI có nhớ chuyện này không?** cho biết lý do và nút sửa. Chat dài thì bật **Vector recall** hoặc tăng *Dung lượng memory trong prompt*. Trong chat Storyline, kiểm tra function **Memory Keeper** đã bật.

**H: `No message generated` / "The API returned an EMPTY completion"?**
Model reasoning đốt hết ngân sách trả lời (4096 token). Từ v0.5.0 extension **không** tự hạ Reasoning Effort (đổi cài đặt chung giữa lúc chạy không an toàn). Thường tự khỏi ở lần sau; nếu lặp lại, tự hạ Reasoning Effort hoặc đổi model.

**H: Số tin nhảy / không khớp?**
Bản ≥ 0.2.1 đếm **tin hội thoại thật** — tool call/tin hệ thống không tính. Số mới là số đúng.

**H: Xoá/sửa tin thì memory bị lệch?**
Memory không mất. Nút chuyển **cần xem** (vàng) và tab Tình trạng mời **Rà soát lại** hoặc **Bỏ qua**; con trỏ **không** tự kẹp lại. Chỉ nhãn "tin #X" có thể lệch nhẹ.

**H: Muốn AI nhớ xuyên nhiều chat?**
Memory Weaver là theo từng chat theo thiết kế. Dùng CharMemory cho nhu cầu theo nhân vật (hai extension chạy chung được nhưng tốn hai lượt LLM).

**H: Vector recall báo lỗi?**
Xem dòng trạng thái trong cài đặt hoặc cảnh báo ở tab Tình trạng. Lỗi network/model → tự dùng cách chọn dự phòng, không ảnh hưởng chat. Bấm **Đồng bộ lại** hoặc chạy `/memories action=vindex rebuild=true`.
