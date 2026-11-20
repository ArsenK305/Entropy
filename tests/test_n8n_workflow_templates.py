import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_PATH = ROOT / "n8n" / "workflows" / "entropy-rag-drive-index.template.json"


class DriveIndexWorkflowTemplateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = TEMPLATE_PATH.read_text(encoding="utf-8")
        cls.workflow = json.loads(cls.raw)
        cls.nodes = cls.workflow["nodes"]
        cls.nodes_by_name = {node["name"]: node for node in cls.nodes}

    def test_template_is_inactive_and_has_no_runtime_or_credential_data(self):
        self.assertIs(self.workflow["active"], False)
        self.assertNotIn("id", self.workflow)
        self.assertNotIn("pinData", self.workflow)
        self.assertNotIn("meta", self.workflow)
        self.assertTrue(all("credentials" not in node for node in self.nodes))

    def test_all_workflow_exports_are_inactive_and_credential_free(self):
        for path in sorted((ROOT / "n8n" / "workflows").glob("*.json")):
            with self.subTest(workflow=path.name):
                workflow = json.loads(path.read_text(encoding="utf-8"))
                self.assertIs(workflow["active"], False)
                self.assertNotIn("id", workflow)
                self.assertNotIn("pinData", workflow)
                meta = workflow.get("meta") or {}
                if "templateCredsSetupCompleted" in meta:
                    self.assertIs(meta["templateCredsSetupCompleted"], False)
                self.assertTrue(all("credentials" not in node for node in workflow["nodes"]))

    def test_drive_folders_are_explicit_placeholders(self):
        self.assertEqual(
            self.nodes_by_name["Find career documents"]["parameters"]["filter"]["folderId"]["value"],
            "REPLACE_WITH_CAREER_FOLDER_ID",
        )
        self.assertEqual(
            self.nodes_by_name["Find product documents"]["parameters"]["filter"]["folderId"]["value"],
            "REPLACE_WITH_ENTROPY_PRODUCT_FOLDER_ID",
        )

    def test_node_ids_and_all_connections_are_valid(self):
        names = {node["name"] for node in self.nodes}
        node_ids = [node.get("id") for node in self.nodes]
        self.assertEqual(len(names), len(self.nodes))
        self.assertTrue(all(node_ids))
        self.assertEqual(len(set(node_ids)), len(node_ids))

        for source_name, output_groups in self.workflow["connections"].items():
            self.assertIn(source_name, names)
            for branches in output_groups.values():
                for branch in branches:
                    for connection in branch:
                        self.assertIn(connection["node"], names)

    def test_template_contains_no_common_secret_formats(self):
        secret_patterns = (
            r"(?i)sk-proj-[A-Za-z0-9_-]{20,}",
            r"(?i)\b\d{8,}:[A-Za-z0-9_-]{25,}",
            r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}",
            r"(?i)bearer\s+[A-Za-z0-9._~-]{20,}",
        )
        for pattern in secret_patterns:
            self.assertIsNone(re.search(pattern, self.raw))

    def test_search_template_returns_drive_source_links(self):
        search = json.loads((ROOT / "n8n" / "workflows" / "entropy-rag-search.json").read_text(encoding="utf-8"))
        formatter = next(node for node in search["nodes"] if node["name"] == "Format cited results")

        self.assertIn("source_url: point.payload?.source_url ?? null", formatter["parameters"]["jsCode"])

    def test_seed_creates_source_id_index_before_upserting_mock_points(self):
        seed_path = ROOT / "n8n" / "workflows" / "entropy-rag-seed-mock.json"
        seed = json.loads(seed_path.read_text(encoding="utf-8"))
        nodes = {node["name"]: node for node in seed["nodes"]}
        index_node = nodes["Index source_id filter"]
        scope_index_node = nodes["Index scope filter"]

        self.assertEqual(scope_index_node["parameters"]["method"], "PUT")
        self.assertIn("/collections/entropy_knowledge/index?wait=true", scope_index_node["parameters"]["url"])
        self.assertIn("field_name: 'scope'", scope_index_node["parameters"]["jsonBody"])
        self.assertIn("field_schema: 'keyword'", scope_index_node["parameters"]["jsonBody"])
        self.assertEqual(index_node["parameters"]["method"], "PUT")
        self.assertIn("/collections/entropy_knowledge/index?wait=true", index_node["parameters"]["url"])
        self.assertIn("field_name: 'source_id'", index_node["parameters"]["jsonBody"])
        self.assertIn("field_schema: 'keyword'", index_node["parameters"]["jsonBody"])

        connections = seed["connections"]
        self.assertEqual(
            connections["Index scope filter"]["main"][0][0]["node"],
            "Index source_id filter",
        )
        self.assertEqual(
            connections["Index source_id filter"]["main"][0][0]["node"],
            "Prepare mock points",
        )


if __name__ == "__main__":
    unittest.main()
