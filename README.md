# skybox-vibecoded
trying out claude on skybox

## Getting started

### 1. Install dependencies (first time only)

```bash
cd webapp && npm install
cd ../server && npm install
```

### 2. Start the app

You need two terminals running at the same time:

**Terminal 1 — server:**
```bash
cd server && npm run dev
```
Server runs at http://localhost:3001

**Terminal 2 — webapp:**
```bash
cd webapp && npm run dev
```
Open http://localhost:5173 in your browser.

### VS Code shortcut

In VS Code you can also use `Terminal → Run Task...`:
- `Start server (dev)` — starts the Express API server
- `Start webapp (dev)` — starts the Vite dev server
