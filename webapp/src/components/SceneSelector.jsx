import "./SceneSelector.css";

const SCENES = [
  { id: "solid",    label: "Solid",    icon: "■" },
  { id: "gradient", label: "Gradient", icon: "▦" },
  { id: "pulse",    label: "Pulse",    icon: "◉" },
  { id: "rainbow",  label: "Rainbow",  icon: "◈" },
  { id: "off",      label: "Off",      icon: "○" },
];

export default function SceneSelector({ value, onChange }) {
  return (
    <div className="scene-grid">
      {SCENES.map((s) => (
        <button
          key={s.id}
          className={`scene-btn${value === s.id ? " active" : ""}`}
          onClick={() => onChange(s.id)}
        >
          <span className="scene-icon">{s.icon}</span>
          <span className="scene-label">{s.label}</span>
        </button>
      ))}
    </div>
  );
}
