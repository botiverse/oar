"""Run with python3 -B -m unittest discover -s experiments/sharing -p test_directory_selection.py."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("directory_selection", Path(__file__).with_name("select-directory-evidence.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PartialEvidenceTests(unittest.TestCase):
    def test_missing_installation_retains_incomplete_cohort(self):
        row = MODULE.select({"runtime": "codex", "cohorts": [{"mode": "shared", "observed": False}]}, {}, "test")
        self.assertIsNone(row["reportedVersion"])
        self.assertFalse(row["cohorts"][0]["observed"])
        self.assertEqual(row["cohorts"][0]["turns"], [])

    def test_missing_cohorts_is_not_an_installation(self):
        row = MODULE.select({"runtime": "codex"}, {}, "test")
        self.assertIsNone(row["reportedVersion"])
        self.assertEqual(row["cohorts"], [])

    def test_missing_or_null_event_is_explicitly_retained(self):
        row = {"directoryConfiguration": {"hooks": [{"revision": "A"}, {"revision": "B", "event": None}]}}
        self.assertEqual(MODULE.hooks(row), [
            {"revision": "A", "input": None, "eventMissing": True},
            {"revision": "B", "input": None, "eventMissing": True},
        ])

    def test_malformed_hook_nested_input_does_not_crash(self):
        self.assertIsNone(MODULE.hook_input({"toolCall": None}))
        self.assertIsNone(MODULE.hook_input({"tool_input": {"tool_input": None}}))

    def test_native_failure_and_exit_source_are_kept_without_identity(self):
        cohort = {"native": {"events": [{"method": "hook/completed", "params": {
            "threadId": "private", "run": {"id": "private", "sourcePath": "/private/hooks.json",
            "status": "failed", "entries": [{"kind": "error", "text": "hook exited with code 1"}]}}}]}}
        result = MODULE.native_hooks(cohort)
        self.assertEqual(result[0]["exitCode"], 1)
        self.assertEqual(result[0]["exitCodeSource"], "native completion message")
        self.assertNotIn("private", str(result))

    def test_missing_native_completion_is_not_success(self):
        self.assertEqual(MODULE.native_hooks({}), [])
        result = MODULE.native_hooks({"native": {"events": [{"method": "hook/completed", "params": {"run": {"status": "failed"}}}]}})
        self.assertIsNone(result[0]["exitCode"])
        self.assertEqual(result[0]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
