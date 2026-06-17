#!/usr/bin/env python3
"""Backend for the floor-plan viewer.

Serves the static viewer AND the API endpoints the client calls:
  • GET  /api/floorplan-scad — returns the on-disk floorplan.scad (the SOURCE OF
    TRUTH). Its header comment carries the embedded editable state; the client
    restores from it on load.
  • POST /api/save-scad      — overwrites floorplan.scad in THIS directory (the dir
    the server runs from) with the client's current model (state header + geometry).
    This is the AUTO-SAVE target — the client writes on every edit (debounced).
  • POST /api/render         — starts a Blender render JOB of the live model from
    the client's camera and returns {jobId} immediately (async).
  • GET  /api/render-status  — live progress for a job: {progress, label, done,…}.
    Blender (tools/blender_render.py) emits "@P a b secs label" phase markers; the
    server interpolates the bar across the long blocking steps (bake, render).
  • GET  /api/render-result  — the finished PNG for a job.

Stdlib only — no pip installs. Run via ./serve.sh  (or: python3 server.py [port]).
Blender is located via $BLENDER, then PATH, then the standard macOS app path.
"""
import base64
import json
import mimetypes
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = pathlib.Path(__file__).resolve().parent
# Serve the built React UI (dist/) when present; fall back to the project root
# (e.g. before `npm run build`). API routes are intercepted before static files,
# and floorplan.scad is still written into ROOT (the dir the server runs from).
STATIC_DIR = ROOT / "dist" if (ROOT / "dist" / "index.html").exists() else ROOT
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
# Eevee renders (incl. the irradiance-volume bake) are ~18-24s; the first render
# on a machine also compiles shaders. Generous headroom keeps it robust.
RENDER_TIMEOUT = int(os.environ.get("RENDER_TIMEOUT", "240"))   # seconds
MAX_W = 1600                                                    # cap render width
JOB_TTL = 600                                                   # seconds to keep finished jobs

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")

# ---- render jobs (id -> dict), shared across request threads ----
JOBS = {}
JOBS_LOCK = threading.Lock()
_PROG_RE = re.compile(r"^@P\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$")


def find_blender():
    candidates = [
        os.environ.get("BLENDER"),
        "blender",
        "/Applications/Blender.app/Contents/MacOS/Blender",
        "/usr/bin/blender",
        "/usr/local/bin/blender",
    ]
    for c in candidates:
        if not c:
            continue
        w = shutil.which(c)
        if w:
            return w
        if os.path.exists(c):
            return c
    return None


def _interp_pct(job):
    """Interpolate the progress bar within the current phase by elapsed time, so it
    keeps moving during long blocking steps (bake, render) that emit no sub-progress."""
    if job["done"]:
        return 100.0 if not job["error"] else job["base"]
    base, target, secs, t0 = job["base"], job["target"], max(0.2, job["secs"]), job["t0"]
    frac = min(1.0, (time.time() - t0) / secs)
    return min(float(target), base + (target - base) * frac)


def _sweep_jobs():
    now = time.time()
    with JOBS_LOCK:
        for jid in [j for j, v in JOBS.items() if now - v["created"] > JOB_TTL]:
            JOBS.pop(jid, None)


def _render_worker(jobid, blender, glb, cam, w, h, shadow_only):
    job = JOBS[jobid]
    td = tempfile.mkdtemp(prefix="kirk-render-")
    try:
        gp = os.path.join(td, "model.glb")
        op = os.path.join(td, "out.png")
        cp = os.path.join(td, "cam.json")
        with open(gp, "wb") as f:
            f.write(glb)
        with open(cp, "w") as f:
            json.dump({"camera": cam, "width": w, "height": h, "shadowOnly": shadow_only}, f)
        script = str(ROOT / "tools" / "blender_render.py")
        cmd = [blender, "-b", "--factory-startup", "--python", script, "--", gp, op, cp]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
        killer = threading.Timer(RENDER_TIMEOUT, proc.kill)
        killer.start()
        # read stdout, splitting on BOTH \r and \n (Blender uses \r for in-place updates)
        buf, logtail = b"", []
        while True:
            chunk = proc.stdout.read(512)
            if not chunk:
                break
            buf += chunk
            segs = re.split(rb"[\r\n]", buf)
            buf = segs.pop()
            for seg in segs:
                line = seg.decode("utf-8", "replace").strip()
                if not line:
                    continue
                logtail.append(line)
                if len(logtail) > 200:
                    logtail.pop(0)
                m = _PROG_RE.match(line)
                if m:
                    a, b, secs, label = int(m.group(1)), int(m.group(2)), float(m.group(3)), m.group(4)
                    with JOBS_LOCK:
                        job.update(base=float(a), target=float(b), secs=secs, t0=time.time(), label=label)
        proc.wait()
        killer.cancel()
        if os.path.exists(op):
            with open(op, "rb") as f:
                png = f.read()
            with JOBS_LOCK:
                job.update(png=png, done=True, label="Done", base=100.0, target=100.0)
        else:
            with JOBS_LOCK:
                job.update(done=True, error="Blender render produced no image",
                           log="\n".join(logtail[-40:]))
    except Exception as e:                            # noqa: BLE001 — surface to client
        with JOBS_LOCK:
            job.update(done=True, error=str(e))
    finally:
        shutil.rmtree(td, ignore_errors=True)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(STATIC_DIR), **k)

    def log_message(self, fmt, *args):           # quieter logging
        sys.stderr.write("  %s\n" % (fmt % args))

    # ---- helpers ----
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _png(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        n = int(self.headers.get("Content-Length", "0"))
        return self.rfile.read(n) if n else b""

    def _query_id(self):
        return parse_qs(urlparse(self.path).query).get("id", [""])[0]

    # ---- routing ----
    def do_GET(self):
        try:
            if self.path.startswith("/api/floorplan-scad"):
                return self._floorplan_scad()
            if self.path.startswith("/api/render-status"):
                return self._render_status()
            if self.path.startswith("/api/render-result"):
                return self._render_result()
            return super().do_GET()
        except BrokenPipeError:
            pass

    def do_POST(self):
        try:
            if self.path == "/api/save-scad":
                return self._save_scad()
            if self.path == "/api/render":
                return self._render()
            return self._json(404, {"error": "unknown endpoint " + self.path})
        except BrokenPipeError:
            pass
        except Exception as e:                    # never crash the server on one bad request
            try:
                self._json(500, {"error": str(e)})
            except Exception:
                pass

    # ---- GET /api/floorplan-scad — the on-disk source of truth (state + geometry) ----
    def _floorplan_scad(self):
        p = ROOT / "floorplan.scad"
        if not p.exists():
            return self._json(200, {"ok": True, "exists": False, "scad": ""})
        try:
            text = p.read_text()
        except Exception as e:                # noqa: BLE001 — surface to client
            return self._json(500, {"error": str(e)})
        self._json(200, {"ok": True, "exists": True, "scad": text})

    # ---- POST /api/save-scad — overwrite floorplan.scad (auto-save target) ----
    def _save_scad(self):
        data = json.loads(self._read_body() or b"{}")
        scad = data.get("scad", "")
        if not isinstance(scad, str) or not scad.strip():
            return self._json(400, {"error": "missing 'scad' text"})
        out = ROOT / "floorplan.scad"
        out.write_text(scad)
        self._json(200, {"ok": True, "path": str(out), "bytes": len(scad)})

    # ---- POST /api/render → start a job, return {jobId} ----
    def _render(self):
        blender = find_blender()
        if not blender:
            return self._json(503, {"error": "Blender not found. Set BLENDER=/path/to/blender and restart the server."})
        data = json.loads(self._read_body() or b"{}")
        try:
            glb = base64.b64decode(data["glb"])
        except Exception:
            return self._json(400, {"error": "missing/invalid 'glb' (base64)"})
        cam = data.get("camera", {})
        shadow_only = data.get("shadowOnly", []) or []
        w = int(data.get("width", 960) or 960)
        h = int(data.get("height", 640) or 640)
        if w > MAX_W:                              # cap size, preserve aspect
            h = max(1, round(h * MAX_W / w))
            w = MAX_W
        _sweep_jobs()
        jobid = uuid.uuid4().hex
        JOBS[jobid] = {"base": 0.0, "target": 6.0, "secs": 1.0, "t0": time.time(),
                       "label": "Starting Blender…", "done": False, "error": None,
                       "log": "", "png": None, "created": time.time()}
        threading.Thread(target=_render_worker, daemon=True,
                         args=(jobid, blender, glb, cam, w, h, shadow_only)).start()
        self._json(200, {"jobId": jobid})

    # ---- GET /api/render-status?id=… ----
    def _render_status(self):
        job = JOBS.get(self._query_id())
        if not job:
            return self._json(404, {"error": "unknown job"})
        with JOBS_LOCK:
            resp = {"progress": round(_interp_pct(job), 1), "label": job["label"],
                    "done": job["done"], "error": job["error"], "hasImage": job["png"] is not None}
            if job["error"]:
                resp["log"] = job.get("log", "")
        self._json(200, resp)

    # ---- GET /api/render-result?id=… ----
    def _render_result(self):
        jid = self._query_id()
        job = JOBS.get(jid)
        if not job:
            return self._json(404, {"error": "unknown job"})
        png = job.get("png")
        if png is None:
            return self._json(202, {"error": "not ready"})
        self._png(png)
        JOBS.pop(jid, None)                        # one-shot; free the memory


def main():
    os.chdir(ROOT)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    httpd.daemon_threads = True
    b = find_blender()
    print("Floor-plan viewer + render backend")
    print("  → http://127.0.0.1:%d/" % PORT)
    print("  serving from: %s%s" % (STATIC_DIR, "" if STATIC_DIR != ROOT else "  (run `npm run build` for the React UI)"))
    print("  blender:      %s" % (b or "NOT FOUND — set BLENDER=/path/to/blender for /api/render"))
    print("  (Ctrl-C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
