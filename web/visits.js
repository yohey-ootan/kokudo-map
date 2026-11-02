// ===== 道の駅の訪問記録 =====
// 訪問日・コメント・写真を端末（IndexedDB）に保存する。サーバーには送らない。
//   visits: { id, ekiId, date: "2026-11-02", comment, created }
//   photos: { id, visitId, ekiId, blob(1600px JPEG), thumb(240px JPEG) }
"use strict";

const Visits = (() => {
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const rq = indexedDB.open("roadmap-visits", 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        const v = d.createObjectStore("visits", { keyPath: "id", autoIncrement: true });
        v.createIndex("ekiId", "ekiId");
        const p = d.createObjectStore("photos", { keyPath: "id", autoIncrement: true });
        p.createIndex("visitId", "visitId");
        p.createIndex("ekiId", "ekiId");
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return dbp;
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function tx(stores, mode, fn) {
    const t = (await db()).transaction(stores, mode);
    const out = await fn(...(Array.isArray(stores) ? stores : [stores]).map(s => t.objectStore(s)));
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
    return out;
  }
  return {
    all: () => tx("visits", "readonly", s => req(s.getAll())),
    byEki: ekiId => tx("visits", "readonly", s => req(s.index("ekiId").getAll(ekiId))),
    photosOfEki: ekiId => tx("photos", "readonly", s => req(s.index("ekiId").getAll(ekiId))),
    allPhotos: () => tx("photos", "readonly", s => req(s.getAll())),
    photo: id => tx("photos", "readonly", s => req(s.get(id))),
    async add(visit, photos) {
      return tx(["visits", "photos"], "readwrite", async (vs, ps) => {
        const id = await req(vs.add({ ...visit, created: Date.now() }));
        for (const p of photos) await req(ps.add({ ...p, visitId: id, ekiId: visit.ekiId }));
        return id;
      });
    },
    async remove(visitId) {
      return tx(["visits", "photos"], "readwrite", async (vs, ps) => {
        const keys = await req(ps.index("visitId").getAllKeys(visitId));
        for (const k of keys) await req(ps.delete(k));
        await req(vs.delete(visitId));
      });
    },
  };
})();

// 訪問済みの道の駅：ekiId -> { count, last }
let visitedMap = new Map();
let visitFilter = "all";   // all / visited / unvisited
async function refreshVisited() {
  try {
    const vs = await Visits.all();
    visitedMap = new Map();
    for (const v of vs) {
      const o = visitedMap.get(v.ekiId) || { count: 0, last: "" };
      o.count++; if (v.date > o.last) o.last = v.date;
      visitedMap.set(v.ekiId, o);
    }
  } catch (e) { console.error(e); }
  updateEki();
  renderRecordTab();
}

// 写真を縮小して保存（本体1600px・一覧用240px）
async function shrink(file, max, q) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return new Promise(res => c.toBlob(res, "image/jpeg", q));
}
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const ekiById = id => MICHI.find(d => d[0] === id);
const urls = [];   // 表示用に作った画像URL（閉じるときに解放）
const blobURL = b => { const u = URL.createObjectURL(b); urls.push(u); return u; };

// ---------- 記録シート（道の駅ごと） ----------
const sheet = document.createElement("div");
sheet.id = "visitSheet"; sheet.hidden = true;
document.body.appendChild(sheet);
const viewer = document.createElement("div");
viewer.id = "photoViewer"; viewer.hidden = true;
document.body.appendChild(viewer);
viewer.addEventListener("click", () => { viewer.hidden = true; viewer.innerHTML = ""; });

let sheetEki = null, pending = [];
async function openVisitSheet(ekiId) {
  const d = ekiById(ekiId);
  if (!d) return;
  sheetEki = ekiId; pending = [];
  urls.splice(0).forEach(u => URL.revokeObjectURL(u));
  const [visits, photos] = await Promise.all([Visits.byEki(ekiId), Visits.photosOfEki(ekiId)]);
  visits.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const list = visits.map(v => {
    const ph = photos.filter(p => p.visitId === v.id);
    return `<div class="vrec"><div class="vhead"><b>${esc(v.date)}</b>
        <button class="vdel" data-vdel="${v.id}" aria-label="この記録を削除">削除</button></div>` +
      (v.comment ? `<div class="vcom">${esc(v.comment).replace(/\n/g, "<br>")}</div>` : "") +
      (ph.length ? `<div class="vph">${ph.map(p => `<img src="${blobURL(p.thumb)}" data-photo="${p.id}" alt="">`).join("")}</div>` : "") +
      `</div>`;
  }).join("");
  sheet.innerHTML = `<div class="sheetbox" role="dialog" aria-label="道の駅 ${esc(d[1])} の訪問記録">
    <div class="sheettop"><h3>道の駅 ${esc(d[1])}</h3><button class="sheetclose" aria-label="閉じる">✕</button></div>
    <div class="vsum">${visits.length ? `訪問 ${visits.length}回` : "まだ訪問の記録がありません"}</div>
    <form id="vform">
      <label class="vlab">訪問日 <input type="date" name="date" value="${today()}" required></label>
      <textarea name="comment" rows="3" placeholder="コメント（買ったもの、食べたもの、感想など）"></textarea>
      <label class="vbtn">📷 写真を追加<input type="file" accept="image/*" multiple hidden id="vfile"></label>
      <div class="vph" id="vpending"></div>
      <button type="submit" class="vsave">この内容で訪問を記録</button>
    </form>
    <div class="vlist">${list}</div>
  </div>`;
  sheet.hidden = false;
}
function closeSheet() { sheet.hidden = true; sheet.innerHTML = ""; pending = []; urls.splice(0).forEach(u => URL.revokeObjectURL(u)); }
sheet.addEventListener("click", async e => {
  if (e.target === sheet || e.target.closest(".sheetclose")) return closeSheet();
  const del = e.target.closest("[data-vdel]");
  if (del && confirm("この訪問記録（写真を含む）を削除しますか？")) {
    await Visits.remove(+del.dataset.vdel);
    await refreshVisited(); openVisitSheet(sheetEki);
  }
  const img = e.target.closest("[data-photo]");
  if (img) {
    const p = await Visits.photo(+img.dataset.photo);
    if (p) { viewer.innerHTML = `<img src="${blobURL(p.blob)}" alt="">`; viewer.hidden = false; }
  }
  const pr = e.target.closest("[data-pend]");
  if (pr) { pending.splice(+pr.dataset.pend, 1); renderPending(); }
});
sheet.addEventListener("change", async e => {
  if (e.target.id !== "vfile") return;
  const files = [...e.target.files];
  e.target.value = "";
  for (const f of files) {
    try { pending.push({ blob: await shrink(f, 1600, 0.82), thumb: await shrink(f, 240, 0.7) }); }
    catch (err) { alert("写真を読み込めませんでした：" + f.name); }
  }
  renderPending();
});
function renderPending() {
  const el = document.getElementById("vpending");
  if (el) el.innerHTML = pending.map((p, i) => `<span class="pend"><img src="${blobURL(p.thumb)}" alt=""><button type="button" data-pend="${i}" aria-label="外す">✕</button></span>`).join("");
}
sheet.addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector(".vsave"); btn.disabled = true; btn.textContent = "保存中…";
  try {
    try { await navigator.storage.persist(); } catch (err) {}
    await Visits.add({ ekiId: sheetEki, date: f.date.value || today(), comment: f.comment.value.trim() }, pending);
    await refreshVisited(); openVisitSheet(sheetEki);
  } catch (err) {
    console.error(err); alert("保存できませんでした。端末の空き容量を確認してください。");
    btn.disabled = false; btn.textContent = "この内容で訪問を記録";
  }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });
document.addEventListener("click", e => {
  const b = e.target.closest("[data-visit]");
  if (b) { document.querySelectorAll(".maplibregl-popup").forEach(el => el.remove()); openVisitSheet(+b.dataset.visit); }
});

// ポップアップに入れる「訪問」部分
function visitPopupHTML(ekiId) {
  const v = visitedMap.get(ekiId);
  return `<div class="vpop">${v ? `<span class="vbadge">✓ 訪問 ${v.count}回</span> 最終 ${esc(v.last)}` : `<span class="vnone">未訪問</span>`}
    <button class="vopen" data-visit="${ekiId}">${v ? "記録を見る・追加" : "訪問を記録"}</button></div>`;
}

// ---------- 記録タブ ----------
function renderRecordTab() {
  const el = document.getElementById("tab-record");
  if (!el) return;
  const total = MICHI.length, n = visitedMap.size;
  const visits = [...visitedMap.values()].reduce((a, v) => a + v.count, 0);
  const rows = [...visitedMap.entries()].sort((a, b) => b[1].last.localeCompare(a[1].last)).map(([id, v]) => {
    const d = ekiById(id);
    return d ? `<button class="rrow" data-goto="${id}"><span>${esc(d[1])}</span><small>${v.count}回・${esc(v.last)}</small></button>` : "";
  }).join("");
  el.innerHTML = `
    <div class="rsum"><b>${n}</b> / ${total} 駅 <small>（${(n / total * 100).toFixed(1)}%・のべ${visits}回）</small></div>
    <div class="rbar"><i style="width:${n / total * 100}%"></i></div>
    <div class="vfilter">地図に表示：
      ${[["all", "すべて"], ["visited", "訪問済み"], ["unvisited", "未訪問"]].map(([k, t]) =>
        `<label><input type="radio" name="vf" value="${k}"${visitFilter === k ? " checked" : ""}>${t}</label>`).join("")}
    </div>
    <div class="rlist">${rows || `<div class="empty">地図の道の駅をタップして「訪問を記録」から始められます</div>`}</div>
    <h3>バックアップ</h3>
    <div class="offinfo">記録と写真はこの端末の中だけに保存されています。機種変更や削除に備えて書き出しておけます。</div>
    <button class="btn" id="vexport">記録を書き出す（写真つき）</button>
    <label class="btn" style="display:block;text-align:center;box-sizing:border-box">書き出したファイルを読み込む<input type="file" accept=".json,application/json" hidden id="vimport"></label>`;
}
document.addEventListener("change", e => {
  if (e.target.name === "vf") { visitFilter = e.target.value; updateEki(); }
});
document.addEventListener("click", e => {
  const g = e.target.closest("[data-goto]");
  if (g) {
    const d = ekiById(+g.dataset.goto);
    if (d) { map.flyTo({ center: [d[3], d[2]], zoom: Math.max(map.getZoom(), 12) }); openVisitSheet(d[0]); }
  }
});

// ---------- バックアップ ----------
const b64 = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
const unb64 = (s, type) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };
document.addEventListener("click", async e => {
  if (!e.target.closest("#vexport")) return;
  const btn = e.target.closest("#vexport"); btn.textContent = "書き出し中…";
  try {
    const visits = await Visits.all(), photos = await Visits.allPhotos();
    const data = { app: "road-map-visits", version: 1, exported: new Date().toISOString(),
      visits: visits.map(v => ({ ...v, ekiName: (ekiById(v.ekiId) || [])[1] || "" })),
      photos: await Promise.all(photos.map(async p => ({ visitId: p.visitId, ekiId: p.ekiId, jpg: await b64(p.blob), thumb: await b64(p.thumb) }))) };
    const name = `道の駅訪問記録-${today()}.json`;
    const json = JSON.stringify(data);
    const P = window.Capacitor && window.Capacitor.Plugins;
    if (IS_APP && P && P.Filesystem && P.Share) {
      // アプリ：ファイルを作って「共有」から Google ドライブ等に保存
      const r = await P.Filesystem.writeFile({ path: name, data: json, directory: "CACHE", encoding: "utf8" });
      await P.Share.share({ title: "道の駅の訪問記録", files: [r.uri] });
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" })); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    btn.textContent = "書き出しました";
  } catch (err) { console.error(err); btn.textContent = "書き出せませんでした"; }
  setTimeout(() => { btn.textContent = "記録を書き出す（写真つき）"; }, 3000);
});
document.addEventListener("change", async e => {
  if (e.target.id !== "vimport" || !e.target.files[0]) return;
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (data.app !== "road-map-visits") throw new Error("形式が違います");
    // 同じ道の駅・同じ日・同じコメントの記録はすでにあれば飛ばす
    const have = new Set((await Visits.all()).map(v => `${v.ekiId}|${v.date}|${v.comment}`));
    let added = 0;
    for (const v of data.visits) {
      if (have.has(`${v.ekiId}|${v.date}|${v.comment}`)) continue;
      const ph = data.photos.filter(p => p.visitId === v.id).map(p => ({ blob: unb64(p.jpg, "image/jpeg"), thumb: unb64(p.thumb, "image/jpeg") }));
      await Visits.add({ ekiId: v.ekiId, date: v.date, comment: v.comment || "" }, ph);
      added++;
    }
    await refreshVisited();
    alert(`${added}件の記録を読み込みました`);
  } catch (err) { alert("読み込めませんでした：" + err.message); }
  e.target.value = "";
});

refreshVisited();
