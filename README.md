# 戳蛋大作戰 - 連線多人版(第一版)

## 這一版做了什麼

- **即時對戰,2人1房間,房間代碼配對**(照你確認過的方向做)
- 伺服器權威判定:誰打中、算分、拔河計量表怎麼變,全部由伺服器算好,瀏覽器只負責顯示畫面跟送出「我點了哪個洞/按了哪個技能」
- 拔河計量表這次真的顯示出來了(單機版藏起來,連線版才是它該登場的地方)
- 連擊(攻擊方)、偽裝(防守方)、吐司BUFF/DEBUFF,數值都跟單機版一致
- 防守方的「預告」機制完整保留,攻擊方看不到,資訊隔離有測試過

## 這一版刻意先不做的部分(照之前討論)

- **暫停/恢復**:連線模式需要雙方同意才能暫停,邏輯比單機版複雜很多,先跳過
- **盾牌技能**:風險設計還沒拍板,先不加
- **隨機配對、多房間列表**:先只做房間代碼,配對之後有需要再加
- **AI游標/AI機率判斷**:兩邊都是真人,不需要了,直接拿掉

## 檔案結構

```
whack-egg-online/
├── server/
│   ├── server.js       ← WebSocket伺服器,權威判定邏輯
│   └── package.json
└── public/
    └── index.html      ← 前端畫面(大廳、房間代碼、遊戲畫面)
```

`server.js` 啟動時會自動把 `public/index.html` 當靜態網頁一起放出來,代表**只要把 server 資料夾部署到 Render,一個網址就能玩**,不一定要另外用 itch.io。

## 部署到 Render(照你之前做法律網站的方式)

1. 把整個 `whack-egg-online` 資料夾推到一個新的 GitHub repo
2. Render 建立新的 **Web Service**,連到這個repo,Root Directory 設成 `server`
3. Build Command: `npm install`,Start Command: `npm start`
4. 部署完會拿到一個網址,例如 `https://whack-egg-online.onrender.com`,直接打開就能玩,兩台裝置各開一次就能連線對戰

## 如果之後想改放到itch.io(前端另外放)

把 `public/index.html` 單獨包成zip上傳到itch.io當HTML5遊戲,並且:

1. 在itch.io後台把embed設定改成「開新視窗」而不是嵌在頁面裡玩(避免跨網域連線被擋)
2. 在遊戲網址後面加 `?server=wss://你的render網址`,或者直接打開 `index.html` 把檔案最上面 `DEFAULT_SERVER_URL` 那行改成你的Render網址(記得開頭是 `wss://` 不是 `ws://`)
3. 在Render伺服器的CORS/連線設定上,itch.io那邊來源網域是 `html.itch.zone` 或 `html-classic.itch.zone`,目前 server.js 沒有另外限制來源,先天上不會擋,如果之後要收緊安全性再加白名單

## 之後如果要繼續做的方向(照你之前的優先順序)

1. 先照原計畫用單機版測水溫(itch.io上架 + 冷信邀請 + 主頻道曝光)
2. 有明確反應後,再回來把這個連線版接上房間代碼分享的體驗細節(例如複製連結按鈕、行動裝置版面微調)
3. 盾牌技能的「雙方可見訊號」提案(筆記裡的提案9)可以在連線版數值穩定後再排進來
