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

## Local manager dispatch demo

After installing the agent, run `python -m rollcall_agent.manager_dispatch_demo` and open `http://127.0.0.1:3022`.
Choose **Match and call highest risk** to start a simulated call to the highest-risk matched building.
To see a truck change assignments, select **Magnolia Court** under **Additional manager**, start its call, enter a count of 8, and report `Unit 3B needs help with stairs.`

Each call uses a fictional 555 number and a temporary ID. The demo parses the unit and type of assistance, runs the scripted Deep Agents conversation, and feeds the confirmed count into dispatch. Notifications are displayed in the UI.
Dictation requires on-device recognition and a local English speech pack. Replies play through an English system voice when available. Reports can also be typed.

The standalone demo uses its own matcher. To integrate with the app, pass the shared matching function to `rollcall_agent.dispatch.handle_event(state, event, match=...)`. The caller supplies buildings, trucks, and current assignments.

## Real phone test with Twilio

Install from the repository root with `python -m pip install -e "./agent[voice]"`. In your shell set `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` to your own Programmable Voice account and caller number. Expose
local port 3023 through an HTTPS tunnel and set `ROLLCALL_VOICE_BASE_URL` to its public origin. The server verifies
Twilio's signature on every webhook. A trial account may require a verified destination.

Run one test call to a number you control or whose owner agreed to the test:

```sh
python -m rollcall_agent.phone_call --to YOUR_TEST_NUMBER_IN_E164_FORMAT
```

When the call answers, try “Two people. Unit 3B needs help with stairs.” Twilio transcribes the response
and speaks the confirmation. The CLI outputs the count, unit, and kind of help as JSON. If a field is
missing, the call asks once more. The telephone path uses local field extraction for a quick reply.
It doesn't record the call, store the raw transcript, or dispatch a responder.
