import "./StatusBar.css";

export default function StatusBar({ error, scene, on }) {
  return (
    <div className={`status-bar${error ? " error" : ""}`}>
      {error
        ? `⚠ ${error}`
        : `Scene: ${scene} · ${on ? "On" : "Off"}`}
    </div>
  );
}
