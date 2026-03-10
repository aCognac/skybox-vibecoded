# skybox-vibecoded
trying out claude on skybox

## Getting started

### With VS Code

Open the project folder in VS Code, then use one of these methods:

**Run both webapp and server at once:**
- Press `Ctrl+Shift+B` (or `Cmd+Shift+B` on Mac) — this runs the default build task `Start all (webapp + server)`

**Or run them individually via the Terminal menu → Run Task:**
- `Start webapp (dev)` — starts the Vite dev server at http://localhost:5173
- `Start server (dev)` — starts the Express API server

**Debug:**
- Press `F5` → select `Open webapp in Chrome` to launch the app in a Chrome debug session
- Select `Debug server` to run the Node server with the debugger attached

### Manually

```bash
# Install dependencies (first time)
cd webapp && npm install
cd ../server && npm install

# Start webapp
cd webapp && npm run dev

# Start server (separate terminal)
cd server && npm run dev
```
