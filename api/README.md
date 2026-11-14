# Roll Call demo API

Run the server from `api/` with Python 3.12 or newer.

```sh
python -m pip install -r requirements.txt
python -m app.main --mock
```

The mock mode serves 12 fictional buildings, an illustrative fire timeline, two fictional stations, and a street graph. It runs entirely from memory.
Open `http://127.0.0.1:8000/docs` to try the endpoints. Set `API_PORT` in your shell to use a different port.

Run `python -m app.main` for generated data. The server reads `data/demo/buildings.json`, `fire_timeline.json`, `stations.json`, and `roads.json` at startup. Buildings and stations are JSON arrays on disk. A missing or invalid file returns HTTP 503 from its endpoint. Restart after regenerating the files.

The data endpoints are `GET /api/demo/buildings`, `GET /api/demo/fire`, `GET /api/demo/stations`, and `GET /api/demo/roads`.

`POST /api/match` accepts `{state, policy}` and returns `{assignments}`. The state contains `now_min`, `buildings`, `trucks`, and `truck_speed_kmh`, as in the browser simulation. Try both `ours` and `nearest` in the API docs. The endpoint uses straight-line travel estimates.

`POST /api/agent/event` accepts the same `state` with a `tenant_stuck` or `driver_declines` event. It uses the risk-aware matcher and returns updated assignments, simulated notifications, and a transcript. The browser owns the simulation state and applies the report and actions. The endpoint keeps no call history and sends no external notifications.
