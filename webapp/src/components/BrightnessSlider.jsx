export default function BrightnessSlider({ value, onChange }) {
  const pct = Math.round((value / 255) * 100);

  return (
    <div>
      <input
        type="range"
        min="0"
        max="255"
        step="1"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
      />
      <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>
        {pct}%
      </div>
    </div>
  );
}
