"""Read-only observer for this experiment's disposable, synthetic CLI databases."""
import base64
import json
import pathlib
import sqlite3
import sys
import time

root = pathlib.Path(sys.argv[1]).resolve()
stop = pathlib.Path(sys.argv[2])
seen = {}
schemas = set()

def cell(value):
    return {"base64": base64.b64encode(value).decode()} if isinstance(value, bytes) else value

def emit(value):
    print(json.dumps({"observedEpochMs": time.time_ns() / 1_000_000, **value}), flush=True)

while not stop.exists():
    for file in root.rglob("*.db"):
        rel = str(file.relative_to(root))
        try:
            with sqlite3.connect(file.as_uri() + "?mode=ro", uri=True, timeout=0.01) as db:
                db.execute("PRAGMA query_only = ON")
                for table, sql in db.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table'"):
                    if (rel, table) not in schemas:
                        schemas.add((rel, table))
                        emit({"kind": "schema", "file": rel, "table": table, "sql": sql})
                    cursor = db.execute('SELECT * FROM "' + table.replace('"', '""') + '"')
                    columns = [entry[0] for entry in cursor.description]
                    for index, row in enumerate(cursor):
                        values = dict(zip(columns, map(cell, row)))
                        key = (rel, table, index)
                        serialized = json.dumps(values, sort_keys=True)
                        if seen.get(key) != serialized:
                            seen[key] = serialized
                            emit({"kind": "row", "file": rel, "table": table, "rowIndex": index, "values": values})
        except sqlite3.Error as error:
            key = (rel, "error")
            if seen.get(key) != str(error):
                seen[key] = str(error)
                emit({"kind": "read_error", "file": rel, "message": str(error)})
    time.sleep(0.01)
