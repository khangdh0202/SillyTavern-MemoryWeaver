# Memory Weaver — Bộ nhớ truyện sống cho SillyTavern

> [English](README.md) · **Tiếng Việt** — Hướng dẫn đầy đủ: [USER_GUIDE.vi.md](USER_GUIDE.vi.md) · [USER_GUIDE.md](USER_GUIDE.md)

Memory Weaver cho AI một **bộ nhớ sống của chính chat hiện tại**. Cứ mỗi N tin, một lượt AI chạy ngầm nén đoạn hội thoại mới thành các memory ngắn gọn; những memory liên quan nhất được chèn lại vào prompt để AI giữ đúng tên, lời hứa, vết thương, quan hệ và hệ quả — kể cả trong chat rất dài. Hoàn toàn độc lập, không cần extension nào khác.

> **Ngôn ngữ giao diện:** giao diện mặc định là **English**; chọn **Tiếng Việt** (hoặc **Tự động** — theo ngôn ngữ của SillyTavern) ở ô **Ngôn ngữ** trên cùng Extensions → Memory Weaver. Chỉ giao diện được dịch — prompt gửi cho AI giữ nguyên.

## Có gì mới

**v0.9.2 — giao diện song ngữ**
- Giao diện English (mặc định) hoặc Tiếng Việt, kèm chế độ Tự động (theo SillyTavern). Cài đặt **Ngôn ngữ** mới ở đầu ngăn cài đặt; đổi là áp dụng ngay. Prompt gửi cho AI không bị dịch.

**v0.9.1 — sửa lỗi sau đợt rà soát**
- Hoàn tác lượt chạy "tất cả hoặc không": cả một đợt (mọi đoạn của một lần chạy) được hoàn tác cùng lúc, lưu thay đổi của 3 đợt gần nhất, lượt quá lớn bị đánh dấu không hoàn tác được, và không cho hoàn tác qua một lần xoá toàn bộ memory.
- Khôi phục từ chế độ Siêu thông minh hỏi trước khi hạ *số memory tối đa* xuống dưới số memory đang có.
- Tự gộp & dọn memory có bộ đếm được lưu lại và luân phiên qua các nhóm memory.
- Chương: giới hạn số lần tự thử lại mỗi đoạn, chặn ghi nhầm chat; chương bị cũ do sửa/xoá tin được đánh dấu kèm nút **Viết lại chương này**; chạm trần 60 chương thì gộp hai chương cũ nhất thay vì dừng.
- Lược kho: giữ bản dài hơn khi trùng, không bao giờ xoá cả hai bản, quy tắc "chi tiết tạm thời" chặt hơn, quét trùng gần nghĩa nhanh ~5 lần; nhóm "Cảnh hiện tại" không còn bị ghim/nền tảng chiếm hết chỗ.
- Giao diện: đoạn trích tin chưa ghi nhớ đúng với chữ tổ hợp NFD/Hangul, gợi ý khi đang tắt chèn vào prompt, gợi ý gộp tên theo từ, chặn Enter khi đang gõ IME, menu trên điện thoại, màu ở theme sáng.
- Khi tắt chèn vào prompt, extension không còn chờ vector recall trước khi AI trả lời.

**v0.9.0 — "AI siêu thông minh"**
- **📖 Cốt truyện theo chương** (tab **Cốt truyện**): cứ khoảng 100 tin đã ghi nhớ, AI viết một chương tóm tắt (ai làm gì, quan hệ đổi ra sao, lời hứa, mạch còn bỏ ngỏ). "Câu chuyện tới giờ" được đưa vào prompt chính và vào cả lượt ghi nhớ. Sửa / khoá / xoá / viết lại được.
- **🧹 AI gộp & dọn memory**: AI đọc lại kho — gộp câu trùng, thay fact cũ bằng fact mới, bỏ chi tiết vụn, chuẩn hoá tên. Không thêm mới, không đụng mục khoá/ghim; có thể tự chạy sau mỗi N lượt.
- **↩ Xem & hoàn tác một lượt ghi nhớ**: tab Tình trạng hiện memory được thêm/sửa/xoá trong các lượt gần nhất + nút **Hoàn tác lượt này**.
- **Recall đúng lượt**: trước khi AI trả lời, extension chờ (mặc định tối đa 1,5 giây) để vector recall theo tin MỚI NHẤT kịp vào prompt.
- Lược kho v2 (bỏ câu trùng và chi tiết tạm thời trước, giữ fact nền tảng, chống "lạm phát" mức Cốt lõi); AI xem lại nhiều memory cũ hơn mỗi lượt (mặc định 150, chỉnh được tới 300).
- Nút **⚡ Bật chế độ Siêu thông minh** trong cài đặt, kèm **Khôi phục cài đặt cũ**.

**v0.8.0 — "AI có nhớ chuyện này không?"**
- Ô chẩn đoán trong tab **Trong prompt**: mỗi memory khớp có kết luận (đang trong prompt / không vừa dung lượng / bị bộ lọc loại / lượt này chưa liên quan) kèm nút sửa ngay; tìm cả trong tin chưa ghi nhớ.
- **📌 Ghim vào prompt** (luôn được chèn, hạn mức riêng) tách khỏi **🔒 Khoá** (chỉ chặn AI sửa/xoá và chống bị lược).
- Sửa bộ chọn recall (không còn phí ~30% ngân sách); dọn memory trùng gộp 1 chạm; đổi tên/gộp tên nhân vật; nhảy tới tin gốc; **Ghi nhớ toàn bộ** cho chat dài chưa ghi nhớ; token ước tính mỗi lượt; ngân sách mặc định một lượt 6000 → 12000.
- Nút trên send form hiện **cần xem** (vàng) khi lịch sử bị sửa, thay vì **lỗi** (đỏ).
- Sửa lỗi: ô "Số memory tối đa" xoá memory khi đang gõ; "Rà soát lại" làm mất đoạn bị sửa trước đó; "Bỏ qua" đánh dấu cả tin chưa đọc là đã ghi nhớ; xuất/nhập file mất dữ liệu; undo lịch trình đè thay đổi mới; vector recall dùng kết quả cũ cho tin mới.

**v0.7.0 — dashboard làm lại**
- Dashboard theo tab, danh sách hiện ngay đầu, một thanh cuộn, thanh tab dính trên cùng; tab **Trong prompt** hiện đúng khối `[Chat Memories]` AI thấy ở tin kế tiếp, kèm nhãn **AI đang thấy** trên từng memory.
- Cảnh báo kèm nút xử lý (thử lại, rà soát lịch sử bị sửa, bỏ qua tin quá dài), lịch sử 10 lần chạy, tìm không cần dấu, chip lọc, thao tác hàng loạt (khoá / đổi mức / xoá), nút send form có trạng thái, cài đặt gọn hơn (danh sách / xuất / nhập memory chuyển vào dashboard).
- Sửa lỗi: chat mới bị báo "chưa đối chiếu (legacy)" mãi; tin dài bị cắt ở 1500 ký tự mà vẫn tính là đã ghi nhớ (bỏ từ v0.6.5 — tin không bao giờ bị cắt nữa); kho ~100+ memory khiến mỗi lượt chỉ xử lý 1 tin; "Quét lại" kéo lùi con trỏ hoặc chạy song song; chữ Việt tổ hợp (NFD) làm hỏng chống trùng; memory đã khoá không xoá được; dời hẹn hoặc hạ "số hẹn tối đa" làm mất hẹn; lời chào bị đếm lại mỗi lần mở chat.

**v0.6.0 — kiểm soát & hoàn thiện**
- Khoá memory chống AI sửa/xoá và chống bị lược; hoàn tác 1 cấp cho thao tác xoá; bỏ qua tin quá dài; dòng "lượt chạy cuối" (model + thời gian + token ước tính); xuất/nhập markdown; recall inspector + `/memories action=recall`; AI tự ghi hẹn (TẮT mặc định); xoá chat dọn luôn vector index; tiêu chí mức quan trọng + "sàn gần đây".

**v0.5.0 — lõi vững chắc**
- Một "cửa ghi" duy nhất chặn mọi ghi sai khi đổi chat / sửa tin giữa chừng / xoá; lượt ghi nhớ đọc phần tồn đọng theo thứ tự (≤ 60 tin mỗi đoạn, mặc định ≤ 2 đoạn mỗi lượt, giới hạn theo ngân sách token ước tính); patch được kiểm tra cấu trúc và bị từ chối nguyên khối khi xung đột; sửa tin đã ghi nhớ → trạng thái *cần xem*; state hỏng không bao giờ bị ghi đè (bản sao lưu trong `memoryWeaverState_recovery`).

---

## Cách hoạt động

1. Chat bình thường. Cứ mỗi **N tin được đếm** (mặc định 20 — tin hệ thống, tool call, tin narrator rỗng **không** tính), một lượt AI ngầm đọc đoạn chat mới + memory hiện có rồi trả về bản vá: **thêm fact mới, viết lại fact đã đổi, xoá fact hết giá trị**.
2. Memory lưu trong **local variable của chat** (`memoryWeaverState`) — **theo từng chat** (1 nhân vật, nhiều chat = nhiều bộ nhớ riêng; không theo nhân vật, không toàn cục), đi cùng file chat.
3. Khi tạo câu trả lời, extension chèn khối **[Chat Memories]** theo ngân sách token, cùng khối **câu chuyện tới giờ** (chương) và **[Schedule]** nếu bật.
4. **Vector recall (tuỳ chọn, tắt mặc định)**: extension giữ một index embedding **riêng cho từng chat** trên vector server có sẵn của SillyTavern (model local miễn phí) và kéo thêm memory cũ liên quan tới chủ đề đang nói — fact ngày 3 vẫn được nhớ lại ở ngày 40.
5. Trong chat **Storyline**, function `memory_keeper` của Storyline chiếu memory vào prompt narrator. Không có Storyline → vẫn chạy đầy đủ.

## Điểm nổi bật

- Lượt ghi nhớ ngầm mỗi N tin — xử lý phần tồn đọng **theo thứ tự**, không cắt tin; nút **Ghi nhớ ngay** và **Ghi nhớ toàn bộ** cho chat dài
- **Dashboard 5 tab**: Memories · Trong prompt · Cốt truyện · Lịch trình · Tình trạng
- Chẩn đoán **"AI có nhớ chuyện này không?"** kèm nút sửa 1 chạm
- **Ghim và khoá tách riêng**, thao tác hàng loạt, đổi tên/gộp tên, dọn trùng, mở tin gốc
- **Cốt truyện theo chương**, **AI gộp & dọn memory**, **hoàn tác cả một lượt**
- **Vector recall lai** theo chat — chèn ngay trong lượt (chờ tối đa *thời gian chờ recall*, mặc định 1500 ms)
- **Lịch trình** theo ngày truyện hoặc số tin, dời hạn, theo dõi bỏ lỡ, xong → tự thành memory
- Lệnh `/memories` và `MemoryWeaverAPI` v3 cho extension khác

## Nguyên tắc thiết kế

1. **Kho memory là nguồn sự thật duy nhất** — local variable của chat. Vector index chỉ là dữ liệu phái sinh, dựng lại được.
2. **Tất định trước, xác suất sau** — khối canon luôn có và có giới hạn; embedding chỉ *mở rộng độ phủ*.
3. **Tin được đếm** — N là N tin hội thoại thật.
4. **Tắt vector = như cũ** — tắt vector recall thì khối chèn giống hệt bản xếp theo mức quan trọng.
5. **Độc lập** — không import extension khác; Storyline tự tích hợp qua `MemoryWeaverAPI`.
6. **Mọi lần ghi đều được kiểm** — phạm vi chat, vòng đời, revision và dấu vân tay nguồn được kiểm trước khi ghi; xung đột thì từ chối cả khối.
7. **Độ phủ trung thực** — con trỏ chỉ tiến khi patch được ghi; sửa nguồn → *cần xem*; tin quá dài chặn rõ ràng thay vì bị cắt.

## Phân biệt với các hệ khác

- **CharMemory**: theo nhân vật, xuyên chat (card + Data Bank + Vector Storage). Memory Weaver là **theo từng chat**; vector recall tuỳ chọn chỉ index memory của chính chat hiện tại, và không bao giờ đụng dữ liệu CharMemory.
- **Character State**: số liệu runtime (chỉ số/hiệu ứng). Memory Weaver lưu **sự kiện tường thuật** (ai biết gì, lời hứa, vết thương…). Hai tầng khác nhau, dùng chung được.
- **World Info / các extension bộ nhớ dựa trên lorebook**: cơ chế khác (mục lore kích hoạt theo từ khoá).

## Tổng quan giao diện

**Nút trên send form** — **🧠 Memory** cạnh ô chat (sau nút Character Sheet nếu có cài character-state). Badge hiện `số tin chờ/ngưỡng` ở chế độ **Tự động** hoặc `N chờ` ở các chế độ khác, và đổi sang chữ trạng thái: **sẵn sàng**, **đang ghi…**, **lỗi**, **cần xem**, **N hẹn**, **tắt**. Bấm nút mở dashboard đúng tab liên quan.

**Dashboard** (nút hoặc `/memories`) — đầu trang có trạng thái, nút **Ghi nhớ ngay** và menu **⋯** (quét lại 60 tin gần nhất, AI gộp & dọn memory, xuất / nhập file `.md`, đồng bộ lại vector index, xoá toàn bộ lịch trình, xoá toàn bộ memory); thanh tiến độ mảnh; băng cảnh báo kèm nút sửa; và 5 tab:

| Tab | Nội dung |
|---|---|
| **Memories** | Danh sách: tìm không cần dấu, chip mức độ/tên, sắp xếp, lọc Trong prompt, sửa tại dòng, ghim / khoá, chọn nhiều, **Thêm memory** |
| **Trong prompt** | Đúng khối `[Chat Memories]` AI thấy ở tin kế tiếp + ô chẩn đoán "AI có nhớ chuyện này không?" |
| **Cốt truyện** | Các chương: viết chương tiếp theo / viết lại chương cuối, sửa, khoá, xoá |
| **Lịch trình** | Hẹn, ngày trong truyện, thêm / dời / xong / bỏ lỡ |
| **Tình trạng** | Cảnh báo, thống kê, lịch sử 10 lần chạy kèm thay đổi + hoàn tác, dọn trùng, trạng thái vector, công cụ (quét lại, dọn kho, xuất, nhập) |

**Cài đặt** (Extensions → Memory Weaver) — ô **Ngôn ngữ** (English / Tiếng Việt / Tự động), nút chế độ Siêu thông minh, phần **Cơ bản**, **Tính năng** và **Nâng cao** (thu gọn). Xem [bảng tham khảo cài đặt](USER_GUIDE.vi.md#14-tham-khảo-cài-đặt).

## Slash commands

Hành động luôn truyền qua tham số có tên `action=` (mặc định `view`); các tham số có tên đứng **trước** phần nội dung.

```
/memories                                              — mở dashboard (= action=view)
/memories action=add entity=Alice entity=Bob importance=3 Alice biết lối đi bí mật
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
/memories action=vindex [rebuild=true]                 — trạng thái / dựng lại vector index của chat này
```

Không có `entity=` thì `add` gắn nhân vật đang chat (hoặc `USER`); mức quan trọng mặc định là 2.

## Xử lý sự cố

- **Không thấy memory sau N tin** — xem toast và lịch sử chạy ở tab **Tình trạng**; Console (F12) có các dòng `[Memory Weaver]`.
  - Lỗi API (vd `Not Found` / HTTP 404): ST server chỉ chuyển `statusText` của upstream; mở **console của server ST** — dòng `Chat completion request error: ...` in status + body gốc (với OpenRouter thường là "No endpoints found matching your data policy/provider preferences"). Kiểm tra model, Privacy/Data policy của OpenRouter, provider/quantization + "Allow fallbacks", plugin web search và Middle-out. Con trỏ được giữ; lần thử kế chạy sau N tin mới, hoặc bấm **Ghi nhớ ngay**.
  - `No message generated` / *The API returned an EMPTY completion*: thường là model reasoning đốt hết ngân sách 4096 token cho phần suy nghĩ. Từ v0.5.0 extension **không** tự đổi Reasoning Effort của bạn — tự hạ nó hoặc đổi model/provider.
  - `Optimizer output rejected: ... Raw (first 800 chars): ...`: model trả sai định dạng. Đổi model hoặc thêm chỉ dẫn vào "System prompt riêng cho lượt ghi nhớ".
  - Patch rỗng hợp lệ ("Không có gì mới cần lưu") không phải lỗi: con trỏ vẫn tiến.
- **Tự động không chạy** — chế độ phải là **Tự động** và extension đang bật; Console có dòng `Auto optimization queued: ...`. Sau một lần lỗi, lần thử kế chờ đủ N tin mới.
- **Bị chặn bởi một tin quá dài** — bấm toast hoặc **Bỏ qua tin này** trên cảnh báo; tin đó không chặn lại nữa và tự quay lại hàng chờ nếu được rút ngắn.
- **AI vẫn quên** — mở tab **Trong prompt**, dùng **AI có nhớ chuyện này không?**; ghim fact, nâng Cốt lõi, tăng dung lượng, hoặc bật vector recall. Trong chat Storyline, kiểm tra function **Memory Keeper** đã bật.
- **Memory bị khoá 🔒** — AI không sửa/xoá được và không bao giờ bị lược; thông báo trạng thái ghi rõ số thao tác bị bỏ qua trên mục đã khoá.

## Lưu trữ & riêng tư

- Dữ liệu nằm trong local variable `memoryWeaverState` của chính chat (`/getvar key=memoryWeaverState`). Xuất/nhập chat = memory đi theo chat.
- Vector index (nếu bật) là dữ liệu phái sinh trên máy chạy ST (`data/<user>/vectors/`); với model local mặc định, nội dung memory không rời khỏi máy bạn.
- Không gửi dữ liệu đi đâu ngoài LLM API đang cấu hình khi chạy lượt ghi nhớ / viết chương / dọn kho (và tới nhà cung cấp embedding cloud chỉ khi bạn tự chọn).

## Tương thích

- SillyTavern **1.18.0** trở lên
- Chat Completion và Text Completion
- Chạy độc lập; trong chat **Storyline** qua function `memory_keeper` (Storyline ≥ 0.1.20 cho nhánh vector recall, chờ tối đa 400 ms — `retrieval.waitBudgetMs`)
- Vector recall không cần gì bên ngoài — model embedding local phía server ST (tải một lần).

## Cài đặt

1. Thanh trên cùng của SillyTavern → **Extensions** (biểu tượng mảnh ghép)
2. **Install extension** → dán `https://github.com/khangdh0202/SillyTavern-MemoryWeaver` → **Install just for me**
3. Mở một chat bất kỳ — nút **🧠 Memory** xuất hiện cạnh ô gửi tin.

Cài bằng Git URL sẽ tạo thư mục `data/<user>/extensions/SillyTavern-MemoryWeaver/`; nếu chép tay thì tên thư mục tuỳ bạn. Không cần API key nào ngoài LLM bạn đang chat. Vector recall là tuỳ chọn và tắt mặc định.

## Tài liệu

| Tài liệu | Ngôn ngữ | Nội dung |
|---|---|---|
| [USER_GUIDE.vi.md](USER_GUIDE.vi.md) | Tiếng Việt | Hướng dẫn đầy đủ: dashboard, lịch trình, chương, vector recall, slash commands, cài đặt, xử lý sự cố |
| [USER_GUIDE.md](USER_GUIDE.md) | English | Full user guide |
| [README.md](README.md) | English | Overview |

## 🐞 Báo lỗi & hỗ trợ

Gặp lỗi hoặc có câu hỏi? Mở issue tại **[GitHub Issues](https://github.com/khangdh0202/SillyTavern-MemoryWeaver/issues/new/choose)** và chọn *Bug report* hoặc *Question / idea* — form sẽ hỏi đủ thông tin cần thiết.

Một báo lỗi tốt gồm:

- phiên bản SillyTavern và phiên bản Memory Weaver (panel Extensions → Manage extensions)
- API / model bạn đang dùng
- các bước tái hiện: bạn đã làm gì, mong đợi gì, thực tế xảy ra gì
- lỗi trong console trình duyệt (F12 → Console) nếu có — copy các dòng màu đỏ
- ảnh chụp màn hình khi hiển thị sai

Hãy xoá nội dung truyện riêng tư và API key trước khi đăng — issue là công khai.

## ❤️ Ủng hộ

Nếu Memory Weaver giúp bạn chơi vui hơn, hãy cân nhắc ủng hộ dự án:

[![Ko-fi](https://img.shields.io/badge/Support%20on-Ko--fi-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/kdturtle)

hoặc bấm nút **💜 Sponsor** ở đầu repo. Star repo, báo lỗi kèm log và góp ý tưởng cũng giúp rất nhiều — xem [DONATE.md](DONATE.md).

## Giấy phép

Phát hành theo [GNU General Public License v3.0 (GPL-3.0)](LICENSE) — tự do dùng, sửa và phân phối lại; mọi bản fork/phân phối lại phải giữ mã nguồn mở theo cùng giấy phép. © 2026 kdturtle.
