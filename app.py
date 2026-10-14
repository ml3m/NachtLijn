from __future__ import annotations

import json
from pathlib import Path

from flask import Flask, render_template

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"

app = Flask(__name__)


def _load_json(path: Path):
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


@app.route("/")
def index():
    stations = _load_json(DATA_DIR / "stations.json")
    tracks = _load_json(DATA_DIR / "tracks.geojson")
    return render_template("index.html", stations=stations, tracks=tracks)


if __name__ == "__main__":
    app.run()
