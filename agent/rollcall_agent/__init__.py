from deepagents import create_deep_agent
from langchain_core.language_models import BaseChatModel


def answer_prompt(prompt: str, *, model: BaseChatModel | str) -> str:
    """Run one text prompt with a caller-supplied LangChain model."""
    agent = create_deep_agent(model=model)
    response = agent.invoke({"messages": [{"role": "user", "content": prompt}]})
    return response["messages"][-1].text
