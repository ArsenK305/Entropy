"""Agent interface and safe local demo implementation.

This provider is deliberately deterministic. It demonstrates the handoff flow
without claiming that a language model or coding tool performed the work.
"""


MIN_OUTPUT_TOKEN_LIMIT = 300


class DemoAgentProvider:
    mode = "local-demo"

    def __init__(self, entropy_output_tokens: int = 1_200, veltrics_output_tokens: int = 800):
        self.entropy_output_tokens = entropy_output_tokens
        self.veltrics_output_tokens = veltrics_output_tokens

    def route_message(self, request_text: str, project_context: str = "", conversation_context: list[dict] | None = None, workspace: str = "general", output_token_limit: int | None = None) -> dict:
        if workspace == "career":
            return {
                "reply": "Модуль поиска работы работает только с подключённой моделью. Включи live-режим, чтобы получить разбор вакансии.",
                "delegate_to_veltrics": False,
            }
        lowered = request_text.lower()
        technical_markers = ("код", "реализ", "исправ", "разработ", "файл", "рефактор", "implement", "bug", "refactor", "veltrics")
        delegate = any(marker in lowered for marker in technical_markers)
        if delegate:
            return {
                "reply": "Понял. Оформляю техническую подзадачу для Veltrics; детали и его предложение будут отдельно в карточке.",
                "delegate_to_veltrics": True,
                "summary": "Техническая подзадача для Veltrics",
                "goal": request_text,
                "steps": ["Уточнить проверяемый результат", "Подготовить ограниченное решение", "Вернуть результат Kars"],
                "developer_task": request_text,
            }
        return {
            "reply": "Я Entropy. В демо-режиме могу поддержать диалог, но ответы пока синтетические. Для реальной работы модели включи live-режим.",
            "delegate_to_veltrics": False,
        }

    def make_plan(self, request_text: str, project_context: str = "", conversation_context: list[dict] | None = None) -> dict[str, str | list[str]]:
        cleaned = " ".join(request_text.split())
        return {
            "summary": (
                "Я понял запрос. В демо-режиме оформил его как задачу и передал Veltrics. "
                "План: уточнить ожидаемый результат, определить минимальный безопасный объём, "
                "подготовить результат и вернуть его тебе на проверку."
            ),
            "goal": cleaned,
            "steps": [
                "Определить проверяемый результат",
                "Выполнить ограниченную подзадачу",
                "Показать итог и следующий шаг Kars",
            ],
        }

    def do_developer_task(self, request_text: str, plan: dict, project_context: str = "", conversation_context: list[dict] | None = None, output_token_limit: int | None = None) -> str:
        return (
            "Это демонстрационный handoff: отдельная модель Veltrics пока не запускалась "
            "и файлы проекта этим шагом не менялись.\n\n"
            f"**Запрос:** {request_text.strip()}\n\n"
            "**Подзадача Veltrics:** подготовить реализацию после согласования требований. "
            "Когда подключим настоящую модель и инструменты, здесь появятся реальные изменения "
            "и ссылки на затронутые файлы."
        )


def build_agent_provider():
    """Use the live provider only when the user explicitly enables it."""
    import os

    mode = os.environ.get("ENTROPY_MODE", "demo").strip().lower()
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    entropy_output_tokens = _configured_output_limit("ENTROPY_MAX_OUTPUT_TOKENS", 1_200)
    veltrics_output_tokens = _configured_output_limit("VELTRICS_MAX_OUTPUT_TOKENS", 800)
    if mode != "live":
        return DemoAgentProvider(entropy_output_tokens, veltrics_output_tokens)
    if not api_key:
        raise RuntimeError(
            "ENTROPY_MODE is live, but OPENAI_API_KEY is missing. "
            "Add the key to this PyCharm run configuration, or set ENTROPY_MODE=demo."
        )

    from entropy_app.openai_provider import OpenAIResponsesProvider

    entropy_model = os.environ.get("ENTROPY_MODEL", "gpt-6.1-sol").strip()
    return OpenAIResponsesProvider(
        api_key=api_key,
        model=entropy_model,
        veltrics_model=os.environ.get("VELTRICS_MODEL", entropy_model).strip(),
        reasoning_effort=os.environ.get("ENTROPY_REASONING_EFFORT", "low").strip(),
        entropy_output_tokens=entropy_output_tokens,
        veltrics_output_tokens=veltrics_output_tokens,
    )


def _configured_output_limit(name: str, default: int) -> int:
    """Read a hard per-call output cap from the environment."""
    import os

    raw_value = os.environ.get(name, str(default)).strip()
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer between 16 and 100000.") from exc
    if not 16 <= value <= 100_000:
        raise RuntimeError(f"{name} must be an integer between 16 and 100000.")
    return value
