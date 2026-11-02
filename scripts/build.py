#!/usr/bin/env python3
"""
日本のOpenStreetMapデータ（osmiumで道路まわりだけに絞ったもの）から、
地図タイル（tippecanoe）用の GeoJSONSeq と、検索用の索引 index.json を作る。

  python3 build.py filtered.osm.pbf out/roads.geojsonl out/index.json

事前に計算しておくもの
  - 道路の種別（高速 / 自動車専用 / 国道 / 主要地方道 / 一般県道）
  - 国道・都道府県道の番号と重用区間（路線データ route=road の relation から）
  - 都道府県道がどの都道府県のものか（都道府県の境界から）
  - 国道の起点・終点、重用区間の端
  - SA・PA と、その敷地内にある設備
"""
import array
import datetime
import json
import re
import sys
from collections import defaultdict

CLASS_OF = {"motorway": "kosoku", "trunk": "kokudo", "primary": "shuyo", "secondary": "ippan"}
MINZOOM = {"kosoku": 5, "kokudo": 5, "senyo": 6, "shuyo": 8, "ippan": 10}
# 「千葉県道22号…」のような路線名から都道府県名を取り出す
PREF_RE = re.compile(r"^(北海道|東京都|京都府|大阪府|[^\s\d]{2,3}県)道")
# SA・PAの設備（Webアプリ側の REST_FAC と同じ順番）
REST_FAC = [
    lambda t: t.get("amenity") == "fuel",
    lambda t: t.get("amenity") == "charging_station",
    lambda t: t.get("amenity") in ("restaurant", "food_court"),
    lambda t: t.get("amenity") in ("fast_food", "cafe"),
    lambda t: t.get("shop") == "convenience",
    lambda t: bool(t.get("shop")) and t.get("shop") != "convenience",
    lambda t: t.get("amenity") == "toilets",
    lambda t: t.get("amenity") == "atm",
    lambda t: t.get("amenity") == "shower",
    lambda t: t.get("tourism") == "information",
]
AMENITY_KEYS = ("amenity", "shop", "tourism")
NET_PREF = {"hokkaido": "北海道", "aomori": "青森県", "iwate": "岩手県", "miyagi": "宮城県", "akita": "秋田県", "yamagata": "山形県", "fukushima": "福島県", "ibaraki": "茨城県", "tochigi": "栃木県", "gunma": "群馬県", "saitama": "埼玉県", "chiba": "千葉県", "tokyo": "東京都", "kanagawa": "神奈川県", "niigata": "新潟県", "toyama": "富山県", "ishikawa": "石川県", "fukui": "福井県", "yamanashi": "山梨県", "nagano": "長野県", "gifu": "岐阜県", "shizuoka": "静岡県", "aichi": "愛知県", "mie": "三重県", "shiga": "滋賀県", "kyoto": "京都府", "osaka": "大阪府", "hyogo": "兵庫県", "nara": "奈良県", "wakayama": "和歌山県", "tottori": "鳥取県", "shimane": "島根県", "okayama": "岡山県", "hiroshima": "広島県", "yamaguchi": "山口県", "tokushima": "徳島県", "kagawa": "香川県", "ehime": "愛媛県", "kochi": "高知県", "fukuoka": "福岡県", "saga": "佐賀県", "nagasaki": "長崎県", "kumamoto": "熊本県", "oita": "大分県", "miyazaki": "宮崎県", "kagoshima": "鹿児島県", "okinawa": "沖縄県"}
SCALE = 1e7   # 座標は osmium と同じく 1e7 倍の整数で持つ（メモリ節約）


def split_refs(v):
    return [r.strip() for r in (v or "").replace(" ", "").split(";") if r.strip()]


def num_key(r):
    d = re.sub(r"\D", "", r)
    return (int(d) if d else 9999, r)


# ---------------------------------------------------------------- 都道府県の判定
class Region:
    """多角形（穴あり可）。緯度の帯ごとに辺を仕分けて、点の内外判定を速くする"""
    BAND = 0.01

    def __init__(self, name, rings):
        self.name = name
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))
        self.bands = defaultdict(list)
        for ring in rings:
            for i in range(len(ring)):
                x1, y1 = ring[i - 1]
                x2, y2 = ring[i]
                if y1 == y2:
                    continue
                lo, hi = min(y1, y2), max(y1, y2)
                for b in range(int(lo / self.BAND), int(hi / self.BAND) + 1):
                    self.bands[b].append((x1, y1, x2, y2))

    def contains(self, x, y):
        bx0, by0, bx1, by1 = self.bbox
        if not (bx0 <= x <= bx1 and by0 <= y <= by1):
            return False
        inside = False
        for x1, y1, x2, y2 in self.bands.get(int(y / self.BAND), ()):
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                inside = not inside
        return inside


class PrefLookup:
    def __init__(self, regions):
        self.regions = regions
        self.cache = {}

    def find(self, x, y):
        k = (round(x, 3), round(y, 3))   # 約100m単位で結果を使い回す
        if k not in self.cache:
            self.cache[k] = next((r.name for r in self.regions if r.contains(x, y)), None)
        return self.cache[k]


# ---------------------------------------------------------------- 集めたデータ
class Data:
    def __init__(self):
        self.rel_nat = defaultdict(set)    # way id -> {国道番号}
        self.rel_pref = defaultdict(set)   # way id -> {(都道府県名 or None, 番号)}
        self.ways = []                     # 道路
        self.regions = []                  # 都道府県の境界
        self.rests = []                    # SA・PA
        self.amenities = []                # SA・PAの中にあるかもしれない設備

    # relation（路線）
    def add_route(self, tags, member_way_ids):
        net = tags.get("network", "")
        # ref が無い路線は、名前の「大阪府道28号」「国道1号」から番号を読む
        ref = tags.get("ref")
        if not ref:
            m = re.search(r"道(\d+)号", tags.get("name", ""))
            ref = m.group(1) if m else None
        if tags.get("route") != "road" or not ref:
            return
        if net.startswith("JP:national"):
            for wid in member_way_ids:
                self.rel_nat[wid].update(split_refs(ref))
        elif net.startswith("JP:prefectural"):
            # 都道府県名：① network の地域名（JP:prefectural:tokyo）② 路線名 ③ 無ければ後で境界から判定
            nm = re.match(r"JP:prefectural:([a-z]+)", net)
            m = PREF_RE.match(tags.get("name", ""))
            pref = NET_PREF.get(nm.group(1)) if nm else None
            pref = pref or (m.group(1) if m else None)
            for wid in member_way_ids:
                for r in split_refs(ref):
                    self.rel_pref[wid].add((pref, r))

    def add_road(self, wid, tags, xy, node_ids):
        cls = CLASS_OF.get(tags.get("highway"))
        if not cls or len(xy) < 4:
            return
        if cls == "kokudo" and tags.get("motorroad") == "yes":
            cls = "senyo"
        self.ways.append({
            "id": wid, "cls": cls, "refs": sorted(set(split_refs(tags.get("ref"))), key=num_key),
            "name": tags.get("name", ""), "official": tags.get("official_name", ""),
            "alt": tags.get("alt_name") or tags.get("old_name") or "",
            "xy": array.array("i", xy), "ends": (node_ids[0], node_ids[-1]),
        })


# ---------------------------------------------------------------- 計算
def effective(w, data, prefs):
    """Webアプリの effective() と同じ考え方で、表示する種別と番号を決める"""
    wid, cls = w["id"], w["cls"]
    tag_nat = [r for r in w["refs"] if r.isdigit()]
    nat = sorted(data.rel_nat.get(wid) or (tag_nat if cls in ("kokudo", "senyo") else []), key=num_key)
    pref_pairs = data.rel_pref.get(wid)
    if not pref_pairs and cls in ("shuyo", "ippan"):
        pref_pairs = {(None, r) for r in w["refs"]}
    pref_pairs = pref_pairs or set()
    if cls in ("shuyo", "ippan") and nat:
        cls = "kokudo"   # 県道扱いの道でも国道路線に属していれば国道
    # 県名が分からない都道府県道は、道の中ほどの位置から判定
    pref = []
    mid = None
    for p, r in sorted(pref_pairs, key=lambda x: num_key(x[1])):
        if p is None:
            if mid is None:
                xy = w["xy"]
                i = (len(xy) // 4) * 2
                mid = prefs.find(xy[i] / SCALE, xy[i + 1] / SCALE) or "不明"
            p = mid
        pref.append((p, r))
    expr = [r for r in w["refs"] if re.match(r"^[A-Za-z]", r)]
    if cls == "kosoku":
        refs = expr or w["refs"]
    elif cls in ("kokudo", "senyo"):
        refs = nat
    else:
        refs = [r for _, r in pref]
    keys = ["国道:" + r for r in nat] + [f"都道府県道:{p} {r}" for p, r in pref]
    if cls == "kosoku":
        keys += ["高速道路:" + r for r in w["refs"]]
    for nm in [w["name"], w["official"]] + w["alt"].split(";"):
        if nm.strip():
            keys.append("通り名:" + nm.strip())
    return cls, refs, pref, list(dict.fromkeys(keys))


def pk_of(name):
    if not name or name == "不明":
        return ""
    return {"都": "T", "道": "D", "府": "F", "県": "K"}.get(name[-1], "")


def coords(xy):
    return [[round(xy[i] / SCALE, 6), round(xy[i + 1] / SCALE, 6)] for i in range(0, len(xy), 2)]


def build(data, out_roads, out_index):
    prefs = PrefLookup(data.regions)
    index = defaultdict(dict)

    def grow(key, xy):
        g, k = key.split(":", 1)
        xs, ys = xy[0::2], xy[1::2]
        b = [min(xs) / SCALE, min(ys) / SCALE, max(xs) / SCALE, max(ys) / SCALE]
        old = index[g].get(k)
        index[g][k] = b if not old else [min(old[0], b[0]), min(old[1], b[1]), max(old[2], b[2]), max(old[3], b[3])]

    node_ways = defaultdict(list)   # 端のノード -> [(番号の組, 種別, 座標)]
    n_out = 0
    with open(out_roads, "w", encoding="utf-8") as f:
        for w in data.ways:
            cls, refs, pref, keys = effective(w, data, prefs)
            for k in keys:
                grow(k, w["xy"])
            props = {
                "cls": cls, "ref": ";".join(refs), "nref": len(refs), "label": " · ".join(refs),
                "rank": num_key(refs[0])[0] if refs else 9999,
                "name": w["name"], "official": w["official"], "alt": w["alt"],
                "pref": ";".join(f"{p} {r}" for p, r in pref) if cls == "kokudo" else "",
                # 都道府県道の都道府県名と、都道（T）・道道（D）・府道（F）・県道（K）の区別
                "prefname": pref[0][0] if pref and pref[0][0] != "不明" else "",
                "pk": pk_of(pref[0][0]) if pref else "",
                "keys": "|" + "|".join(keys) + "|",
            }
            f.write(json.dumps({"type": "Feature", "tippecanoe": {"layer": "roads", "minzoom": MINZOOM[cls]},
                                "properties": props,
                                "geometry": {"type": "LineString", "coordinates": coords(w["xy"])}},
                               ensure_ascii=False, separators=(",", ":")) + "\n")
            n_out += 1
            xy = w["xy"]
            for k, nid in enumerate(w["ends"]):
                pt = (xy[0], xy[1]) if k == 0 else (xy[-2], xy[-1])
                node_ways[nid].append((tuple(refs), cls, pt))

        points = 0
        # 重用区間の端：同じ番号を含む道路どうしで、番号の組み合わせが変わる地点
        seen = set()
        ends = {}
        for lst in node_ways.values():
            ov = next((x for x in lst if len(x[0]) > 1 and x[1] in ("kokudo", "senyo")), None)
            if ov and any(x[0] and x[0] != ov[0] and set(x[0]) & set(ov[0]) for x in lst):
                k = (round(ov[2][0] / SCALE, 4), round(ov[2][1] / SCALE, 4))
                if k not in seen:
                    seen.add(k)
                    f.write(point_feature(ov[2], {"kind": "ov"}, 11))
                    points += 1
            # 国道の起点・終点：ある番号の道路がその点で1本しか接していない
            count = defaultdict(int)
            for refs, cls, _ in lst:
                if cls in ("kokudo", "senyo"):
                    for r in refs:
                        count[r] += 1
            end_refs = [r for r, c in count.items() if c == 1]
            if end_refs:
                pt = lst[0][2]
                k = (round(pt[0] / SCALE / 0.002), round(pt[1] / SCALE / 0.002))   # 約200m単位でまとめる
                ends.setdefault(k, (pt, set()))[1].update(end_refs)
        for pt, refs in ends.values():
            f.write(point_feature(pt, {"kind": "end", "label": " · ".join(sorted(refs, key=num_key))}, 9))
            points += 1

        # SA・PAと設備
        grid = defaultdict(list)
        for x, y, t in data.amenities:
            grid[(int(x / SCALE * 100), int(y / SCALE * 100))].append((x, y, t))
        for r in data.rests:
            fac = ""
            if r["poly"]:
                ring = r["poly"]
                xs, ys = [p[0] for p in ring], [p[1] for p in ring]
                inside = []
                for gx in range(int(min(xs) / SCALE * 100), int(max(xs) / SCALE * 100) + 1):
                    for gy in range(int(min(ys) / SCALE * 100), int(max(ys) / SCALE * 100) + 1):
                        for x, y, t in grid.get((gx, gy), ()):
                            if point_in_ring(x, y, ring):
                                inside.append(t)
                fac = "".join("1" if any(fn(t) for t in inside) else "0" for fn in REST_FAC)
            f.write(point_feature((r["x"], r["y"]), {"kind": r["kind"], "name": r["name"], "fac": fac}, 8))
            points += 1

    with open(out_index, "w", encoding="utf-8") as f:
        json.dump({"built": datetime.date.today().isoformat(),
                   "groups": {g: {k: [round(v, 4) for v in b] for k, b in d.items()} for g, d in index.items()}},
                  f, ensure_ascii=False, separators=(",", ":"))
    print(f"roads: {n_out}  points: {points}  regions: {len(data.regions)}  rests: {len(data.rests)}", file=sys.stderr)


def point_in_ring(x, y, ring):
    inside = False
    for i in range(len(ring)):
        x1, y1 = ring[i - 1]
        x2, y2 = ring[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def point_feature(pt, props, minzoom):
    return json.dumps({"type": "Feature", "tippecanoe": {"layer": "points", "minzoom": minzoom},
                       "properties": props,
                       "geometry": {"type": "Point", "coordinates": [round(pt[0] / SCALE, 6), round(pt[1] / SCALE, 6)]}},
                      ensure_ascii=False, separators=(",", ":")) + "\n"


# ---------------------------------------------------------------- OSMファイルの読み込み（pyosmium）
def read_osm(path):
    import osmium

    data = Data()

    class RoutePass(osmium.SimpleHandler):
        def relation(self, r):
            if r.tags.get("route") == "road":
                data.add_route({k.k: k.v for k in r.tags}, [m.ref for m in r.members if m.type == "w"])

    class MainPass(osmium.SimpleHandler):
        def node(self, n):
            t = n.tags
            if not n.location.valid():
                return
            if t.get("highway") in ("services", "rest_area"):
                add_rest(n.id, "n", {k.k: k.v for k in t}, n.location.x, n.location.y, None)
            elif any(k in t for k in AMENITY_KEYS):
                data.amenities.append((n.location.x, n.location.y, {k: t.get(k) for k in AMENITY_KEYS if k in t}))

        def way(self, w):
            t = w.tags
            hw = t.get("highway")
            try:
                if hw in CLASS_OF:
                    xy, ids = [], []
                    for nd in w.nodes:
                        if nd.location.valid():
                            xy += (nd.location.x, nd.location.y)
                            ids.append(nd.ref)
                    if ids:
                        data.add_road(w.id, {k.k: k.v for k in t}, xy, ids)
                elif any(k in t for k in AMENITY_KEYS) and len(w.nodes) > 2:
                    pts = [(nd.location.x, nd.location.y) for nd in w.nodes if nd.location.valid()]
                    if pts:
                        data.amenities.append((sum(p[0] for p in pts) // len(pts), sum(p[1] for p in pts) // len(pts),
                                               {k: t.get(k) for k in AMENITY_KEYS if k in t}))
            except osmium.InvalidLocationError:
                pass

        def area(self, a):
            t = a.tags
            try:
                if t.get("boundary") == "administrative" and t.get("admin_level") == "4" and t.get("name"):
                    rings = []
                    for outer in a.outer_rings():
                        rings.append([(nd.lon, nd.lat) for nd in outer])
                        for inner in a.inner_rings(outer):
                            rings.append([(nd.lon, nd.lat) for nd in inner])
                    if rings:
                        data.regions.append(Region(t.get("name"), rings))
                elif t.get("highway") in ("services", "rest_area"):
                    outer = next(iter(a.outer_rings()), None)
                    if outer is not None:
                        ring = [(nd.location.x, nd.location.y) for nd in outer]
                        cx = sum(p[0] for p in ring) // len(ring)
                        cy = sum(p[1] for p in ring) // len(ring)
                        add_rest(a.orig_id(), "w" if a.from_way() else "r", {k.k: k.v for k in t}, cx, cy, ring)
            except osmium.InvalidLocationError:
                pass

    seen_rest = set()

    def add_rest(oid, typ, tags, x, y, ring):
        name = tags.get("name", "")
        if "道の駅" in name or (typ, oid) in seen_rest:
            return   # 道の駅は公式データで表示するので除外
        seen_rest.add((typ, oid))
        name = re.sub(r"(サービスエリア|パーキングエリア)$", lambda m: "SA" if m.group(0) == "サービスエリア" else "PA", name)
        data.rests.append({"kind": "SA" if tags.get("highway") == "services" else "PA",
                           "name": name, "x": x, "y": y, "poly": ring})

    print("1/2 路線データを読み込み中…", file=sys.stderr)
    RoutePass().apply_file(path)
    print("2/2 道路・境界・SA/PAを読み込み中…", file=sys.stderr)
    MainPass().apply_file(path, locations=True, idx="flex_mem")
    return data


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: build.py filtered.osm.pbf roads.geojsonl index.json")
    build(read_osm(sys.argv[1]), sys.argv[2], sys.argv[3])
