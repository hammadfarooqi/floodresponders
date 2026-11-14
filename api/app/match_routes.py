from fastapi import APIRouter
from pydantic import BaseModel

from app.matching import Assignment, MatchState, Policy, match

router = APIRouter()


class MatchRequest(BaseModel):
    state: MatchState
    policy: Policy


class MatchResponse(BaseModel):
    assignments: list[Assignment]


@router.post("/api/match")
def match_route(request: MatchRequest) -> MatchResponse:
    return MatchResponse(assignments=match(request.state, request.policy))
