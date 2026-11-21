"""Regression coverage for the webOS 5.x epoch-zero packaging rejection."""
import contextlib
import io
import json
from pathlib import Path
import shutil
import struct
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

from scripts import build


class Package(unittest.TestCase):
    def test_tar_and_gzip_timestamps_are_plausible(self):
        payload = build.archive({"usr/palm/test.txt": b"test"})
        minimum = 946684800  # 2000-01-01; epoch-zero trips webOS 5's pkgverifier.
        maximum = int(time.time())
        self.assertGreaterEqual(struct.unpack("<I", payload[4:8])[0], minimum)
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
            for entry in archive.getmembers():
                self.assertGreaterEqual(entry.mtime, minimum, entry.name)
                self.assertLessEqual(entry.mtime, maximum, entry.name)

    def test_built_package_metadata_and_all_archive_timestamps(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copytree(build.ROOT / "app", root / "app")
            (root / "app/.DS_Store").write_bytes(b"Finder metadata")
            with patch.object(build, "ROOT", root), contextlib.redirect_stdout(io.StringIO()):
                build.build()
            info = json.loads((root / "app/appinfo.json").read_text())
            package = root / "dist" / ("%s_%s_all.ipk" % (info["id"], info["version"]))
            raw = package.read_bytes()
            self.assertEqual(raw[:8], b"!<arch>\n")
            position = 8
            members = {}
            while position < len(raw):
                header = raw[position:position+60]
                self.assertEqual(header[58:60], b"`\n")
                self.assertGreaterEqual(int(header[16:28]), 946684800)
                name = header[:16].decode().strip().rstrip("/")
                size = int(header[48:58])
                members[name] = raw[position+60:position+60+size]
                position += 60 + size + size % 2
            self.assertEqual(set(members), {"debian-binary", "control.tar.gz", "data.tar.gz"})
            for name in ("control.tar.gz", "data.tar.gz"):
                with tarfile.open(fileobj=io.BytesIO(members[name]), mode="r:gz") as archive:
                    self.assertTrue(all(entry.mtime >= 946684800 for entry in archive.getmembers()))
                    if name == "data.tar.gz":
                        base = "./usr/palm/applications/" + info["id"] + "/"
                        self.assertNotIn(base + ".DS_Store", archive.getnames())
                        manifest = json.load(archive.extractfile(base + "appinfo.json"))
                        self.assertEqual(manifest, info)
                        self.assertEqual(manifest["title"], "Yamtrack")
                        launcher = archive.extractfile(base + manifest["main"]).read()
                        self.assertIn(b'id="helper-url"', launcher)
                        self.assertNotIn(b'href="http', launcher)


if __name__ == "__main__":
    unittest.main()
