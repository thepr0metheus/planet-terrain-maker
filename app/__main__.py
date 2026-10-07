"""python -m app: the server, on APP_HOST:APP_PORT, with its data in APP_DATA."""
import os
from pathlib import Path

from .server import create_app, log, version


def main():
    host = os.environ.get("APP_HOST", "127.0.0.1")
    port = int(os.environ.get("APP_PORT", "15002"))
    data = Path(os.environ.get("APP_DATA", Path(__file__).resolve().parent.parent / "data"))
    data.mkdir(parents=True, exist_ok=True)
    app = create_app(data, opentopo_key=os.environ.get("OPENTOPO_KEY") or None)
    log(f"Planet Terrain Maker {version() or 'working copy'} on http://{host}:{port}/, data in {data}")
    app.run(host=host, port=port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
