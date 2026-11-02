// ===== いまの画面でパックマン =====
// 表示中の道路がそのまま迷路になる。
//  - エサ：道路の上の点。パワーエサ：道の駅・SA・PA（取るとお化けがいじける）
//  - お化け：画面にある国道の標識（逆おにぎり）。重用区間では速くなる
//  - 自機は高速道路の上だと速い
"use strict";

const Pac = (() => {
  const SNAP = 5;          // この距離（px）以内の点は同じ交差点とみなす
  const DOT_GAP = 18;      // エサの間隔（px）
  const SPEED = 95;        // 自機の速さ（px/秒）
  let cv, g, W, H, dpr, raf = 0, last = 0, running = false, paused = false;
  let graph, dots, power, player, ghosts, state;
  let input = { x: 0, y: 0 };
  const hiKey = "pacHiScore";

  // ---------- 迷路（グラフ）を作る ----------
  function buildGraph() {
    const layers = CATS.map(c => "line-" + c.id).filter(id => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");
    const feats = map.queryRenderedFeatures({ layers });
    const nodes = [], key = new Map(), edges = [], ekey = new Set();
    const nodeAt = (x, y) => {
      const k = Math.round(x / SNAP) + "," + Math.round(y / SNAP);
      let i = key.get(k);
      if (i === undefined) { i = nodes.length; nodes.push({ x, y, adj: [] }); key.set(k, i); }
      return i;
    };
    // 1) 画面内の線分を集める
    const segs = [], refCount = {};
    for (const f of feats) {
      const p = f.properties, gm = f.geometry;
      const lines = gm.type === "LineString" ? [gm.coordinates] : gm.type === "MultiLineString" ? gm.coordinates : [];
      if (p.cls === "kokudo" && p.ref) for (const r of String(p.ref).split(";")) refCount[r] = (refCount[r] || 0) + 1;
      for (const line of lines) {
        let prev = null;
        for (let i = 0; i < line.length; i++) {
          const pt = map.project(line[i]);
          const out = pt.x < -20 || pt.y < -20 || pt.x > W + 20 || pt.y > H + 20;
          if (out) { prev = null; continue; }
          // 細かすぎる点は間引く（最後の点は残す）
          if (prev && i < line.length - 1 && Math.hypot(pt.x - prev.x, pt.y - prev.y) < SNAP * 1.6) continue;
          if (prev) segs.push({ ax: prev.x, ay: prev.y, bx: pt.x, by: pt.y, cls: p.cls, nref: +p.nref || 1, cut: [] });
          prev = pt;
        }
      }
    }
    // 2) 交差点の点がデータで省かれていても、線が交わる所はつなぐ
    const CELL = 40, grid = new Map();
    segs.forEach((sg, i) => {
      const x0 = Math.floor(Math.min(sg.ax, sg.bx) / CELL), x1 = Math.floor(Math.max(sg.ax, sg.bx) / CELL);
      const y0 = Math.floor(Math.min(sg.ay, sg.by) / CELL), y1 = Math.floor(Math.max(sg.ay, sg.by) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x + "," + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
    });
    const done = new Set();
    for (const list of grid.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = segs[list[i]], c = segs[list[j]], pk = list[i] < list[j] ? list[i] + "-" + list[j] : list[j] + "-" + list[i];
      if (done.has(pk)) continue; done.add(pk);
      const rx = a.bx - a.ax, ry = a.by - a.ay, sx = c.bx - c.ax, sy = c.by - c.ay, den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-6) continue;
      const qx = c.ax - a.ax, qy = c.ay - a.ay, t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
      // 端の点が相手の線の途中に乗っている（T字路）場合も含める
      const ea = 1 / (Math.hypot(rx, ry) || 1), ec = 1 / (Math.hypot(sx, sy) || 1);
      if (t < -ea || t > 1 + ea || u < -ec || u > 1 + ec) continue;
      const x = a.ax + rx * t, y = a.ay + ry * t;
      if (t > ea && t < 1 - ea) a.cut.push([t, x, y]);
      if (u > ec && u < 1 - ec) c.cut.push([u, x, y]);
    }
    // 3) つなぎ目で区切ってグラフにする
    const addEdge = (i, j, sg) => {
      if (i === j) return;
      const k = i < j ? i + "-" + j : j + "-" + i;
      if (ekey.has(k)) return;
      ekey.add(k);
      const a = nodes[i], b = nodes[j];
      edges.push({ a: i, b: j, len: Math.hypot(b.x - a.x, b.y - a.y), cls: sg.cls, nref: sg.nref });
      a.adj.push(edges.length - 1); b.adj.push(edges.length - 1);
    };
    for (const sg of segs) {
      const pts = [[0, sg.ax, sg.ay], ...sg.cut.sort((p, q) => p[0] - q[0]), [1, sg.bx, sg.by]];
      let prev = nodeAt(pts[0][1], pts[0][2]);
      for (let k = 1; k < pts.length; k++) { const n = nodeAt(pts[k][1], pts[k][2]); addEdge(prev, n, sg); prev = n; }
    }
    // 一番大きくつながっている部分だけ使う
    const comp = new Int32Array(nodes.length).fill(-1);
    let best = -1, bestSize = 0;
    for (let s = 0, cid = 0; s < nodes.length; s++) {
      if (comp[s] !== -1) continue;
      let size = 0; const st = [s]; comp[s] = cid;
      while (st.length) {
        const v = st.pop(); size++;
        for (const ei of nodes[v].adj) { const e = edges[ei], u = e.a === v ? e.b : e.a; if (comp[u] === -1) { comp[u] = cid; st.push(u); } }
      }
      if (size > bestSize) { bestSize = size; best = cid; }
      cid++;
    }
    for (let i = 0; i < nodes.length; i++) nodes[i].on = comp[i] === best;
    const ghostRefs = Object.entries(refCount).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    return { nodes, edges, ghostRefs, size: bestSize };
  }
  const other = (e, v) => (e.a === v ? e.b : e.a);

  function placeDots() {
    const out = [], grid = new Map();
    const near = (x, y) => {
      const gx = Math.floor(x / DOT_GAP), gy = Math.floor(y / DOT_GAP);
      for (let i = gx - 1; i <= gx + 1; i++) for (let j = gy - 1; j <= gy + 1; j++)
        for (const d of grid.get(i + "," + j) || []) if (Math.hypot(d.x - x, d.y - y) < DOT_GAP * 0.8) return true;
      return false;
    };
    const add = (x, y) => {
      if (x < 8 || y < 8 || x > W - 8 || y > H - 8 || near(x, y)) return;
      const d = { x, y, alive: true }; out.push(d);
      const k = Math.floor(x / DOT_GAP) + "," + Math.floor(y / DOT_GAP);
      if (!grid.has(k)) grid.set(k, []); grid.get(k).push(d);
    };
    for (const e of graph.edges) {
      const a = graph.nodes[e.a], b = graph.nodes[e.b];
      if (!a.on) continue;
      add(a.x, a.y);
      for (let t = DOT_GAP; t < e.len; t += DOT_GAP) add(a.x + (b.x - a.x) * t / e.len, a.y + (b.y - a.y) * t / e.len);
    }
    return out;
  }
  function nearestNode(x, y, maxD = Infinity) {
    let best = -1, bd = maxD;
    graph.nodes.forEach((n, i) => { if (!n.on) return; const d = Math.hypot(n.x - x, n.y - y); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  function placePower() {
    const out = [], used = new Set();
    const fac = map.queryRenderedFeatures({ layers: ["eki", "rest"].filter(l => map.getLayer(l)) });
    for (const f of fac) {
      const pt = map.project(f.geometry.coordinates);
      const n = nearestNode(pt.x, pt.y, 60);
      if (n < 0 || used.has(n)) continue;
      used.add(n);
      const p = f.properties;
      out.push({ node: n, alive: true, label: p.kind ? (p.kind === "SA" ? "SA" : "PA") : "駅",
        name: p.kind ? (p.name || (p.kind === "SA" ? "サービスエリア" : "パーキングエリア")) : "道の駅 " + p.name });
      if (out.length >= 8) break;
    }
    // 施設が少なければ四隅の近くに足す
    for (const [fx, fy] of [[0.12, 0.15], [0.88, 0.15], [0.12, 0.88], [0.88, 0.88]]) {
      if (out.length >= 4) break;
      const n = nearestNode(W * fx, H * fy);
      if (n >= 0 && !used.has(n)) { used.add(n); out.push({ node: n, alive: true, label: "★", name: "パワーエサ" }); }
    }
    return out;
  }

  // ---------- 動き ----------
  // 移動体：from ノードから edge に沿って d px 進んだ位置
  function makeMover(node, speed) { return { from: node, edge: -1, d: 0, speed, dir: { x: 1, y: 0 } }; }
  function pos(m) {
    if (m.edge < 0) { const n = graph.nodes[m.from]; return { x: n.x, y: n.y }; }
    const e = graph.edges[m.edge], a = graph.nodes[m.from], b = graph.nodes[other(e, m.from)];
    const t = e.len ? m.d / e.len : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  function edgeDir(v, ei) {
    const a = graph.nodes[v], b = graph.nodes[other(graph.edges[ei], v)], l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  }
  // ノードで次の道を選ぶ。choose(候補の辺) → 選んだ辺
  function advance(m, dist, choose) {
    let guard = 0;
    while (dist > 0 && guard++ < 50) {
      if (m.edge < 0) {
        const ei = choose(m, graph.nodes[m.from].adj);
        if (ei === undefined || ei < 0) return;
        m.edge = ei; m.d = 0; m.dir = edgeDir(m.from, ei);
      }
      const e = graph.edges[m.edge], left = e.len - m.d;
      if (dist < left) { m.d += dist; return; }
      dist -= left; m.prevEdge = m.edge; m.from = other(e, m.from); m.edge = -1; m.d = 0;
      m.onArrive && m.onArrive(m.from);
    }
  }
  function reverse(m) {
    if (m.edge < 0) return;
    const e = graph.edges[m.edge];
    m.from = other(e, m.from); m.d = e.len - m.d; m.dir = { x: -m.dir.x, y: -m.dir.y }; m.prevEdge = m.edge;
  }
  const dot = (a, b) => a.x * b.x + a.y * b.y;

  // 自機：行きたい方向に一番近い道へ。合うものが無ければ、まっすぐに近い道へ
  function choosePlayer(m, adj) {
    const cand = adj.filter(ei => ei !== m.prevEdge);
    if (!cand.length) return adj.length && (input.x || input.y) && dot(edgeDir(m.from, adj[0]), input) > 0.3 ? adj[0] : -1;
    if (cand.length === 1 && !(input.x || input.y)) return cand[0];
    let best = -1, bs = -2;
    if (input.x || input.y) for (const ei of cand) { const s = dot(edgeDir(m.from, ei), input); if (s > bs) { bs = s; best = ei; } }
    if (bs > 0.35) return best;
    best = -1; bs = -2;
    for (const ei of cand) { const s = dot(edgeDir(m.from, ei), m.dir); if (s > bs) { bs = s; best = ei; } }
    return best;
  }
  // お化け：狙う場所に一番近づく道へ（来た道には戻らない）
  function chooseGhost(gh) {
    return (m, adj) => {
      let cand = adj.filter(ei => ei !== m.prevEdge);
      if (!cand.length) cand = adj;
      if (gh.mode === "fright") return cand[Math.floor(Math.random() * cand.length)];
      const t = ghostTarget(gh);
      let best = cand[0], bd = Infinity;
      for (const ei of cand) {
        const n = graph.nodes[other(graph.edges[ei], m.from)];
        const d = Math.hypot(n.x - t.x, n.y - t.y) + Math.random() * 6;
        if (d < bd) { bd = d; best = ei; }
      }
      return best;
    };
  }
  function ghostTarget(gh) {
    const p = pos(player.m);
    if (gh.mode === "eaten") { const n = graph.nodes[state.home]; return n; }
    if (state.scatter) return gh.corner;
    switch (gh.kind) {
      case 0: return p;                                                       // 追いかける
      case 1: return { x: p.x + player.m.dir.x * 70, y: p.y + player.m.dir.y * 70 };   // 先回り
      case 2: { const q = pos(ghosts[0].m); return { x: p.x * 2 - q.x, y: p.y * 2 - q.y }; } // はさみうち
      default: { const q = pos(gh.m); return Math.hypot(q.x - p.x, q.y - p.y) > 120 ? p : gh.corner; }  // 気まぐれ
    }
  }

  // ---------- 開始・ステージ ----------
  function start() {
    if (running) return;
    const z = map.getZoom();
    if (z < 10.5) { alert("もう少し地図を拡大してから始めてください（市区町村が見えるくらい）"); return; }
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = map.getContainer().clientWidth; H = map.getContainer().clientHeight;
    graph = buildGraph();
    if (graph.size < 25) { alert("この画面には道路が少なすぎます。道路の多い場所に移動するか、少し縮小してください"); return; }
    if (graph.size > 6000) { alert("この画面は道路が多すぎます。もう少し拡大してください"); return; }
    cv = document.createElement("canvas"); cv.id = "pacCanvas";
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    g = cv.getContext("2d");
    hud = document.createElement("div"); hud.id = "pacHud";
    hud.innerHTML = `<span id="pacScore"></span><span id="pacLives"></span>
      <button id="pacPause" aria-label="一時停止">⏸</button><button id="pacQuit" aria-label="やめる">✕</button>
      <div id="pacMsg"></div>`;
    map.getContainer().appendChild(cv); map.getContainer().appendChild(hud);
    document.body.classList.add("pacmode");
    state = { score: 0, lives: 3, stage: 1, hi: +(localStorage.getItem(hiKey) || 0), combo: 0, frightT: 0, modeT: 0, scatter: true, home: 0 };
    newStage(true);
    running = true; paused = false; last = performance.now();
    raf = requestAnimationFrame(loop);
    bindInput(true);
  }
  let hud;
  function newStage(first) {
    dots = placeDots();
    power = placePower();
    resetPositions();
    if (!first) msg(`ステージ ${state.stage}`, 1500); else msg("スワイプか矢印キーで操作。道の駅・SA・PAがパワーエサです", 3200);
  }
  function resetPositions() {
    const pn = nearestNode(W / 2, H / 2);
    player = { m: makeMover(pn, SPEED), mouth: 0, dead: 0 };
    input = { x: 0, y: 0 };
    // お化けの巣：自機から一番遠い辺りの交差点
    let far = 0, fd = -1;
    graph.nodes.forEach((n, i) => { if (!n.on || n.adj.length < 2) return; const d = Math.hypot(n.x - W / 2, n.y - H / 2); if (d > fd && n.x > 30 && n.y > 60 && n.x < W - 30 && n.y < H - 30) { fd = d; far = i; } });
    state.home = far;
    const refs = graph.ghostRefs.length ? graph.ghostRefs : [];
    const fallback = ["1", "16", "20", "357"];
    const colors = ["#e03131", "#f783ac", "#22b8cf", "#f59f00"];
    const corners = [{ x: W, y: 0 }, { x: 0, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    ghosts = [0, 1, 2, 3].map(k => {
      const gh = { kind: k, ref: refs[k] || fallback[k], color: colors[k], corner: corners[k], mode: "wait", wait: 1 + k * 3.5,
        m: makeMover(far, SPEED * (0.82 + state.stage * 0.04)) };
      return gh;
    });
    state.frightT = 0; state.modeT = 0; state.scatter = true;
  }
  function stop() {
    running = false; cancelAnimationFrame(raf);
    bindInput(false);
    cv && cv.remove(); hud && hud.remove(); cv = hud = null;
    document.body.classList.remove("pacmode");
  }

  // ---------- 1コマごとの処理 ----------
  function loop(t) {
    if (!running) return;
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    if (!paused) update(dt);
    draw(t / 1000);
    raf = requestAnimationFrame(loop);
  }
  function update(dt) {
    if (player.dead > 0) {
      player.dead -= dt;
      if (player.dead <= 0) {
        if (state.lives <= 0) return gameOver();
        resetPositions();
      }
      return;
    }
    // 追いかけ／散らばりの切り替え（散らばり7秒・追いかけ20秒）
    if (state.frightT > 0) { state.frightT -= dt; if (state.frightT <= 0) ghosts.forEach(gh => { if (gh.mode === "fright") gh.mode = "chase"; }); }
    else { state.modeT += dt; const cyc = state.modeT % 27; const sc = cyc < 7; if (sc !== state.scatter) { state.scatter = sc; ghosts.forEach(gh => gh.mode === "chase" && reverse(gh.m)); } }

    // 自機：高速道路の上は1.5倍速
    const pe = player.m.edge >= 0 ? graph.edges[player.m.edge] : null;
    const pspeed = player.m.speed * (pe && pe.cls === "kosoku" ? 1.5 : 1) * (1 + (state.stage - 1) * 0.03);
    if (player.m.edge >= 0 && (input.x || input.y) && dot(player.m.dir, input) < -0.5) reverse(player.m);
    advance(player.m, pspeed * dt, choosePlayer);
    player.mouth += dt * 10;
    const p = pos(player.m);

    // エサ
    for (const d of dots) if (d.alive && Math.abs(d.x - p.x) < 9 && Math.abs(d.y - p.y) < 9) { d.alive = false; state.score += 10; sfx("dot"); }
    for (const pw of power) {
      if (!pw.alive) continue;
      const n = graph.nodes[pw.node];
      if (Math.hypot(n.x - p.x, n.y - p.y) < 11) {
        pw.alive = false; state.score += 50; state.combo = 0;
        state.frightT = Math.max(3, 8 - state.stage * 0.6);
        ghosts.forEach(gh => { if (gh.mode === "chase" || gh.mode === "wait") { if (gh.mode === "chase") reverse(gh.m); gh.mode = gh.mode === "wait" ? "wait" : "fright"; } });
        msg(`${pw.name} でパワーアップ！`, 1600); sfx("power");
      }
    }

    // お化け
    for (const gh of ghosts) {
      if (gh.mode === "wait") { gh.wait -= dt; if (gh.wait <= 0) gh.mode = state.frightT > 0 ? "fright" : "chase"; continue; }
      const e = gh.m.edge >= 0 ? graph.edges[gh.m.edge] : null;
      let sp = gh.m.speed;
      if (gh.mode === "fright") sp *= 0.55;
      else if (gh.mode === "eaten") sp *= 2.2;
      else if (e && e.nref > 1) sp *= 1.3;          // 重用区間では速い
      gh.m.onArrive = v => { if (gh.mode === "eaten" && v === state.home) { gh.mode = "chase"; } };
      advance(gh.m, sp * dt, chooseGhost(gh));
      const q = pos(gh.m);
      if (Math.hypot(q.x - p.x, q.y - p.y) < 11) {
        if (gh.mode === "fright") {
          gh.mode = "eaten"; state.combo++; const pts = 200 * 2 ** (state.combo - 1); state.score += pts;
          msg(`国道${gh.ref}号をつかまえた！ +${pts}`, 1200); sfx("eat");
        } else if (gh.mode === "chase") {
          state.lives--; player.dead = 1.6; sfx("die");
          msg(state.lives > 0 ? `国道${gh.ref}号につかまった…` : "", 1500);
          return;
        }
      }
    }
    // クリア
    if (!dots.some(d => d.alive) && !power.some(pw => pw.alive)) {
      state.stage++; state.score += 1000; sfx("clear");
      msg(`ステージクリア！ +1000`, 1500);
      newStage(false);
    }
    if (state.score > state.hi) { state.hi = state.score; try { localStorage.setItem(hiKey, state.hi); } catch (e) {} }
    document.getElementById("pacScore").textContent = `スコア ${state.score}　最高 ${state.hi}　ステージ ${state.stage}`;
    document.getElementById("pacLives").textContent = "●".repeat(Math.max(0, state.lives));
  }
  function gameOver() {
    paused = true;
    msg(`ゲームオーバー　スコア ${state.score}`, 0);
    const m = document.getElementById("pacMsg");
    m.innerHTML += `<div class="pacBtns"><button id="pacRetry">もう一度</button><button id="pacExit">地図に戻る</button></div>`;
  }

  // ---------- 描画 ----------
  const ROAD_COLOR = e => e.cls === "kosoku" ? "#9aa5b8" : e.cls === "kokudo" || e.cls === "senyo"
    ? ["#4c8dff", "#ff9d3b", "#ff5c5c", "#c77dff"][Math.min(e.nref, 4) - 1] : e.cls === "shuyo" ? "#3fbf7f" : "#d9a521";
  function draw(time) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "rgba(8,12,28,0.86)"; g.fillRect(0, 0, W, H);
    // 道路（迷路の通路）
    g.lineCap = "round"; g.lineJoin = "round";
    for (const pass of [0, 1]) {
      for (const e of graph.edges) {
        const a = graph.nodes[e.a], b = graph.nodes[e.b];
        if (!a.on) continue;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
        if (pass === 0) { g.strokeStyle = ROAD_COLOR(e); g.globalAlpha = 0.28; g.lineWidth = e.cls === "kokudo" || e.cls === "kosoku" ? 13 : 10; }
        else { g.strokeStyle = ROAD_COLOR(e); g.globalAlpha = 0.9; g.lineWidth = 2; }
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    // エサ
    g.fillStyle = "#ffe8a3";
    for (const d of dots) if (d.alive) { g.beginPath(); g.arc(d.x, d.y, 2.2, 0, 7); g.fill(); }
    // パワーエサ（施設）
    const blink = Math.sin(time * 6) > -0.3;
    for (const pw of power) {
      if (!pw.alive || !blink) continue;
      const n = graph.nodes[pw.node];
      const bg = pw.label === "駅" ? "#d9480f" : pw.label === "★" ? "#f8f9fa" : "#ffd43b";
      g.fillStyle = bg; g.strokeStyle = "#fff"; g.lineWidth = 1.5;
      g.beginPath(); g.roundRect(n.x - 9, n.y - 8, 18, 16, 3); g.fill(); g.stroke();
      g.fillStyle = pw.label === "駅" ? "#fff" : "#1d2433"; g.font = "bold 9px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(pw.label, n.x, n.y + 0.5);
    }
    // お化け（国道の標識）
    for (const gh of ghosts) drawGhost(gh, time);
    // 自機
    drawPlayer();
  }
  function drawGhost(gh, time) {
    const q = pos(gh.m);
    const fr = gh.mode === "fright", eaten = gh.mode === "eaten";
    const flash = fr && state.frightT < 2 && Math.sin(time * 18) > 0;
    const w = 24, h = 26, x = q.x - w / 2, y = q.y - h / 2 - 3;
    if (!eaten) {
      // 国道標識（逆おにぎり）の形。signShape は y=0 から描くので位置をずらす
      g.save(); g.translate(0, y); signShape(g, "shield", x, w, h); g.restore();
      g.fillStyle = fr ? (flash ? "#f8f9fa" : "#3b5bdb") : gh.color; g.fill();
      g.lineWidth = 1.5; g.strokeStyle = "#fff"; g.stroke();
      g.fillStyle = flash ? "#3b5bdb" : "#fff"; g.font = "bold 8px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(fr ? "〜" : gh.ref, q.x, y + h * 0.56);
    }
    // 目
    const dx = gh.m.dir.x * 1.5, dy = gh.m.dir.y * 1.5;
    for (const ex of [-3.5, 3.5]) {
      g.fillStyle = "#fff"; g.beginPath(); g.arc(q.x + ex, y + 6, 2.6, 0, 7); g.fill();
      g.fillStyle = "#1d2433"; g.beginPath(); g.arc(q.x + ex + dx, y + 6 + dy, 1.3, 0, 7); g.fill();
    }
  }
  function drawPlayer() {
    const p = pos(player.m);
    const ang = Math.atan2(player.m.dir.y, player.m.dir.x);
    let open = (Math.sin(player.mouth) + 1) * 0.28 + 0.05;
    let r = 8;
    if (player.dead > 0) { open = Math.min(Math.PI * 0.98, (1.6 - player.dead) * 2.2); r = 8 * Math.max(0.2, player.dead / 1.6); }
    g.fillStyle = "#ffd43b";
    g.beginPath(); g.moveTo(p.x, p.y); g.arc(p.x, p.y, r, ang + open, ang + Math.PI * 2 - open); g.closePath(); g.fill();
  }
  let msgT = 0;
  function msg(text, ms) {
    const m = document.getElementById("pacMsg");
    if (!m) return;
    m.textContent = text; m.style.opacity = text ? 1 : 0;
    clearTimeout(msgT);
    if (ms) msgT = setTimeout(() => { m.style.opacity = 0; }, ms);
  }

  // ---------- 操作 ----------
  let touch0 = null;
  const setDir = (x, y) => { const l = Math.hypot(x, y) || 1; input = { x: x / l, y: y / l }; };
  function onKey(e) {
    const k = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] }[e.key];
    if (k) { setDir(...k); e.preventDefault(); }
    if (e.key === "Escape") stop();
    if (e.key === " " || e.key === "p") { paused = !paused; e.preventDefault(); }
  }
  function onDown(e) { touch0 = { x: e.clientX, y: e.clientY }; e.preventDefault(); }
  function onMove(e) {
    if (!touch0) return;
    const dx = e.clientX - touch0.x, dy = e.clientY - touch0.y;
    if (Math.hypot(dx, dy) > 18) { setDir(dx, dy); touch0 = { x: e.clientX, y: e.clientY }; }
    e.preventDefault();
  }
  function onUp() { touch0 = null; }
  function onClick(e) {
    if (e.target.id === "pacQuit" || e.target.id === "pacExit") stop();
    if (e.target.id === "pacPause") { paused = !paused; e.target.textContent = paused ? "▶" : "⏸"; msg(paused ? "一時停止中" : "", 0); }
    if (e.target.id === "pacRetry") { stop(); setTimeout(start, 50); }
  }
  function bindInput(on) {
    const f = on ? "addEventListener" : "removeEventListener";
    window[f]("keydown", onKey);
    document[f]("click", onClick);
    if (cv) { cv[f]("pointerdown", onDown); cv[f]("pointermove", onMove); cv[f]("pointerup", onUp); cv[f]("pointercancel", onUp); }
    window[f]("resize", onResize);
  }
  function onResize() { if (running) { stop(); alert("画面の大きさが変わったので終了しました"); } }

  // ---------- 効果音 ----------
  let ac = null, lastDot = 0;
  function sfx(kind) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const now = ac.currentTime;
      if (kind === "dot") { if (now - lastDot < 0.07) return; lastDot = now; }
      const seq = { dot: [[660, 0.04]], power: [[300, 0.08], [450, 0.08], [600, 0.12]], eat: [[900, 0.06], [1200, 0.1]],
        die: [[500, 0.12], [400, 0.12], [300, 0.12], [200, 0.25]], clear: [[523, 0.1], [659, 0.1], [784, 0.1], [1046, 0.2]] }[kind];
      let t = now;
      for (const [f, d] of seq) {
        const o = ac.createOscillator(), v = ac.createGain();
        o.type = kind === "dot" ? "square" : "triangle"; o.frequency.value = f;
        v.gain.setValueAtTime(kind === "dot" ? 0.03 : 0.08, t); v.gain.exponentialRampToValueAtTime(0.001, t + d);
        o.connect(v).connect(ac.destination); o.start(t); o.stop(t + d); t += d;
      }
    } catch (e) {}
  }

  return { start, stop, _test: { buildGraph: () => graph } };
})();

document.getElementById("pacStart").addEventListener("click", () => Pac.start());
