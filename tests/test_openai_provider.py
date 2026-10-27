import json
import unittest
from unittest.mock import patch

from entropy_app.openai_provider import OpenAIResponsesProvider


class OpenAIResponsesProviderTests(unittest.TestCase):
    def setUp(self):
        self.provider = OpenAIResponsesProvider(
            api_key="placeholder",
            model="entropy-model",
            veltrics_model="veltrics-model",
            entropy_output_tokens=320,
            veltrics_output_tokens=480,
        )

    def test_entropy_receives_project_and_conversation_context_with_its_limit(self):
        expected = {"reply": "Принял.", "delegate_to_veltrics": False}
        with patch.object(self.provider, "_respond", return_value=json.dumps(expected, ensure_ascii=False)) as respond:
            decision = self.provider.route_message(
                "Continue",
                project_context="Project rules",
                conversation_context=[{"speaker": "Kars", "body": "Earlier preference"}],
            )

        self.assertEqual(decision, expected)
        instructions, serialized_input, token_limit = respond.call_args.args
        model_input = json.loads(serialized_input)
        self.assertIn("AGENTS.md", instructions)
        self.assertEqual(token_limit, 320)
        self.assertEqual(model_input["project_reference"], "Project rules")
        self.assertEqual(model_input["conversation_history"][0]["body"], "Earlier preference")

    def test_route_defaults_missing_delegate_flag_to_false(self):
        with patch.object(
            self.provider,
            "_respond",
            return_value=json.dumps({"reply": "Пришли зарплатный минимум."}, ensure_ascii=False),
        ):
            decision = self.provider.route_message("What next?")

        self.assertEqual(
            decision,
            {"reply": "Пришли зарплатный минимум.", "delegate_to_veltrics": False},
        )

    def test_veltrics_uses_its_own_model_and_context_limit(self):
        with patch.object(self.provider, "_respond", return_value="Short proposal") as respond:
            result = self.provider.do_developer_task(
                "Implement a change",
                {"developer_task": "Add the feature"},
                project_context="Project rules",
                conversation_context=[{"speaker": "Entropy", "body": "The agreed plan"}],
            )

        self.assertEqual(result, "Short proposal")
        instructions, serialized_input, token_limit, model = respond.call_args.args
        handoff = json.loads(serialized_input)
        self.assertIn("AGENTS.md", instructions)
        self.assertEqual(token_limit, 480)
        self.assertEqual(model, "veltrics-model")
        self.assertEqual(handoff["project_reference"], "Project rules")
        self.assertEqual(handoff["conversation_history"][0]["body"], "The agreed plan")

    def test_output_limits_are_clamped_to_supported_local_range(self):
        provider = OpenAIResponsesProvider(
            api_key="placeholder",
            model="entropy-model",
            entropy_output_tokens=5,
            veltrics_output_tokens=200_000,
        )

        self.assertEqual(provider.entropy_output_tokens, 16)
        self.assertEqual(provider.veltrics_output_tokens, 100_000)


if __name__ == "__main__":
    unittest.main()
