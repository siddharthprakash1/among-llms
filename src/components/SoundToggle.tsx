"use client";

import { useEffect, useState } from "react";
import { loadSoundPref, playCue, setSoundEnabled } from "@/lib/sound";

export default function SoundToggle({ className = "btn btn-ghost py-1.5 px-3 text-sm" }: { className?: string }) {
  const [on, setOn] = useState(false);

  useEffect(() => {
    setOn(loadSoundPref());
  }, []);

  const toggle = () => {
    const next = !on;
    setOn(next);
    setSoundEnabled(next);
    if (next) playCue("seer"); // audible confirmation
  };

  return (
    <button
      onClick={toggle}
      title={on ? "Sound on" : "Sound off"}
      aria-label="Sound"
      aria-pressed={on}
      className={className}
    >
      {on ? "🔊" : "🔇"}
    </button>
  );
}
