import { useEffect, useReducer, useCallback, useRef } from "react";
import { fetchState, patchState, resetState } from "./api.js";
import SceneSelector from "./components/SceneSelector.jsx";
import ColorPicker from "./components/ColorPicker.jsx";
import GradientEditor from "./components/GradientEditor.jsx";
import SpeedSlider from "./components/SpeedSlider.jsx";
import BrightnessSlider from "./components/BrightnessSlider.jsx";
import PowerToggle from "./components/PowerToggle.jsx";
import StatusBar from "./components/StatusBar.jsx";
import "./App.css";

const POLL_MS = 2000;

function reducer(state, action) {
  switch (action.type) {
    case "SET":      return { ...state, ...action.payload };
    case "SET_STATE": return { ...state, remote: action.payload, error: null };
    case "SET_ERROR": return { ...state, error: action.payload };
    default:         return state;
  }
}

const initialState = {
  remote: null,
  error: null,
};

export default function App() {
  const [{ remote, error }, dispatch] = useReducer(reducer, initialState);
  const pendingRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchState();
      dispatch({ type: "SET_STATE", payload: data });
    } catch (e) {
      dispatch({ type: "SET_ERROR", payload: e.message });
    }
  }, []);

  // initial load + polling
  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const update = useCallback(async (patch) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    // optimistic
    dispatch({ type: "SET_STATE", payload: { ...remote, ...patch } });
    try {
      const data = await patchState(patch);
      dispatch({ type: "SET_STATE", payload: data });
    } catch (e) {
      dispatch({ type: "SET_ERROR", payload: e.message });
      load(); // rollback
    } finally {
      pendingRef.current = false;
    }
  }, [remote, load]);

  const handleReset = async () => {
    try {
      const data = await resetState();
      dispatch({ type: "SET_STATE", payload: data });
    } catch (e) {
      dispatch({ type: "SET_ERROR", payload: e.message });
    }
  };

  if (!remote) {
    return (
      <div className="app-loading">
        {error ? `Error: ${error}` : "Connecting to server…"}
      </div>
    );
  }

  const showColor    = ["solid", "pulse"].includes(remote.scene);
  const showGradient = remote.scene === "gradient";
  const showSpeed    = ["pulse", "rainbow"].includes(remote.scene);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Skybox</h1>
        <PowerToggle on={remote.on} onChange={(on) => update({ on })} />
      </header>

      <main className="app-main">
        <section className="card">
          <h2 className="card-title">Scene</h2>
          <SceneSelector
            value={remote.scene}
            onChange={(scene) => update({ scene })}
          />
        </section>

        {showColor && (
          <section className="card">
            <h2 className="card-title">Color</h2>
            <ColorPicker
              value={remote.color}
              onChange={(color) => update({ color })}
            />
          </section>
        )}

        {showGradient && (
          <section className="card">
            <h2 className="card-title">Gradient</h2>
            <GradientEditor
              value={remote.colors}
              onChange={(colors) => update({ colors })}
            />
          </section>
        )}

        {showSpeed && (
          <section className="card">
            <h2 className="card-title">Speed</h2>
            <SpeedSlider
              value={remote.speed}
              onChange={(speed) => update({ speed })}
            />
          </section>
        )}

        <section className="card">
          <h2 className="card-title">Brightness</h2>
          <BrightnessSlider
            value={remote.brightness}
            onChange={(brightness) => update({ brightness })}
          />
        </section>

        <button className="btn-reset" onClick={handleReset}>
          Reset to defaults
        </button>
      </main>

      <StatusBar error={error} scene={remote.scene} on={remote.on} />
    </div>
  );
}
