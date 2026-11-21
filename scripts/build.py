#!/usr/bin/env python3
"""Build a plain webOS IPK offline; no npm dependencies or signing required.

Uses the same ar + control/data tar layout as ares-package. For official CLI
packaging instead: ares-package --no-minify --outdir dist app
"""
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import time

ROOT = Path(__file__).resolve().parents[1]


def archive(files, timestamp=None):
    # webOS 5.x treats tar's epoch-zero timestamp warnings as verification
    # failures. TarInfo defaults to zero, so stamp files AND directories.
    timestamp = int(time.time()) if timestamp is None else timestamp
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        directories = set()
        for name in files:
            directories.update(str(p) for p in Path(name).parents if str(p) != ".")
        for name in sorted(directories):
            info = tarfile.TarInfo("./" + name)
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            info.mtime = timestamp
            tar.addfile(info)
        for name, payload in sorted(files.items()):
            info = tarfile.TarInfo("./" + name)
            info.size = len(payload)
            info.mode = 0o644
            info.mtime = timestamp
            tar.addfile(info, io.BytesIO(payload))
    return gzip.compress(raw.getvalue(), mtime=timestamp)


def build():
    timestamp = int(time.time())
    app = ROOT / "app"
    info = json.loads((app / "appinfo.json").read_text())
    app_id, version = info["id"], info["version"]
    files = {"usr/palm/applications/%s/%s" % (app_id, p.relative_to(app)): p.read_bytes()
             for p in sorted(app.rglob("*")) if p.is_file()}
    package = {"id": app_id, "version": version, "app": app_id}
    files["usr/palm/packages/%s/packageinfo.json" % app_id] = json.dumps(package).encode()
    control = ("Package: %s\nVersion: %s\nSection: misc\nPriority: optional\nArchitecture: all\n"
               "Installed-Size: %d\nMaintainer: Local\nDescription: Yamtrack TV LAN launcher\n"
               "webOS-Package-Format-Version: 2\nwebOS-Packager-Version: yamtrack-tv-offline-0.1\n"
               % (app_id, version, sum(map(len, files.values())))).encode()
    members = {"debian-binary": b"2.0\n", "control.tar.gz": archive({"control": control}, timestamp),
               "data.tar.gz": archive(files, timestamp)}
    output = bytearray(b"!<arch>\n")
    for name, payload in members.items():
        output.extend(("%-16s%-12s%-6s%-6s%-8s%-10s`\n" % (name+"/", str(timestamp), "0", "0", "100644", str(len(payload)))).encode())
        output.extend(payload)
        if len(payload) % 2:
            output.extend(b"\n")
    destination = ROOT / "dist" / ("%s_%s_all.ipk" % (app_id, version))
    destination.parent.mkdir(exist_ok=True)
    destination.write_bytes(output)
    destination.with_suffix(".ipk.sha256").write_text(hashlib.sha256(output).hexdigest() + "  " + destination.name + "\n")
    print(destination)
    return destination


def bundle(package):
    version = json.loads((ROOT / "app/appinfo.json").read_text())["version"]
    destination = ROOT / "dist" / ("yamtrack-tv-%s.tgz" % version)
    paths = [ROOT / name for name in ("README.md", "compose.yaml", "Dockerfile", "requirements.txt", ".dockerignore", ".gitignore")]
    for directory in ("helper", "app", "scripts", "tests"):
        paths.extend(p for p in (ROOT / directory).rglob("*") if p.is_file() and "__pycache__" not in p.parts)
    paths.extend((package, package.with_suffix(".ipk.sha256")))
    with tarfile.open(destination, "w:gz", format=tarfile.USTAR_FORMAT) as output:
        for path in paths:
            output.add(path, arcname="WebOS_Yamtrack/" + str(path.relative_to(ROOT)))
    print(destination)


if __name__ == "__main__":
    bundle(build())
