"""Small synthetic Plan v2 datasets for local development."""

from math import ceil

from app.models import (
    DemoBuilding,
    FireFront,
    FireTimeline,
    Position,
    RoadGraph,
    Station,
)

ORIGIN = (-118.350, 34.110)
STEP_MIN = 2


def rectangle(lng: float, lat: float, width: float, height: float) -> list[Position]:
    sw = (lng - width, lat - height)
    return [
        sw,
        (lng + width, lat - height),
        (lng + width, lat + height),
        (lng - width, lat + height),
        sw,
    ]


def mock_data() -> tuple[list[DemoBuilding], FireTimeline, list[Station], RoadGraph]:
    lng, lat = ORIGIN
    buildings = [
        DemoBuilding(
            id=f"mock-{row * 4 + column + 1}",
            lng=lng + (column + 0.5) * 0.002,
            lat=lat - (row + 0.5) * 0.002,
            footprint=rectangle(
                lng + (column + 0.5) * 0.002, lat - (row + 0.5) * 0.002, 0.0002, 0.00015
            ),
            height_m=9 + column * 3,
            ground_elevation_m=120 - row * 5,
            use="residential",
            units=12 + column * 4,
            people_est=26 + column * 9,
            people_need_help_est=3 + column,
            fire_arrival_min=STEP_MIN
            * max(
                ceil(((column + 0.5) * 0.002 - 0.0005) / 0.0008),
                ceil(((row + 0.5) * 0.002 - 0.0002) / 0.0002),
            ),
            costar=None,
            matterport_ids=[],
        )
        for row in range(3)
        for column in range(4)
    ]
    fire = FireTimeline(
        origin=ORIGIN,
        wind_from_deg=330,
        step_min=STEP_MIN,
        fronts=[
            FireFront(
                type="Polygon",
                coordinates=[
                    [
                        (lng - 0.0005, lat - 0.0002 - step * 0.0002),
                        (lng + 0.0005 + step * 0.0008, lat - 0.0002 - step * 0.0002),
                        (lng + 0.0005 + step * 0.0008, lat + 0.0005),
                        (lng - 0.0005, lat + 0.0005),
                        (lng - 0.0005, lat - 0.0002 - step * 0.0002),
                    ]
                ],
            )
            for step in range(31)
        ],
    )
    nodes = [
        (lng + column * 0.002, lat - row * 0.002)
        for row in range(4)
        for column in range(5)
    ]
    horizontal = [
        (row * 5 + column, row * 5 + column + 1, 184)
        for row in range(4)
        for column in range(4)
    ]
    vertical = [
        (row * 5 + column, (row + 1) * 5 + column, 222)
        for row in range(3)
        for column in range(5)
    ]
    stations = [
        Station(
            id="mock-station-1",
            name="Demo Station 1",
            lng=nodes[15][0],
            lat=nodes[15][1],
        ),
        Station(
            id="mock-station-2",
            name="Demo Station 2",
            lng=nodes[19][0],
            lat=nodes[19][1],
        ),
    ]
    return (
        buildings,
        fire,
        stations,
        RoadGraph(nodes=nodes, edges=horizontal + vertical),
    )
