"""The package version and the User-Agent, both read from the installed package metadata (pyproject.toml)."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

# The distribution this module belongs to (the per-service packages get a copy with their own name).
_DIST = "duo-data-utilities"

try:
    __version__ = version(_DIST)
except PackageNotFoundError:  # running from a source tree that was never installed
    __version__ = "0.0.0+unknown"

USER_AGENT = f"{_DIST}-py/{__version__} (+https://github.com/hiesem/duo-data-utilities)"
