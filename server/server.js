// 戳蛋大作戰 - 連線多人版伺服器
// 權威判定:所有「誰打中、算分、計量表怎麼變」都在這裡算,瀏覽器只負責顯示畫面跟送出動作。
// 數值刻意跟單機版 whack-egg-roles(8)單機版完成.html 保持一致,之後任一邊改動數值記得同步另一邊。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------- 遊戲數值(跟單機版同步) ----------
const HOLE_COUNT = 9;
const GAME_TIME = 45000; // ms
const TICK_MS = 100;

const DEFENDER_SCORE_RATE = 2;
const METER_EGG_PRESENCE_DRIFT = 0.6;
const METER_EGG_HIT = 5;
const METER_TOAST_HIT = 15;
const METER_STONE_PENALTY = 8;
const TOAST_MOD_DURATION = 3000;

const PREVIEW_LEAD = 2000;
const COMBO_DURATION = 8000;
const COMBO_COOLDOWN = 1000;
const DISGUISE_AIM_WINDOW = 3000;
const DISGUISE_COOLDOWN = 1000;

function randType() {
  const r = Math.random();
  if (r < 0.08) return 'toast';
  if (r < 0.30) return 'stone';
  return 'egg';
}

function difficultyProgress(room) {
  const elapsed = Date.now() - room.startTime;
  return Math.min(1, elapsed / GAME_TIME);
}

// ---------- 房間代碼 ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 避開易混淆字元 0/O 1/I
function makeRoomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
function makePlayerId() {
  return crypto.randomBytes(6).toString('hex');
}

// ---------- 房間管理 ----------
const rooms = new Map(); // code -> room

function createRoom() {
  let code;
  do { code = makeRoomCode(); } while (rooms.has(code));
  const room = {
    code,
    players: {}, // role('attacker'|'defender') -> { ws, id, connected }
    phase: 'lobby', // lobby | playing | ended
    holes: Array.from({ length: HOLE_COUNT }, () => ({ type: null, displayType: null, pending: null })),
    pendingSet: new Set(),
    activeSet: new Set(),
    meter: 50,
    scoreAttacker: 0,
    scoreDefender: 0,
    scoreModDelta: 0,
    scoreModUntil: 0,
    comboActive: false,
    comboN: 1,
    comboCooldownUntil: 0,
    comboEndTimer: null,
    disguiseAiming: false,
    disguiseCooldownUntil: 0,
    disguiseAimTimer: null,
    startTime: 0,
    tickInterval: null,
    spawnTimeout: null,
    holeTimers: Array.from({ length: HOLE_COUNT }, () => ({ retract: null, clear: null, reveal: null })),
    events: [], // 這一輪tick期間累積的浮動文字事件,广播後清空
  };
  rooms.set(code, room);
  return room;
}

function otherRole(role) {
  return role === 'attacker' ? 'defender' : 'attacker';
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastLobby(room) {
  const rolesInfo = {
    attacker: !!room.players.attacker,
    defender: !!room.players.defender,
  };
  for (const role of ['attacker', 'defender']) {
    const p = room.players[role];
    if (p) send(p.ws, { type: 'lobby_update', code: room.code, yourRole: role, roles: rolesInfo });
  }
}

function roomIsFull(room) {
  return !!room.players.attacker && !!room.players.defender;
}

// ---------- 每個角色看到的棋盤視角 ----------
function buildHolesView(room, role) {
  return room.holes.map((h, i) => {
    const up = room.activeSet.has(i);
    const view = {
      up,
      shape: up ? h.type : null,       // 真實外型(蛋/石頭/吐司的形狀),偽裝不會改變這個
      color: up ? h.displayType : null, // 顯示顏色,偽裝時會跟shape不一樣
    };
    if (role === 'defender') {
      const isPending = room.pendingSet.has(i);
      view.previewType = isPending ? h.pending.trueType : null;
      view.aimTarget = isPending && room.disguiseAiming;
    }
    return view;
  });
}

function buildStateFor(room, role) {
  const now = Date.now();
  const remain = room.phase === 'playing' ? Math.max(0, GAME_TIME - (now - room.startTime)) : GAME_TIME;
  return {
    type: 'state',
    holes: buildHolesView(room, role),
    meter: Math.max(0, Math.min(100, room.meter)),
    scoreAttacker: Math.round(room.scoreAttacker),
    scoreDefender: Math.round(room.scoreDefender),
    timeRemainMs: remain,
    scoreMod: now < room.scoreModUntil ? { delta: room.scoreModDelta, remainMs: room.scoreModUntil - now } : null,
    combo: role === 'attacker' ? {
      active: room.comboActive,
      n: room.comboN,
      cooldownRemainMs: Math.max(0, room.comboCooldownUntil - now),
    } : null,
    disguise: role === 'defender' ? {
      aiming: room.disguiseAiming,
      cooldownRemainMs: Math.max(0, room.disguiseCooldownUntil - now),
    } : null,
    events: room.events.filter(e => e.forRole === 'all' || e.forRole === role).map(e => e.payload),
  };
}

function broadcastState(room) {
  for (const role of ['attacker', 'defender']) {
    const p = room.players[role];
    if (p) send(p.ws, buildStateFor(room, role));
  }
  room.events = [];
}

function pushEvent(room, forRole, payload) {
  room.events.push({ forRole, payload });
}

// ---------- 連擊(攻擊方技能) ----------
function activateCombo(room) {
  if (room.phase !== 'playing' || room.comboActive || Date.now() < room.comboCooldownUntil) return;
  room.comboActive = true;
  room.comboN = 1;
  clearTimeout(room.comboEndTimer);
  room.comboEndTimer = setTimeout(() => deactivateCombo(room), COMBO_DURATION);
}
function deactivateCombo(room) {
  room.comboActive = false;
  clearTimeout(room.comboEndTimer);
  room.comboCooldownUntil = Date.now() + COMBO_COOLDOWN;
}

// ---------- 偽裝(防守方技能) ----------
function activateDisguiseAiming(room) {
  if (room.phase !== 'playing' || room.disguiseAiming || Date.now() < room.disguiseCooldownUntil) return;
  room.disguiseAiming = true;
  clearTimeout(room.disguiseAimTimer);
  room.disguiseAimTimer = setTimeout(() => endDisguiseAiming(room), DISGUISE_AIM_WINDOW);
}
function endDisguiseAiming(room) {
  room.disguiseAiming = false;
  clearTimeout(room.disguiseAimTimer);
  room.disguiseCooldownUntil = Date.now() + DISGUISE_COOLDOWN;
}
function tryLockDisguise(room, idx) {
  const h = room.holes[idx];
  const p = h.pending;
  if (!p || p.disguised || (p.trueType !== 'egg' && p.trueType !== 'stone')) return;
  p.disguised = true;
  p.displayType = p.trueType === 'egg' ? 'stone' : 'egg';
  endDisguiseAiming(room);
}

// ---------- 生成/揭曉/收回 ----------
function scheduleSpawn(room) {
  if (room.phase !== 'playing') return;
  const prog = difficultyProgress(room);
  const gap = 620 - prog * 320; // 620ms -> 300ms
  room.spawnTimeout = setTimeout(() => scheduleNextPendingSpawn(room), gap + Math.random() * 150);
}

function scheduleNextPendingSpawn(room) {
  if (room.phase !== 'playing') return;
  const free = room.holes.map((h, i) => i).filter(i => !room.activeSet.has(i) && !room.pendingSet.has(i));
  if (free.length === 0) { scheduleSpawn(room); return; }
  const idx = free[Math.floor(Math.random() * free.length)];
  const type = randType();
  const h = room.holes[idx];
  room.pendingSet.add(idx);
  h.pending = { trueType: type, disguised: false, displayType: type };
  room.holeTimers[idx].reveal = setTimeout(() => revealPendingSpawn(room, idx), PREVIEW_LEAD);
  scheduleSpawn(room);
}

function revealPendingSpawn(room, idx) {
  if (room.phase !== 'playing') return;
  const h = room.holes[idx];
  const p = h.pending;
  if (!p) return;
  room.pendingSet.delete(idx);
  h.pending = null;

  const trueType = p.trueType;
  h.type = trueType; // 計分永遠用真實種類
  h.displayType = p.disguised ? p.displayType : trueType; // 攻擊方看到的是「顯示顏色」,可能被偽裝
  room.activeSet.add(idx);

  const prog = difficultyProgress(room);
  const showTime = 950 - prog * 480; // 950ms -> 470ms
  room.holeTimers[idx].retract = setTimeout(() => {
    if (room.holes[idx].type) retract(room, idx);
  }, showTime);
}

function retract(room, idx) {
  room.activeSet.delete(idx);
  clearTimeout(room.holeTimers[idx].retract);
  room.holeTimers[idx].clear = setTimeout(() => {
    if (!room.activeSet.has(idx)) {
      room.holes[idx].type = null;
      room.holes[idx].displayType = null;
      room.holes[idx].resolved = false;
    }
  }, 200);
}

// ---------- 點擊判定(只有攻擊方會點出結果,防守方點擊只用來鎖定偽裝) ----------
function resolveHoleClick(room, idx) {
  if (room.phase !== 'playing') return;
  const h = room.holes[idx];
  if (!h.type || h.resolved) return; // 點空的或已經判定過,沒獎懲

  h.resolved = true; // 標記已判定,避免同一個洞在收回動畫期間被重複計分
  const type = h.type; // 真實種類,先不清空 h.type,畫面渲染(外型)還要用到,等 retract 才清
  clearTimeout(room.holeTimers[idx].retract);

  if (type === 'egg') {
    let gained;
    if (room.comboActive) {
      gained = 10 * room.comboN;
      room.comboN += 1;
      if (room.comboN > 5) deactivateCombo(room);
    } else {
      const bonus = (Date.now() < room.scoreModUntil) ? room.scoreModDelta : 0;
      const effectiveMult = Math.max(0, 1 + bonus);
      gained = 10 * effectiveMult;
    }
    room.scoreAttacker += gained;
    room.meter += METER_EGG_HIT;
    pushEvent(room, 'attacker', { kind: 'float', idx, text: '+' + gained, good: gained > 0 });
    pushEvent(room, 'defender', { kind: 'hit', idx });
  } else if (type === 'toast') {
    const delta = Math.random() < 0.5 ? 1 : -1;
    room.scoreModDelta = delta;
    room.scoreModUntil = Date.now() + TOAST_MOD_DURATION;
    room.meter += METER_TOAST_HIT;
    pushEvent(room, 'attacker', { kind: 'float', idx, text: delta > 0 ? 'BUFF +1倍(3秒)' : 'DEBUFF -1倍(3秒)', good: delta > 0 });
    pushEvent(room, 'defender', { kind: 'hit', idx });
  } else if (type === 'stone') {
    let penalty;
    if (room.comboActive) {
      penalty = 15 * room.comboN;
      room.scoreAttacker = Math.max(0, room.scoreAttacker - penalty);
      deactivateCombo(room);
    } else {
      penalty = 15;
      room.scoreAttacker = Math.max(0, room.scoreAttacker - penalty);
    }
    room.meter -= METER_STONE_PENALTY;
    pushEvent(room, 'attacker', { kind: 'float', idx, text: '-' + penalty, good: false });
    pushEvent(room, 'defender', { kind: 'hit', idx });
  }

  setTimeout(() => retract(room, idx), 130);
}

// ---------- 每 100ms 的節奏 ----------
function tick(room) {
  const activeEggCount = room.holes.filter(h => h.type === 'egg').length;
  if (activeEggCount > 0) {
    room.meter -= METER_EGG_PRESENCE_DRIFT * activeEggCount;
    room.scoreDefender += DEFENDER_SCORE_RATE * activeEggCount;
  }
  broadcastState(room);

  const elapsed = Date.now() - room.startTime;
  if (elapsed >= GAME_TIME) {
    endGame(room);
  }
}

function clearAllTimers(room) {
  clearTimeout(room.spawnTimeout);
  clearInterval(room.tickInterval);
  clearTimeout(room.comboEndTimer);
  clearTimeout(room.disguiseAimTimer);
  room.holeTimers.forEach(t => { clearTimeout(t.retract); clearTimeout(t.clear); clearTimeout(t.reveal); });
}

function startGame(room) {
  clearAllTimers(room);
  room.phase = 'playing';
  room.scoreAttacker = 0;
  room.scoreDefender = 0;
  room.meter = 50;
  room.scoreModDelta = 0;
  room.scoreModUntil = 0;
  room.comboActive = false; room.comboN = 1; room.comboCooldownUntil = 0;
  room.disguiseAiming = false; room.disguiseCooldownUntil = 0;
  room.holes = Array.from({ length: HOLE_COUNT }, () => ({ type: null, displayType: null, pending: null }));
  room.pendingSet.clear();
  room.activeSet.clear();
  room.events = [];
  room.startTime = Date.now();

  for (const role of ['attacker', 'defender']) {
    const p = room.players[role];
    if (p) send(p.ws, { type: 'game_start', gameTimeMs: GAME_TIME, holeCount: HOLE_COUNT, yourRole: role });
  }

  scheduleSpawn(room);
  room.tickInterval = setInterval(() => tick(room), TICK_MS);
}

function endGame(room) {
  clearAllTimers(room);
  room.phase = 'ended';
  const result = {
    type: 'game_end',
    scoreAttacker: Math.round(room.scoreAttacker),
    scoreDefender: Math.round(room.scoreDefender),
    meter: Math.max(0, Math.min(100, room.meter)),
  };
  for (const role of ['attacker', 'defender']) {
    const p = room.players[role];
    if (p) send(p.ws, result);
  }
}

function destroyRoom(room) {
  clearAllTimers(room);
  rooms.delete(room.code);
}

// ---------- HTTP(順便放靜態檔案,方便直接用同一個Render服務測試) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.playerId = makePlayerId();
  ws.roomCode = null;
  ws.role = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create_room') {
      const role = msg.role === 'defender' ? 'defender' : 'attacker';
      const room = createRoom();
      room.players[role] = { ws, id: ws.playerId, connected: true };
      ws.roomCode = room.code;
      ws.role = role;
      send(ws, { type: 'room_created', code: room.code, yourRole: role });
      broadcastLobby(room);
      return;
    }

    if (msg.type === 'join_room') {
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: 'error', message: '找不到這個房間代碼,確認代碼是否正確。' }); return; }
      if (roomIsFull(room)) { send(ws, { type: 'error', message: '這個房間已經滿了(2人)。' }); return; }
      const takenRole = room.players.attacker ? 'attacker' : 'defender';
      const myRole = otherRole(takenRole);
      room.players[myRole] = { ws, id: ws.playerId, connected: true };
      ws.roomCode = room.code;
      ws.role = myRole;
      send(ws, { type: 'joined', code: room.code, yourRole: myRole });
      broadcastLobby(room);
      if (roomIsFull(room)) startGame(room);
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (msg.type === 'click_hole') {
      const idx = msg.idx | 0;
      if (idx < 0 || idx >= HOLE_COUNT) return;
      if (ws.role === 'attacker') {
        resolveHoleClick(room, idx);
      } else if (ws.role === 'defender' && room.disguiseAiming) {
        tryLockDisguise(room, idx);
      }
      return;
    }

    if (msg.type === 'activate_skill') {
      if (ws.role === 'attacker' && msg.skill === 'combo') activateCombo(room);
      if (ws.role === 'defender' && msg.skill === 'disguise') activateDisguiseAiming(room);
      return;
    }

    if (msg.type === 'rematch') {
      if (roomIsFull(room)) startGame(room);
      return;
    }

    if (msg.type === 'leave_room') {
      ws.close();
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (room.players[ws.role] && room.players[ws.role].id === ws.playerId) {
      delete room.players[ws.role];
    }
    const other = room.players[otherRole(ws.role)];
    if (other) {
      send(other.ws, { type: 'opponent_left' });
    }
    if (room.phase === 'playing') clearAllTimers(room);
    if (Object.keys(room.players).length === 0) {
      destroyRoom(room);
    } else {
      room.phase = 'lobby';
      broadcastLobby(room);
    }
  });
});

server.listen(PORT, () => {
  console.log('戳蛋大作戰連線伺服器啟動,port ' + PORT);
});
