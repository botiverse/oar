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


if __name__ == "__main__":
    unittest.main()
