# Roll Call

Roll Call is a fire and flood response prototype. It ranks buildings by hazard exposure, evacuation difficulty, and arrival time, then assigns nearby responders where available. A simulated manager call collects unit-level evacuation needs.

## Run locally

The component PRs are listed below while integration is in progress. Use each command in a checkout that contains the corresponding component. The map and simulated call can run independently.

| Component | Local command | Availability |
| --- | --- | --- |
| Web | From `web/`, run `npm ci` and `PORT=3000 npm run dev`. Open http://localhost:3000. | [3D map PR #33](https://github.com/hammadfarooqi/floodresponders/pull/33) includes a standalone map with mock scores. |
| API | When `api/requirements.txt` is present, run `python -m pip install -r requirements.txt` from `api/`, then `API_PORT=8000 python -m app.main`. Check http://localhost:8000/api/health. | The [scaffold was reverted](https://github.com/hammadfarooqi/floodresponders/pull/35). The [hazard model](https://github.com/hammadfarooqi/floodresponders/pull/38) and [risk scorer](https://github.com/hammadfarooqi/floodresponders/pull/39) are standalone functions. |
| Agent | From the root, run `python -m pip install -e ./agent`, then follow the simulated manager call example below. | [Manager call PR #41](https://github.com/hammadfarooqi/floodresponders/pull/41) includes the agent package and offline simulation. |
| Sample city | From the root, run `python3 data/generate_sample_city.py`. | [Sample city PR #37](https://github.com/hammadfarooqi/floodresponders/pull/37) provides fictional buildings and responders. |

Use Node.js 22 for the web app and Python 3.12 for the API and agent, matching CI. A virtual environment keeps the Python dependencies isolated.

From the agent checkout, run a fictional manager call:

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

## Configuration and data

- `PORT` and `API_PORT` set the local web and API ports. Set `NEXT_PUBLIC_API_URL=http://localhost:8000` when the web app is wired to the API.
- The standalone map, fictional JSON, and scripted call require no credentials. An optional LangChain chat model requires that model provider's package and credentials.
- CoStar Group supplies property and manager fields through CoStar, aerial footprints and elevation through Vexcel, and interior egress details through Matterport. The separate [sponsor data pipeline](https://github.com/hammadfarooqi/floodresponders/tree/hammad_1/data) uses `COSTAR_KIT_ZIP_PASSWORD`, `VEXCEL_API_KEY`, and the `MATTERPORT_API_KEY`, `MATTERPORT_API_TOKEN`, and `MATTERPORT_SDK_KEY` settings as documented there.
- The agent integration uses LangChain Deep Agents. Supabase is the planned backing store. The local fixture flow reads JSON. [CONTRACTS.md](CONTRACTS.md) lists Supabase settings for server-side integration.

See the [two-minute demo script](docs/demo.md).
