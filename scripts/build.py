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