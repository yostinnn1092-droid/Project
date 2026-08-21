import pytest

pytest_plugins = ("pytest_asyncio",)


@pytest.fixture
def anyio_backend():
    return "asyncio"
