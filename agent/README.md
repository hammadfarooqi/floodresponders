# Roll Call agent

From the repository root, install the editable package with `python -m pip install -e agent`.
Pass a LangChain chat model that supports tool calling, or a model ID in `provider:model` format.

For example, install `langchain-openai` and set `OPENAI_API_KEY` in your shell to try an OpenAI model.
Use a model ID available to your account.

```python
from rollcall_agent import answer_prompt

print(answer_prompt("Summarize this mock call in one sentence.", model="openai:gpt-5.4-mini"))
```

From `agent/`, install the package and check tools with `python -m pip install -r requirements.txt ruff pytest`.
Run `python -m ruff check .` and `python -m pytest`. The test uses a fake chat model and requires no API key.
