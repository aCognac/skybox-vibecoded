import "./PowerToggle.css";

export default function PowerToggle({ on, onChange }) {
  return (
    <button
      className={`power-toggle${on ? " on" : ""}`}
      onClick={() => onChange(!on)}
      aria-label={on ? "Turn off" : "Turn on"}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M12 2v6" />
        <path d="M5.64 5.64a9 9 0 1 0 12.73 0" />
      </svg>
    </button>
  );
}
