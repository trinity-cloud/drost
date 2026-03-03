from __future__ import annotations

import logging

import uvicorn

from drost.config import load_settings
from drost.gateway import Gateway


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def main() -> None:
    settings = load_settings()
    configure_logging(settings.log_level)

    gateway = Gateway(settings)
    uvicorn.run(
        gateway.app,
        host=settings.gateway_host,
        port=settings.gateway_port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
