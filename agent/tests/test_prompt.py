from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage

from rollcall_agent import answer_prompt


class OfflineChatModel(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, *args, **kwargs):
        assert isinstance(messages[-1], HumanMessage)
        assert messages[-1].text == "Summarize the simulated manager call."
        return super()._generate(messages, *args, **kwargs)


def test_answer_prompt_uses_the_supplied_model():
    model = OfflineChatModel(
        responses=[AIMessage(content="The manager reported one resident needs assistance.")]
    )

    result = answer_prompt("Summarize the simulated manager call.", model=model)

    assert result == "The manager reported one resident needs assistance."
