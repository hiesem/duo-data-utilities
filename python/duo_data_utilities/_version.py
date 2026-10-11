"""The package version and the User-Agent, both read from the installed package metadata (pyproject.toml)."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("duo-data-utilities")
except PackageNotFoundError:  # running from a source tree that was never installed
    __version__ = "0.0.0+unknown"

USER_AGENT = f"duo-data-utilities-py/{__version__} (+https://github.com/hiesem/duo-data-utilities)"
