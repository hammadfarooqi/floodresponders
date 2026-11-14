import io
import json

from rollcall_agent.call_chat import GREETING, reply_to_report
from rollcall_agent.telegram_demo import TelegramBot, TelegramExercise


class FakeBot:
    def __init__(self):
        self.messages = []

    def send(self, chat_id, text, *, prompt):
        self.messages.append((chat_id, text, prompt))
        return len(self.messages)


def update(text, *, chat_id=123, kind="private", reply_id=None):
    return {
        "message": {
            "chat": {"type": kind, "id": chat_id},
            "text": text,
            "reply_to_message": {"message_id": reply_id},
        }
    }


def test_telegram_uses_only_paired_private_chat_and_current_prompt():
    bot = FakeBot()
    exercise = TelegramExercise(GREETING, reply_to_report, bot)
    exercise.username = "roll_call_test_bot"
    exercise.receive(update("/start invalid"))
    exercise.receive(update(f"/start {exercise.code}", kind="group"))
    assert not exercise.snapshot()["paired"]
    assert not bot.messages

    exercise.receive(update(f"/start {exercise.code}"))
    assert exercise.snapshot()["paired"]
    assert exercise.snapshot()["link"] is None

    exercise.start()
    assert len(bot.messages) == 2
    exercise.receive(update("All clear", chat_id=456, reply_id=2))
    exercise.receive(update("All clear", reply_id=1))
    assert exercise.snapshot()["report"] == {}

    exercise.receive(update("Two people", reply_id=2))
    assert bot.messages[-1] == (123, "Which unit are they in?", True)
    exercise.receive(update("3B", reply_id=3))
    exercise.receive(update("Stairs", reply_id=4))
    assert exercise.snapshot()["complete"]
    assert exercise.snapshot()["report"] == {"count": 2, "unit": "3B", "need": "Stairs"}
    assert bot.messages[-1][2] is False
    exercise.receive(update("All clear", reply_id=4))
    assert len(bot.messages) == 5


def test_simulation_can_run_a_second_request_after_report():
    exercise = TelegramExercise(GREETING, reply_to_report)
    assert exercise.snapshot()["mock"]
    exercise.start()
    assert exercise.mock_reply("All clear")["report"]["count"] == 0
    second = exercise.start()
    assert not second["complete"]
    assert second["report"] == {}
    assert len(second["transcript"]) == 1


def test_bot_sends_a_reply_prompt_using_the_telegram_api(monkeypatch):
    def respond(request, *, timeout):
        assert request.full_url == "https://api.telegram.org/bot123:test-token/sendMessage"
        assert request.get_method() == "POST"
        assert json.loads(request.data) == {
            "chat_id": 123,
            "text": "Which unit?",
            "reply_markup": {"force_reply": True},
        }
        assert timeout == 20
        return io.BytesIO(b'{"ok":true,"result":{"message_id":7}}')

    monkeypatch.setattr("rollcall_agent.telegram_demo.urlopen", respond)
    assert TelegramBot("123:test-token").send(123, "Which unit?", prompt=True) == 7
