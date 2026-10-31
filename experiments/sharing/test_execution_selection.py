"""Selection must retain child differences and must not manufacture missing observations."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("execution_selection", Path(__file__).with_name("select-execution-environment.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def cohort():
    return dict(runtime="opencode", version="opencode v2.2.5", platform="linux", arch="x64",
                placement="shared", errors=[], processHome="/fixture/home", sessionCwds=["/fixture/a", "/fixture/b"],
                scope="user", evidence={"hooks": [dict(revision="A", cwd="/fixture/home", location="/fixture/a",
                environmentMarker="fixture", child=dict(cwd="/fixture/home", environmentMarker="fixture"))]},
                tools=[dict(label="A", cwd="/fixture/a", environmentMarker="fixture")])


class ExecutionSelectionTests(unittest.TestCase):
    def test_retains_different_plugin_child_and_correct_tool_directories(self):
        selected = MODULE.select(cohort(), "hooks")
        self.assertEqual(selected["hooks"][0]["childCwd"], "process_HOME")
        self.assertEqual(selected["hooks"][0]["location"], "session_A")
        self.assertEqual(selected["tools"][0]["cwd"], "session_A")
        self.assertEqual(selected["tools"][0]["environmentMarker"], "fixture")
        self.assertNotIn("/fixture", str(selected))

    def test_missing_actual_hooks_cannot_select_as_success(self):
        row = cohort()
        row["evidence"]["hooks"] = []
        with self.assertRaisesRegex(ValueError, "Missing actual hook"):
            MODULE.select(row, "hooks")

    def test_missing_actual_mcp_tools_cannot_select_as_success(self):
        row = cohort()
        row.update(source="session", observations=[{}], sessionDirectoriesObserved=[False, False], calls=[])
        row["tools"] = []
        with self.assertRaisesRegex(ValueError, "Missing MCP or tool"):
            MODULE.select(row, "mcp")

    def test_retains_probe_error_with_available_execution(self):
        row = cohort()
        row["errors"] = ["shutdown failed"]
        self.assertEqual(MODULE.select(row, "hooks")["errors"], ["shutdown failed"])


if __name__ == "__main__":
    unittest.main()
