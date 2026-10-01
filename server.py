"""Serves web/ and Cesium, and proxies /exec to QuestDB (QuestDB sends no CORS headers)."""
import os, urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
QDB = os.environ.get("QDB_HTTP", "http://localhost:9000")
PORT = int(os.environ.get("PORT", "8080"))


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        if path.startswith("/cesium/"):
            return str(ROOT / "node_modules/cesium/Build/Cesium" / path[len("/cesium/"):].split("?")[0])
        return super().translate_path(path)

    def do_GET(self):
        if not self.path.startswith("/exec"):
            return super().do_GET()
        try:
            with urllib.request.urlopen(QDB + self.path, timeout=10) as r:
                status, body = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read()
        except OSError as e:
            status, body = 502, f'{{"error":"questdb unreachable: {e}"}}'.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"http://localhost:{PORT}")
    ThreadingHTTPServer(("", PORT), partial(Handler, directory=str(ROOT / "web"))).serve_forever()
