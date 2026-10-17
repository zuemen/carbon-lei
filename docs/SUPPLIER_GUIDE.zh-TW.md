# 供應商指南：台灣螺絲／扣件廠怎麼用一份查證報告回覆所有歐盟客戶

> **先講清楚。** CarbonLEI 是 IEEE ClimateChain 黑客松的原型，跑在以太坊 **Sepolia 測試網**，GLEIF 信任根是**模擬的**，示範裡的公司、人名、LEI、EORI 全部**虛構**，排放數字只是示意。它**不是 CBAM 合規工具**，沒有連到歐盟 CBAM Registry，**目前沒有任何業者在使用**，也還沒聯絡任何試辦夥伴（[PILOT](PILOT.md)）。完整限制請看文末〈[限制](#7-限制)〉。
>
> 本文所有日期、數字都附來源；本文最後一次查證日期為 2026-10-17。英文的技術細節以 [OPERATE › Supplier allocations](OPERATE.md#supplier-allocations-one-report-many-buyers) 為準。

這份指南寫給出口螺絲、螺栓、螺帽（CN 7318）到歐盟的台灣工廠，負責出口或 ESG 的同仁。看完你會知道：歐盟客戶為什麼、什麼時候會跟你要資料；不用 CarbonLEI 時你本來要交什麼；用了之後多了什麼、少了什麼；實際要下哪些指令、按哪些分頁。

---

## 1. 歐盟客戶為什麼會跟你要資料？什麼時候？

**為什麼。** 歐盟碳邊境調整機制（CBAM）從 2026 年 1 月 1 日起正式實施，螺絲、螺帽等鋼鐵製品在範圍內。歐盟進口商要為進口貨物的「內含排放」買 CBAM 憑證。數據有兩種算法：

- **實際值**：用你工廠的排放數據，而且要經過歐盟認可的查證機構查證。
- **預設值**：拿不到可信數據時，用歐盟公告的預設值，而且**逐年加成**：2026 年 +10%、2027 年 +20%、2028 年起 +30%。以台灣 CN 7318 為例，預設值 2.707 tCO2e/t（附件 I 的「總排放」欄；CN 7318 的間接排放為 N/A，所以總排放等於直接排放），加成後 2026 年是 2.978，2028 年起是 3.519 [S5]。進口商的 Importer workbench 已內建這份附件 I 的所有國家與 CN 碼（附件沒列的國家用「Other Countries and Territories」表），所以進口商可以直接拿你的實際值和預設值比較。

所以客戶如果想用比預設值低的實際值，就會來跟你要資料。

**就算你出口量很小也躲不掉。** 50 公噸的豁免門檻是**以歐盟進口商為單位**、算它一整年所有 CBAM 貨物的淨重 [S6]，不是算你出口多少。經濟部指出，受影響的約 2,600 家台灣業者中，約 2,200 家一年出口不到 50 公噸，但只要買家的總進口量超過門檻，仍然要配合提供資料 [S1]。

**時間表** [S2][S3]：

| 時間 | 發生什麼事 |
|---|---|
| 2026 年 1 月起 | 進口商開始以 CBAM 授權申報人身分進口；你的工廠開始監測、計算排放 |
| 2026 年 9 月起 | 經認證的查證機構可在 CBAM Registry 註冊，開始做文件審查與現場訪查 |
| **2027 年 1 月起** | 經認證的查證機構**才能**簽發第一批 CBAM 查證報告；營運者可以把查證報告分享給申報人 |
| 2027 年 2 月起 | 申報人可購買 CBAM 憑證 |
| **2027 年 9 月 30 日前** | 進口商完成 **2026 年**進口貨物的第一次 CBAM 年度申報並繳回憑證 |

換句話說：2026 年出的貨，查證報告最快 2027 年 1 月才拿得到，而客戶 2027 年 9 月底前就要用它申報。氣候署也說明，若進口商採實際值申報，製造業者要提出監測計畫，並經歐盟認證的第三方機構查證，首年須實地訪查 [S1]。

**查證量能很緊。** 執委會 2026 年 10 月 7 日的進度表顯示，24 個歐盟／歐洲經濟區國家認證機構中，只有 7 個受理歐盟以外查證機構的申請；截至 2026 年 10 月 13 日，有紀錄的已獲認證查證機構只有五家，全部設在歐盟，執委會的正式名單尚未公布 [S4]。

---

## 2. 不用 CarbonLEI 時，你本來要交什麼？用了之後呢？

### 2.1 你本來就要做的事（跟 CarbonLEI 無關）

1. **填執委會的通訊範本（Communication Template，Excel）。** 執委會建議（非強制）用這份範本，其中 `Summary_Communication` 工作表是給進口商的摘要 [S7]。
2. **請歐盟認可的查證機構查證**，2027 年起拿到查證報告。
3. **交給客戶**：如果你在 CBAM Registry 的營運者入口（O3CI）註冊，可以在 Registry 裡把資料一次分享給多個申報人 [S8]；2027 年營運者不一定要註冊，也可以在 Registry 外把資料交給申報人，此時你拿到的查證報告副本是電子簽章的 PDF，連同 Excel 一起用其他管道寄給客戶，執委會自己的指引也提到這種做法「沒有任何敏感資料的保護」[S9]。

### 2.2 用了 CarbonLEI 之後

| | 不用 CarbonLEI | 用 CarbonLEI |
|---|---|---|
| 查證 | 要做，費用照付 | **一樣要做，費用照付。** CarbonLEI 不取代查證、不取代認證，也不取代 CBAM Registry |
| 客戶怎麼確認報告是真的、簽名的人有沒有權限 | 看 PDF 上的簽章；客戶用程式無法確認簽署的查核員當時是否仍代表該查證機構 | 客戶用瀏覽器或指令跑檢查：簽章、鏈上登記、查核員的 vLEI 授權鏈、報告與憑證是否一致 |
| 同一份報告給 5 個客戶 | 寄 5 份同樣的 PDF + Excel；沒有人知道總共已經用掉幾噸 | 每個客戶拿到**只屬於他的那份**證明；鏈上帳本扣噸數，**同一批已查證噸數不會被重複宣稱**，超賣的申領會被合約退回 |
| 敏感資料 | Excel／PDF 整份寄出 | **選擇性揭露**：製程路徑、能源組合、成本永遠不給；其他欄位可以依客戶決定給或不給（見 §4） |
| 給銀行、下游客戶 | 他們進不了 CBAM Registry，只能看 PDF | 同一份證明在 Registry 外也能驗 |

**多了什麼工作：** 你的查證機構要願意參與（簽發 CarbonLEI 憑證並在鏈上登記，§3 步驟 2）；你要有一個以太坊相容（EVM）錢包來申領出貨；你要自己保管一份分配帳簿。**少了什麼：** 不用為每個客戶重新整理一份資料、不用在 Excel 裡手動追蹤賣出幾噸，客戶也不用打電話來問「這份報告是不是也給了別人」。

一句話：**同一份查證報告，可以被多個買方用程式驗證，而且噸數不會被重複宣稱。** 它跟 O3CI 不衝突：有用 O3CI 的話繼續用，CarbonLEI 不會把資料寫進或讀出 Registry（[ADOPTION §1.1](ADOPTION.md#11-relationship-to-the-cbam-registry)）。

---

## 3. 一步一步來

以下指令都在 repo 根目錄執行（Node.js 22.18 以上；先 `npm ci`）。標「可直接跑」的指令用的是 repo 裡的示範檔案，會連到公開的 Sepolia 節點讀資料，**不會送出任何交易**，也不需要錢包或私鑰。

### 步驟 0：先看網頁示範（不用安裝）

打開 <https://zuemen.github.io/carbon-lei/#supplier?lang=zh-TW>（繁體中文的「供應商」分頁）。往下捲到「**分配——一份經驗證報告，多位買方**」：第 1 列是 Sepolia 上真的已申領的 200 噸，第 2、3 列是虛構的計畫分配，只存在你的瀏覽器裡。把第 2 列的數量改成超過剩餘的 300 噸，就會看到「將被拒絕」的警告；按「**為所有買方產生證明**」可以下載每位買方各自的證明檔。網頁唯讀，不用錢包。

### 步驟 1：從通訊範本開始

你本來就要填的 Excel 可以直接拿來用。`import-template` 讀取已填好的範本（2.1 或 2.1.1 版），列出它能幫你填的憑證欄位，以及還缺哪些。

```bash
# 可直接跑：執委會官方的螺絲螺帽範例（虛構工廠）
npm run import:example

# 你自己的檔案（--product 指定第幾個產品，--out 存成草稿）
node sdk/cli.ts import-template 你的範本.xlsx --product 1 --out draft.json
```

以官方範例第 1 個產品來說，它會填 7 個欄位（CN 碼 73181542、設施名稱、UN/LOCODE、報告期間、排放強度 2.00694、數值類型、製程路徑），並列出 15 個還要補的：6 個由你補（LEI、營運者 ID、設施 ID、生產路徑代碼、能源組合、成本），9 個由查證機構補（查證噸數和查證報告的各欄）。CN 7318 在 CBAM 正式期只算**直接**排放，所以它取 SEE（direct），不是 total。

網頁版：「供應商」分頁最上面的「**試用您自己的通報範本**」按鈕，檔案只在你的瀏覽器裡解析，**不會上傳**（面板內容是英文）。注意：這是草稿，不是查證過的資料；而且這份範本是過渡期的版本，執委會還沒公布正式期的範本 [S7]。

### 步驟 2：查證機構簽發憑證並在鏈上登記

這一步**不是你做的**，也是目前最大的前提：查證完成後，查證機構用它自己的金鑰簽發 CarbonLEI 憑證（`carbonlei issue`），由其主任查核員在 KERI 事件日誌中錨定，再在鏈上登記報告；登記時會寫入**你的錢包地址**，之後只有這個地址能申領出貨。你會拿到一個 `credential.json`。

- 你需要的是公司既有的 **LEI**，**不需要 vLEI**；需要 vLEI 的是查證機構和它的主任查核員（[FAQ Q13](FAQ.md)）。
- 示範用的憑證是 `fixtures/sepolia-credential.json`（虛構，可驗證 500 噸）。
- 目前**沒有任何真實的查證機構**簽發過 CarbonLEI 憑證。

### 步驟 3：建立分配帳簿（allocation book）

帳簿是放在你自己電腦上的 JSON 檔，記錄這份報告的噸數要分給誰。範例：[`docs/examples/allocation-book.json`](examples/allocation-book.json)。

| 欄位 | 意思 |
|---|---|
| `credential` | 步驟 2 拿到的憑證檔路徑（相對於帳簿；也可以用 `--credential` 指定） |
| `defaultFields` | 預設給每位買方看的欄位 |
| `importers` | 每位買方：`id`、`name`、`eori`（客戶的歐盟海關編號），可另設 `fields` |
| `batches` | 每一批：`batchId`（批號，你自己定）、`importer`、`importerSalt`、`quantityTonnes`、`shipmentDate`、`status`（`planned` 計畫中 或 `claimed` 已申領），可另設 `fields` |

每一批都要用**新的 32 位元組鹽值**（SDK 的 `newSalt()`）。同一位客戶的兩批若用同一個鹽值，鏈上就能把它們連起來，`allocate` 會警告 `SALT_REUSED`。

### 步驟 4：申領前先對帳（`allocate`）

```bash
# 可直接跑
node sdk/cli.ts allocate docs/examples/allocation-book.json
```

它用你帳簿裡的鹽值，在同一個區塊高度跟鏈上比對：每位買方分了幾噸、還剩幾噸、哪一批合約會拒絕。示範帳簿的結果是：驗證 500 噸、已申領 200 噸、剩 300 噸；第 2 批計畫 400 噸 → `OVER_ALLOCATED`（送出去會被合約以 `ExceedsVerifiedTonnage` 退回）；第 3 批 80 噸放得下。結束碼 0＝不用處理、1＝有事要處理（示範帳簿是 1）、3＝跑不起來（帳簿格式錯、讀不到憑證、節點連不上）。

遇到 `OVER_ALLOCATED`：把數量調小、改用另一份報告，或那批就讓客戶用預設值。

### 步驟 5：用錢包送出申領，再對帳一次

申領（`claimShipment`）要由步驟 2 登記的那個錢包送出。**CLI 不送交易**；參數可以用 SDK 的 `claimArgsOf` 產生，repo 目前沒有給供應商一鍵送出的工具。送出後把該批改成 `claimed`，再跑一次 `allocate`，每一批都要顯示 `CLAIMED`。

| 看到 | 代表 | 怎麼辦 |
|---|---|---|
| `CLAIM_MISSING` | 帳簿寫已申領，鏈上找不到 | 交易沒送、被退回，或批號／鹽值打錯；修好前不要寄證明 |
| `QUANTITY_MISMATCH`、`IMPORTER_MISMATCH` | 鏈上噸數或買方跟帳簿不同 | 鏈上的申領**改不了**，那個批號已經用掉；記錄原因，剩下的貨用新批號申領 |
| `UNKNOWN_CLAIM` | 鏈上有這份報告的申領，帳簿裡沒有 | 帳簿漏記，或你的錢包金鑰被別人用了，要立刻查 |
| `FIELDS_INCOMPLETE` | 這一批的欄位藏了檢查 8 需要的欄位 | 證明驗起來只會是 INCOMPLETE；把欄位補回帳簿（見〈[4. 哪些欄位可以藏起來？](#4-哪些欄位可以藏起來)〉） |

### 步驟 6：一次產生所有買方的證明（`present-batch`）

```bash
# 可直接跑（輸出到新資料夾；它不會覆蓋既有檔案）
node sdk/cli.ts present-batch docs/examples/allocation-book.json --check \
  --evidence-from fixtures/sepolia-demo-proof.json --out share-pack/
```

- 每個已申領的批次產生一個 `<買方 id>--<批號>--<雜湊>.proof.json`，只含那位買方可以看的欄位。
- `share-pack.json` 記錄哪個檔案給誰、含哪些欄位，**不含 EORI、不含鹽值**。
- `--check` 先跟鏈上對帳，只產生申領吻合的批次（示範帳簿只會產生第 1 批，第 2、3 批還沒申領會被略過）。
- `--evidence-from` 從既有的證明複製查核員錨定、授權鏈等證據，檢查 6–8 需要它們。
- 某一批的欄位若藏了檢查 8 需要的欄位，會被略過（`skipped … hides …`），因為那份證明在客戶端只會是 INCOMPLETE；確定要給才加 `--allow-incomplete`。

### 步驟 7：每位客戶只寄他自己那一份

照 `share-pack.json` 寄。寄錯也不會讓別人冒用：證明只對它自己買方的 EORI 驗得過（檢查 5），換成別人的 EORI 會得到 `INVALID (SHIPMENT_MISMATCH)`。

帳簿要跟錢包資料一樣嚴格保管：裡面有每位客戶的 EORI，以及把他們跟鏈上承諾值連起來的鹽值。

### 步驟 8：客戶怎麼驗

客戶**不需要錢包、不需要安裝**：

- **網頁：** 打開 <https://zuemen.github.io/carbon-lei/#buyer?lang=zh-TW>（「買方（進口商）」分頁），載入你寄的證明檔，按 Verify，就會看到每一項檢查和結果（VALID／INVALID／CONTESTED／INCOMPLETE）。
- **指令：**

```bash
# 可直接跑（接在步驟 6 之後）：用正確的 EORI → VALID
node sdk/cli.ts verify --proof share-pack/demo-imports--BATCH-DEMO-2026-0001--7ff0d9a847.proof.json --eori NLDEMO000000001
# 換成另一位客戶的 EORI → INVALID (SHIPMENT_MISMATCH)
node sdk/cli.ts verify --proof share-pack/demo-imports--BATCH-DEMO-2026-0001--7ff0d9a847.proof.json --eori DEDEMO000000002
```

- **給客戶留檔：** 客戶可以用 `export-communication` 把驗證過的證明轉成通訊範本 `Summary_Communication` 欄位的 CSV。只有 VALID 才會輸出；示範證明會填 7 個欄位、1 個標「供應商隱藏」、其餘 68 個空白。這份 CSV 沒有經執委會驗證，也不是 Registry 申報（[REGISTRY_EXPORT §4](REGISTRY_EXPORT.md#4-mapping-carbonlei-fields-to-the-published-fields)）。你也可以先用客戶的 EORI 跑一次，預覽客戶會拿到什麼：

```bash
node sdk/cli.ts export-communication share-pack/demo-imports--BATCH-DEMO-2026-0001--7ff0d9a847.proof.json --eori NLDEMO000000001 --out communication.csv
```

---

## 4. 哪些欄位可以藏起來？

欄位分四類（定義在 [`sdk/credential.ts`](../sdk/credential.ts) 和 [`sdk/consistency.ts`](../sdk/consistency.ts)）：

| 類別 | 欄位 | 說明 |
|---|---|---|
| **永遠不給買方** | 製程路徑（`productionRoute`）、能源組合（`energyMix`）、供應商成本（`supplierCost`） | 只留在你和查證機構手上 |
| **一定要給**（10 個） | 供應商 LEI、設施 ID、CN 代碼、生產路徑代碼（`cbamRoute`）、報告期間、經驗證數量、驗證報告 ID、方法學說明、身分鹽值、批次鹽值 | 少了這些，檢查 3–5 無法重算，證明直接不成立。帳簿裡就算漏寫，`present-batch` 也會自動補上 |
| **可以放心隱藏**（隱藏後仍可 VALID） | 營運者 ID、設施名稱、UN/LOCODE、數值類型、驗證機構 LEI | 示範證明本來就藏了營運者 ID 和設施名稱。我們 2026-10-17 在 Sepolia 實測：再多藏 UN/LOCODE、數值類型、驗證機構 LEI，結果仍是 VALID。但藏了 UN/LOCODE，客戶的 `export-communication` 就填不出國家和 UN/LOCODE |
| **藏了會變 INCOMPLETE** | 排放強度、認證編號、認證機構、現場訪查、保證等級、重大性門檻、簽發時間、有效期限 | 檢查 8 要用這些欄位比對查證報告。少一個，檢查 8 就無法判定，結果是 INCOMPLETE，**永遠不會是 VALID** |

給要用實際值申報的歐盟進口商，建議用預設的 21 個欄位。範例帳簿裡的 `demo-nordic` 用的是「最少欄位」組合：一定要給的 10 個，加上檢查 8 需要的欄位，共 18 個，只藏 UN/LOCODE、數值類型、驗證機構 LEI，驗起來仍是 VALID（`sdk/test/disclosure-presets.test.ts` 以錄下的 Sepolia 回應實際驗證）。網頁示範「分配」區的「最少欄位（仍可驗證通過）」選項就是這一組。

**防呆：** 帳簿裡某位買方的欄位若藏了檢查 8 需要的欄位，`allocate` 會列出 `FIELDS_INCOMPLETE`（要處理，結束碼 1），`present-batch` 會略過那一批並寫明原因，`present --fields` 會直接拒絕。只有在你確定要這樣給（例如客戶只拿來參考、不當實際值申報）時才加 `--allow-incomplete`：證明照樣產生，但會印出警告。網頁「供應商」分頁取消勾選這些欄位時，也會先提示買方的驗證器將回傳「未驗證（INCOMPLETE）」。

---

## 5. 分配給多個買方：噸數怎麼不被重複宣稱

- 一份報告的已查證噸數記在鏈上（示範：500 噸）。每次申領都從裡面扣，**同一個批號只能申領一次**（`BatchAlreadyClaimed`），**超過剩餘噸數就退回**（`ExceedsVerifiedTonnage`）。示範裡已經為第一位客戶申領 200 噸，剩 300 噸，再申領 400 噸給第二位客戶會被退回。
- 每筆申領在鏈上記的是「加鹽的批號雜湊 + 噸數 + 加鹽的買方 EORI 雜湊」，客戶可以把這筆紀錄當作自己的收據（[ADOPTION §2.1](ADOPTION.md#21-benefits-with-a-single-importer)）。
- 這個上限只在**同一個部署**、而且**買方有來驗**的情況下才保護得到。只有一位客戶時，它只能限制你給這位客戶的申領；越多客戶驗同一份報告，保護範圍越大。
- 批號是你自己定的，**沒有綁到實體貨物**（報關單或爐號），這是已知限制（[FAQ Q14](FAQ.md)）。

---

## 6. 常見問題

**Q1. 要不要錢包？要不要買加密貨幣？**
看網頁示範：不用。客戶驗證：不用錢包、不用安裝。**你要在鏈上申領出貨的話，需要一個 EVM 錢包**，地址由查證機構登記報告時寫入。在 Sepolia 測試網上送交易要用測試 ETH，**測試 ETH 沒有市場價值**。CarbonLEI **不發代幣**，合約沒有任何收款（payable）函式，也不做碳權交易（[FAQ Q26](FAQ.md)）。如果將來部署到正式鏈，每次申領約 155,449 gas；在 Base 這類 L2 上的估算約 US$0.002 一筆（2026-10-09 取樣的估算，不是實際部署，費用會變動；[PILOT §6](PILOT.md#6-costs-test-network-and-production-chain)）。

**Q2. 我的資料會不會公開上鏈？**
排放強度、製程、能源組合、成本這些**都不上鏈**，只在證明裡給你選定的客戶看。鏈上有的是（[ARCHITECTURE §6](ARCHITECTURE.md#6-on-chain-vs-off-chain)）：
- 憑證 ID 的雜湊（`reportKey`）、查核員識別碼的雜湊；
- 你的 LEI、設施 ID、批號、客戶 EORI 的**加鹽**雜湊（沒有鹽值的人無法用 LEI 或 EORI 清單去比對）；
- **噸數是明碼**：查證噸數、已申領噸數、每批噸數，因為合約要能擋超賣；
- 你的**錢包地址**是公開的，同一地址的申領可以被串起來；知道哪家公司用這個地址的人，就能把它連到你的 LEI；
- 查證機構的 LEI 雜湊不加鹽（認可名單本來就公開）；「設施＋報告期間」的鍵也不加鹽，知道你設施 ID 的人可以確認你那一期有登記報告（[FAQ Q4](FAQ.md)）。

**Q3. 這是正式上線的系統嗎？**
不是。跑在 Sepolia 測試網，合約沒有經過外部稽核（[PILOT §7](PILOT.md#7-risks)）。

**Q4. 示範裡的高雄螺絲廠是真的嗎？**
不是。Demo Fasteners Co.、Demo Imports B.V. 等公司、人名、`ZZZZ` 開頭的 LEI、`NLDEMO…` 的 EORI 都是虛構的，排放數字是示意，GLEIF 信任根是在本機用測試金鑰模擬的（[FAQ Q9](FAQ.md)）。

**Q5. 我們需要申請 vLEI 嗎？**
不用。你用公司既有的 LEI；執委會給非歐盟營運者的指引把 LEI 列為台灣等地營運者可用的識別碼（[FAQ Q13](FAQ.md)）。需要 vLEI 的是查證機構和它的主任查核員。

**Q6. 用了 CarbonLEI，查證費會變便宜嗎？**
不會。CarbonLEI 不做查證，查證費照付。它解決的是「同一份查證報告怎麼讓多個客戶都能用程式驗、而且噸數不被重複使用」。

**Q7. 跟 CBAM Registry 的 O3CI 衝突嗎？**
不衝突。O3CI 讓註冊的營運者在 Registry 裡一次分享資料給多個申報人 [S8]；CarbonLEI 的證明可以帶到 Registry 外（銀行、下游客戶、O3CI 沒連結到的進口商），而且帶著共享的噸數上限。CarbonLEI 不會把資料寫進或讀出 Registry。

**Q8. 申領送錯了可以改嗎？**
不行。鏈上的申領是最終的，那個批號就用掉了；記錄發生什麼事，剩下的貨用新批號申領（[OPERATE](OPERATE.md#supplier-allocations-one-report-many-buyers) 步驟 3）。

---

## 7. 限制

- **只是 Sepolia 測試網。** 測試幣沒有價值，網路與合約都是原型；正式要用哪條鏈是試辦時才決定的事（[PILOT §1](PILOT.md#1-scope)）。
- **GLEIF 信任根是模擬的。** vLEI 憑證鏈在本機 KERI 環境用測試金鑰建立；「CBAM 主任查核員」角色和國家認證機構的認證憑證是我們提出的格式，目前沒有任何人簽發（[FAQ Q9](FAQ.md)）。
- **不是 CBAM 合規。** 沒有連到 CBAM Registry，不會替你或客戶申報任何東西；CBAM 不承認 vLEI 或鏈上紀錄，鏈上收據只是客戶自己檔案裡的佐證（[ADOPTION §1.1](ADOPTION.md#11-relationship-to-the-cbam-registry)）。`export-communication` 的 CSV 沒有經執委會驗證。
- **尚無業者使用。** 沒有任何查證機構、台灣廠商或歐盟進口商在用，也還沒聯絡任何試辦夥伴（[PILOT](PILOT.md)）。
- **需要查證機構參與。** 沒有願意簽發 CarbonLEI 憑證並上鏈登記的查證機構，你一個人用不起來。
- **範本是過渡期版本。** `import-template` 讀的是過渡期範本；正式期範本還沒公布，匯入的數值不一定符合正式期規則。
- **批號沒有綁實體貨物**，合約也沒有經過外部稽核。

---

## 來源

公開來源存取日：2026-10-17。repo 內文件的原始來源與其存取日，見各文件的來源段。

- [S1] 外勞社記者劉達寬，〈歐盟CBAM上路 影響約2,600家企業 鋼材、扣件中小型加工業者首當其衝〉，2026-04-07（轉載於康林集團網站；內容引述環境部氣候變遷署與經濟部主秘莊銘池）。<https://www.kanglin.com.tw/news/%E6%AD%90%E7%9B%9Fcbam%E4%B8%8A%E8%B7%AF-%E5%BD%B1%E9%9F%BF%E7%B4%842600%E5%AE%B6%E4%BC%81%E6%A5%AD-%E9%8B%BC%E6%9D%90%E3%80%81%E6%89%A3%E4%BB%B6%E4%B8%AD%E5%B0%8F%E5%9E%8B%E5%8A%A0%E5%B7%A5%E6%A5%AD/>，存取 2026-10-17。
- [S2] European Commission, "CBAM verification" page, section "Timeline". <https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-verification_en>，存取 2026-10-17。
- [S3] 第一次年度申報期限 2027-09-30（2026 年進口）：Regulation (EU) 2023/956 Art 6(1)，經 Regulation (EU) 2025/2083 修正；憑證 2027 年 2 月起販售、2027-09-30 前繳回：Art 20(1)、Art 22(1)。見 [OPERATE › Importer workbench](OPERATE.md#importer-workbench-planning-a-years-declaration) 與 [OPERATE › Importer re-check](OPERATE.md#importer-re-check-from-acceptance-to-filing)。<https://eur-lex.europa.eu/eli/reg/2025/2083/oj/eng>
- [S4] 查證量能：執委會 "State-of-play CBAM accreditation"（2026-10-07）與 cbamguide.com "CBAM Verification 2026"（截至 2026-10-13 有五家）。見 [ADOPTION › Why these users first](ADOPTION.md#why-these-users-first) 與 [FAQ Q33](FAQ.md)。
- [S5] 預設值與加成：Implementing Regulation (EU) 2026/1740, Annex I。見 [OPERATE](OPERATE.md#importer-workbench-planning-a-years-declaration)（Mark-up 一列）與 [CLIMATE_IMPACT](CLIMATE_IMPACT.md)。
- [S6] 50 公噸門檻：Regulation (EU) 2023/956 Art 2a 與 Annex VII point 1，由 Regulation (EU) 2025/2083 增訂。見 [OPERATE](OPERATE.md#importer-workbench-planning-a-years-declaration)（De minimis 一列）。
- [S7] 通訊範本 v2.1.1 與執委會 CBAM Q&A（2026-10-15 版）Q1.15、Q5.10。見 [REGISTRY_EXPORT §1](REGISTRY_EXPORT.md#1-what-is-official-and-published)（R4、R6，存取 2026-10-17）。
- [S8] European Commission, "CBAM Registry" page（O3CI：營運者可一次分享資料給申報人）。<https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-registry_en>；見 [ADOPTION §1.1](ADOPTION.md#11-relationship-to-the-cbam-registry)。
- [S9] Guidance on CBAM verification and accreditation for verifiers and National Accreditation Bodies, 2026-08-24, p.68 §4.15（未註冊營運者收到電子簽章 PDF；在 Registry 外寄送「without any safeguard of sensitive data elements」）。見 [ADOPTION §1.1](ADOPTION.md#11-relationship-to-the-cbam-registry)。
