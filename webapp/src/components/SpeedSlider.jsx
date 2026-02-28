export default function SpeedSlider({ value, onChange }) {
  return (
    <div>
      <input
        type="range"
        min="0.1"
        max="5"
        step="0.1"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>
        {value.toFixed(1)}×
      </div>
    </div>
  );
}
