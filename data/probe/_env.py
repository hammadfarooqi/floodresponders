"""Load the repo-root .env into os.environ (stdlib only, no python-dotenv needed)."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_env(path: Path = ROOT / ".env") -> None:
    if not path.exists():
        raise SystemExit(f"missing {path}; copy .env.example to .env and fill it in")
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())
