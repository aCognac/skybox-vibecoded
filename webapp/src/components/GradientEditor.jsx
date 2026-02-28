import "./GradientEditor.css";

export default function GradientEditor({ value, onChange }) {
  const [start, end] = value?.length >= 2 ? value : ["#ff6600", "#003366"];

  const gradient = `linear-gradient(to right, ${start}, ${end})`;

  return (
    <div className="gradient-editor">
      <div className="gradient-preview" style={{ background: gradient }} />
      <div className="gradient-stops">
        <div className="stop">
          <label className="stop-label">Start</label>
          <input
            type="color"
            value={start}
            onChange={(e) => onChange([e.target.value, end])}
          />
          <span className="stop-hex">{start}</span>
        </div>
        <div className="stop">
          <label className="stop-label">End</label>
          <input
            type="color"
            value={end}
            onChange={(e) => onChange([start, e.target.value])}
          />
          <span className="stop-hex">{end}</span>
        </div>
      </div>
    </div>
  );
}
