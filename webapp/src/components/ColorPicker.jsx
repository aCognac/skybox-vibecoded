import { useRef } from "react";
import "./ColorPicker.css";

const PRESETS = [
  "#ffffff", "#ff4444", "#ff8800", "#ffdd00",
  "#44ff88", "#00aaff", "#8844ff", "#ff44cc",
];

export default function ColorPicker({ value, onChange }) {
  const inputRef = useRef(null);

  return (
    <div className="color-picker">
      <div className="color-presets">
        {PRESETS.map((hex) => (
          <button
            key={hex}
            className={`preset-swatch${value === hex ? " active" : ""}`}
            style={{ background: hex }}
            onClick={() => onChange(hex)}
            aria-label={hex}
          />
        ))}
      </div>
      <div className="color-custom">
        <div
          className="custom-preview"
          style={{ background: value }}
          onClick={() => inputRef.current?.click()}
        />
        <input
          ref={inputRef}
          type="color"
          value={value}
          className="color-input"
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="color-hex">{value}</span>
      </div>
    </div>
  );
}
