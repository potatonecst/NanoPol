# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Backend development

Backend code lives in `backend/`. Use the local virtual environment in that folder.

```bash
cd backend
uv sync --group test --group dev
source .venv/bin/activate
uv run pytest -q
```

If you open the workspace in VS Code, the interpreter is pinned by `.vscode/settings.json` to `backend/.venv/bin/python`.
