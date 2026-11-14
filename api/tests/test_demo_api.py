import json

from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from app.main import create_app
from app.mock_data import mock_data
from app.models import DemoBuilding, Station


def test_synthetic_demo_serves_the_four_datasets(tmp_path):
    buildings, fire, stations, roads = mock_data()
    with TestClient(create_app(tmp_path, use_mock_data=True)) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        assert client.get("/api/demo/buildings").json() == {
            "buildings": [building.model_dump(mode="json") for building in buildings],
        }
        assert client.get("/api/demo/fire").json() == fire.model_dump(mode="json")
        assert client.get("/api/demo/stations").json() == {
            "stations": [station.model_dump(mode="json") for station in stations],
        }
        assert client.get("/api/demo/roads").json() == roads.model_dump(mode="json")


def test_file_mode_loads_valid_data_and_reports_unavailable_data(tmp_path):
    buildings, fire, stations, _ = mock_data()
    (tmp_path / "buildings.json").write_bytes(
        TypeAdapter(list[DemoBuilding]).dump_json(buildings)
    )
    (tmp_path / "fire_timeline.json").write_text(
        fire.model_dump_json(), encoding="utf-8"
    )
    (tmp_path / "stations.json").write_bytes(
        TypeAdapter(list[Station]).dump_json(stations)
    )
    (tmp_path / "roads.json").write_text(
        json.dumps({"nodes": [[0, 0]], "edges": "invalid"}), encoding="utf-8"
    )
    with TestClient(create_app(tmp_path)) as client:
        assert client.get("/api/health").status_code == 200
        assert len(client.get("/api/demo/buildings").json()["buildings"]) == len(
            buildings
        )
        assert client.get("/api/demo/fire").json() == fire.model_dump(mode="json")
        assert len(client.get("/api/demo/stations").json()["stations"]) == len(stations)
        assert client.get("/api/demo/roads").status_code == 503
        assert client.get("/api/demo/roads").json() == {
            "detail": "Demo dataset roads.json is unavailable"
        }


def test_missing_buildings_and_browser_origin(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        response = client.get(
            "/api/demo/buildings", headers={"Origin": "http://localhost:3016"}
        )
        assert response.status_code == 503
        assert (
            response.headers["access-control-allow-origin"] == "http://localhost:3016"
        )
