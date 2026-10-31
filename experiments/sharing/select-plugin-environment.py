"""Select only synthetic cwd/environment observations from retained raw controls."""
import json
import pathlib
import sys


def select(row):
    required = ("runtime", "version", "platform", "arch", "scope", "placement", "errors", "processHome", "sessionCwds", "evidence", "tools")
    if any(key not in row for key in required):
        raise ValueError("Missing plugin environment evidence field")
    directories = row["sessionCwds"]
    def location(value):
        if value in directories:
            return "session_" + "AB"[directories.index(value)]
        if value == row["processHome"]:
            return "process_HOME"
        return value
    hooks = row["evidence"].get("hooks", [])
    if not hooks or len(directories) != 2 or len(row["tools"]) != 2:
        raise ValueError("Missing actual hook/tool executions")
    return {**{key: row[key] for key in required[:7]}, "hooks": [
        {"revision": hook["revision"], "pluginCwd": location(hook["cwd"]), "pluginLocation": location(hook["location"]),
         "environmentMarker": hook["environmentMarker"], "childCwd": location(hook["child"]["cwd"]), "childEnvironmentMarker": hook["child"]["environmentMarker"]}
        for hook in hooks], "tools": [{**tool, "cwd": location(tool["cwd"])} for tool in row["tools"]]}


if __name__ == "__main__":
    root = pathlib.Path(sys.argv[1])
    rows = []
    for version in ("2.2.3", "2.2.5"):
        for scope in ("user", "project"):
            for placement in ("shared", "isolated"):
                source = root / f"opencode-hook-cwd-{version}" / f"{scope}-{placement}.json"
                rows.append(select(json.loads(source.read_text())))
    print(json.dumps(rows, indent=2) + "\n", end="")
