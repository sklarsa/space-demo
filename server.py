"""Serves web/ and Cesium, and proxies read-only SQL to QuestDB (QuestDB sends no CORS headers).

Safe to expose (e.g. behind a Cloudflare tunnel): only SELECT/WITH queries are forwarded, QuestDB's
HTTP API is read-only and only listens on localhost (start.sh), and files are only
served from web/ and Cesium's build directory.
"""
import gzip, os, re, urllib.error, urllib.parse, urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
CESIUM = (ROOT / "node_modules/cesium/Build/Cesium").resolve()
QDB = os.environ.get("QDB_HTTP", "http://localhost:9000")
HOST = os.environ.get("HOST", "127.0.0.1")  # a tunnel/reverse proxy connects locally
PORT = int(os.environ.get("PORT", "8080"))
MAX_SQL = 4000
READ_ONLY = re.compile(r"^\s*(SELECT|WITH)\b", re.I)


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        url_path = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        if url_path.startswith("/cesium/"):
            p = (CESIUM / url_path[len("/cesium/"):]).resolve()
            # resolve() collapses ../ ; anything that escapes Cesium's build dir is a 404
            return str(p) if p.is_relative_to(CESIUM) else str(CESIUM / "__not_found__")
        return super().translate_path(path)  # already confined to web/

    def list_directory(self, path):
        self.send_error(404)

    def do_GET(self):
        if urllib.parse.urlsplit(self.path).path != "/exec":
            return super().do_GET()
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        sql = params.get("query", [""])[0]
        if len(sql) > MAX_SQL or not READ_ONLY.match(sql):
            return self.reply(403, b'{"error":"read-only: SELECT queries only"}')
        upstream = {"query": sql}
        if "timings" in params:
            upstream["timings"] = "true"
        try:
            with urllib.request.urlopen(f"{QDB}/exec?{urllib.parse.urlencode(upstream)}", timeout=10) as r:
                status, body = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read()
        except OSError as e:
            status, body = 502, f'{{"error":"questdb unreachable: {e}"}}'.encode()
        self.reply(status, body)

    def reply(self, status, body):
        zipped = "gzip" in self.headers.get("Accept-Encoding", "")
        if zipped:
            body = gzip.compress(body, compresslevel=5)  # satellite JSON is ~1 MB/s per viewer; ~4x smaller
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if zipped:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), partial(Handler, directory=str(ROOT / "web"))).serve_forever()
