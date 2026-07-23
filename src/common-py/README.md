# common-py

Shared Python libraries for AgentStudio services — the Python counterpart to `src/common/`.

## Packages

### `secrets_client_py`

Python parity library for the Secrets Store CSI Driver integration.
Reads secrets from CSI-mounted files under `/mnt/secrets/<group>/<key>` and provides live rotation via inotify-backed file watching.

API and usage are documented in [`secrets_client_py/secrets_client/__init__.py`](./secrets_client_py/secrets_client/__init__.py) (module docstring) and the [`pyproject.toml`](./secrets_client_py/pyproject.toml).

## Usage

Install a package as a local editable dependency from a service's directory:

```bash
pip install -e ../../common-py/secrets_client_py
```

Or add it to `requirements.txt`:

```
-e ../../common-py/secrets_client_py
```
