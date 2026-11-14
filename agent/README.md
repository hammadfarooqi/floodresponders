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
Run `python -m ruff check .` and `python -m pytest`. The tests use fake chat models and require no API key.

## Simulated manager call

```python
from rollcall_agent.manager_call import run_manager_call

result = run_manager_call(
    {"name": "Juniper Apartments"},
    {"id": "engine-12", "name": "Engine 12"},
    {"disaster_type": "fire"},
)
print(result["transcript"])
print(result["residents_needing_help"])
```

The default is a fictional text exercise with one resident in unit 3B. Pass `simulated_residents=()` to exercise an all-clear or supply a tuple of `{"unit": "...", "need": "..."}` records. A caller-supplied `model` can generate the agent's spoken lines. Structured needs come from the scripted manager fixture.
