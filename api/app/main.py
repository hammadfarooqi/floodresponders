"""Local FastAPI entry point for the Plan v2 demo data."""

import argparse
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TypeVar

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import TypeAdapter, ValidationError

from app.match_routes import router as match_router
from app.mock_data import mock_data
from app.models import (
    BuildingsResponse,
    DemoBuilding,
    FireTimeline,
    RoadGraph,
    Station,
    StationsResponse,
)

DEMO_DIR = Path(__file__).resolve().parents[2] / "data" / "demo"
logger = logging.getLogger(__name__)
Dataset = TypeVar("Dataset")


def read_dataset(
    directory: Path, filename: str, schema: TypeAdapter[Dataset]
) -> Dataset | None:
    try:
        return schema.validate_json((directory / filename).read_bytes())
    except (OSError, ValidationError):
        logger.warning("Demo dataset %s is missing, unreadable, or invalid", filename)
        return None


def require_dataset(dataset: Dataset | None, filename: str) -> Dataset:
    if dataset is None:
        raise HTTPException(
            status_code=503, detail=f"Demo dataset {filename} is unavailable"
        )
    return dataset


def create_app(demo_dir: Path = DEMO_DIR, *, use_mock_data: bool = False) -> FastAPI:
    buildings: list[DemoBuilding] | None = None
    fire: FireTimeline | None = None
    stations: list[Station] | None = None
    roads: RoadGraph | None = None

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        nonlocal buildings, fire, stations, roads
        if use_mock_data:
            buildings, fire, stations, roads = mock_data()
        else:
            buildings = read_dataset(
                demo_dir, "buildings.json", TypeAdapter(list[DemoBuilding])
            )
            fire = read_dataset(
                demo_dir, "fire_timeline.json", TypeAdapter(FireTimeline)
            )
            stations = read_dataset(
                demo_dir, "stations.json", TypeAdapter(list[Station])
            )
            roads = read_dataset(demo_dir, "roads.json", TypeAdapter(RoadGraph))
        yield

    title = "Roll Call (synthetic demo)" if use_mock_data else "Roll Call"
    app = FastAPI(title=title, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://(?:localhost|127\.0\.0\.1)(?::[0-9]+)?",
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )
    app.include_router(match_router)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/demo/buildings")
    def demo_buildings() -> BuildingsResponse:
        return BuildingsResponse(buildings=require_dataset(buildings, "buildings.json"))

    @app.get("/api/demo/fire")
    def demo_fire() -> FireTimeline:
        return require_dataset(fire, "fire_timeline.json")

    @app.get("/api/demo/stations")
    def demo_stations() -> StationsResponse:
        return StationsResponse(stations=require_dataset(stations, "stations.json"))

    @app.get("/api/demo/roads")
    def demo_roads() -> RoadGraph:
        return require_dataset(roads, "roads.json")

    return app


app = create_app()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mock", action="store_true", help="Serve synthetic fixtures in memory"
    )
    args = parser.parse_args()
    uvicorn.run(
        create_app(use_mock_data=True) if args.mock else app,
        host="127.0.0.1",
        port=int(os.environ.get("API_PORT", "8000")),
    )
