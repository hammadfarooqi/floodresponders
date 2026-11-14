from fastapi.testclient import TestClient

from app.main import app


def test_health() -> None:
    origin = "http://localhost:3001"
    with TestClient(app) as client:
        response = client.get("/api/health", headers={"Origin": origin})

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["access-control-allow-origin"] == origin
