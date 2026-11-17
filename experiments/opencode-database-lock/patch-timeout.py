"""Diagnostic binary copy only; never replace an installed executable."""
import os
import pathlib
import sys

source, target = map(pathlib.Path, sys.argv[1:3])
assert source.resolve() != target.resolve(), "Refuse to overwrite the source"
before = b't.run("PRAGMA journal_mode = WAL;");return t'
after = b't.run("PRAGMA busy_timeout=5000; ");return t'
data = source.read_bytes()
assert len(before) == len(after) and data.count(before) == 1
with target.open("xb") as output:
    output.write(data.replace(before, after))
os.chmod(target, 0o700)
