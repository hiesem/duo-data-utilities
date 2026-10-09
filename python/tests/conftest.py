"""Pytest fixtures. Everything runs against a loopback mock server. Nothing touches the internet."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any

import pytest
from eth_account import Account
from helpers import MockServer, Recorded, Reply


@pytest.fixture
def mock_server() -> Iterator[Callable[[Callable[[Recorded], Reply]], MockServer]]:
    servers: list[MockServer] = []

    def make(reply: Callable[[Recorded], Reply]) -> MockServer:
        server = MockServer(reply)
        servers.append(server)
        return server

    yield make
    for server in servers:
        server.close()


@pytest.fixture
def throwaway_account() -> Any:
    # Generated at run time. The key is never written to disk or to the repository.
    return Account.create()
