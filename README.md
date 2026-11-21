# 安心照護：Cloudflare Pages + LINE LIFF + Supabase

這個專案供一位長輩的照護團隊使用。白名單成員均可查看及編輯照護資料，管理員另外可以新增、修改或移除成員。尚未加入血糖功能。

## 架構與安全邊界

- `public/`：手機優先的雙語介面。LINE LIFF 登入後，瀏覽器以 LINE ID Token 呼叫同網域的 `/api/care`。
- `functions/api/`：Cloudflare Pages Functions。每次請求均由伺服器向 LINE 驗證 ID Token，並由資料庫再次確認白名單；不能只相信前端提供的 LINE User ID。
- `supabase/schema.sql`：資料表及交易式 API。啟用 RLS，撤銷 `anon`、`authenticated` 的直接存取，僅供後端使用的 `service_role` 執行。
- Supabase **secret key 只放在 Cloudflare 伺服器端 secret**，不得放在網頁、Git、聊天訊息或日誌中。每個 LINE ID Token 也應視為敏感資料。

資料表包括 `care_members`、`health_records`、`daily_checklists`、`care_logs`、`comments`、`reactions`、`medications` 及 `appointment`。照片以 Base64 寫入相應紀錄，支援 JPEG、PNG、GIF、WebP，單張原始檔最多 1 MB。日期與「今天」統一使用台灣時間；其他照護資料不保存在瀏覽器的 localStorage。語言偏好仍存於瀏覽器。

## 部署前準備

### 1. 建立 Supabase 專案

1. 在 Supabase 建立**專供此應用程式使用**的專案。
2. 進入 SQL Editor，執行 `supabase/schema.sql`。此檔是首次建立結構用，不適合重複執行；執行前請先備份現有資料庫，避免使用已有同名資料表的專案。
3. 取得 Project URL 與伺服器端 **secret key**（`sb_secret_...`）。不要使用 publishable key，也不要將 secret key 貼到 Git 或聊天中。
4. 確認資料表有啟用 RLS，並以 Supabase Security Advisor 檢查設定。

### 2. 建立 LINE Login 與 LIFF

1. 在 LINE Developers 建立 LINE Login channel，建立 LIFF 應用程式；啟用 **`openid` scope**，讓 LIFF 能取得 ID Token。
2. LIFF Endpoint URL 設定為部署後的 Cloudflare Pages HTTPS 根網址，例如 `https://你的專案.pages.dev/`。登入跳轉網址與實際部署環境應一致。
3. 記下 **LIFF ID** 與該 LINE Login channel 的 **Channel ID**。它們是不同的值。
4. 如要讓 channel 開發者／測試者以外的家人使用，請依 LINE 後台要求發布 channel；首次使用者可能需要登入或授權，不能保證永遠免操作。

### 3. 部署 Cloudflare Pages

使用 Git 整合（或 Wrangler 部署），將本專案根目錄作為專案根目錄：

- Build command：留空。
- Build output directory：`public`。
- `functions/` 必須保留在專案根目錄；Pages 會編譯 Functions。**Cloudflare 網頁後台的直接上傳不支援此專案所需的 Functions**。
- 在 Pages 專案的環境變數／secrets 設定：
  - 本專案已預設使用 LIFF ID `2012741362-xQV1Y9gJ` 與 LINE Login Channel ID `2012741362`；如要使用其他 LIFF/channel，可用 `LIFF_ID`、`LINE_CHANNEL_ID` 環境變數覆寫。兩者皆為公開識別碼，不是秘密。
  - `SUPABASE_URL`：Supabase Project URL。
    - 本版本僅接受官方 `https://*.supabase.co` Project URL，不接受自訂 Supabase 網域。
  - `SUPABASE_SECRET_KEY`：Supabase secret key，設定為 **secret**，不要放在前端。

設定完成後重新部署，並確認 `https://你的專案.pages.dev/api/config` 有回傳 LIFF ID；不要對外分享 secret。正式環境與預覽環境請使用獨立設定，尤其不要讓公開預覽部署連到正式健康資料庫。

### 4. 初始化第一位管理員

1. 第一位管理員用自己的 LINE 開啟 LIFF 網址，完成 LINE 登入；尚未加入白名單時，畫面會顯示**經 LINE 驗證的本人 LINE User ID**。
2. 將該 ID 安全交給 Supabase 專案管理者。由管理者在 Supabase SQL Editor 手動執行以下 SQL，將範例值換成剛剛取得的完整 ID：

   ```sql
   insert into public.care_members (line_user_id, display_name, is_admin)
   values ('U0123456789abcdef0123456789abcdef', '管理員', true);
   ```

3. 管理員重新整理並登入，進入「成員管理」。其他家人或照顧者第一次登入時，也將畫面顯示的本人 ID 安全提供給管理員，由管理員加入白名單。
4. 管理員可以依 ID 更新稱呼／權限，或移除成員；系統不允許移除或降級最後一位管理員。已移除成員的後續 API 請求會被拒絕。

## 驗證與限制

- `npm test`：執行不需第三方帳號的 API 單元測試。
- `tests/database.sql`：在**隔離的測試資料庫**套用 schema 並建立 Supabase 的 `anon`、`authenticated`、具 `BYPASSRLS` 的 `service_role` 測試角色後執行；測試交易會回滾。
- 既有單檔原型的 localStorage 資料**不會自動匯入** Supabase。
- 請使用部署後的 HTTPS 網址開啟；直接以 `file://` 開啟 HTML 無法執行 LIFF 驗證及 Pages Functions。
- 前端在頁面開啟且沒有編輯草稿時約每 30 秒更新。照片與完整時間軸目前隨資料同步，資料量增加會影響速度及資料庫容量；正式長期使用前應加入分頁與 Supabase Storage 私有物件存放。
- 因含健康資料，上線前應完成授權管理、資訊安全審查、備份與復原演練、法規及個資處理評估，並在真實 LINE、Cloudflare、Supabase 環境測試。此專案不提供醫療診斷或緊急監測。

參考：[LINE LIFF 文件](https://developers.line.biz/en/docs/liff/) · [LINE ID Token 驗證](https://developers.line.biz/en/reference/line-login/#verify-id-token) · [Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/get-started/) · [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
