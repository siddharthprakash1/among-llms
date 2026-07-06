"use client";

// Full-viewport cinematic backdrop: moon, twinkling stars, drifting fog. The
// palette (--amb-*) is driven by the nearest [data-phase] ancestor / <html>,
// so it cross-fades between moonlit night and lantern-amber day. Star positions
// are deterministic (index-derived) to avoid SSR/CSR hydration mismatch.

const STARS = Array.from({ length: 60 }, (_, i) => ({
  x: (i * 73 + 11) % 100,
  y: ((i * i * 13 + 7) % 62),
  r: 1 + (i % 3) * 0.5,
  d: 3 + (i % 5),
  delay: (i % 7) * 0.35,
}));

export default function Ambience() {
  return (
    <div
      data-ambient
      aria-hidden
      className="fixed inset-0 z-0 overflow-hidden pointer-events-none"
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 900px at 50% -12%, var(--amb-1) 0%, transparent 60%)," +
            "radial-gradient(900px 700px at 88% 8%, var(--amb-glow) 0%, transparent 55%)," +
            "linear-gradient(180deg, var(--amb-2), var(--bg))",
          transition: "background 900ms ease",
        }}
      />
      {/* moon */}
      <div
        className="absolute rounded-full"
        style={{
          top: "5%",
          right: "11%",
          width: 118,
          height: 118,
          background:
            "radial-gradient(circle at 38% 34%, #fdfbff 0%, #c9d2ff 55%, transparent 72%)",
          boxShadow: "0 0 90px 24px var(--amb-glow)",
          animation: "moon-breathe 9s ease-in-out infinite",
          transition: "box-shadow 900ms ease",
        }}
      />
      {STARS.map((s, i) => (
        <span
          key={i}
          className="absolute rounded-full bg-white"
          style={{
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: s.r,
            height: s.r,
            animation: `twinkle ${s.d}s ease-in-out ${s.delay}s infinite`,
          }}
        />
      ))}
      {/* drifting fog banks */}
      <div
        className="absolute inset-x-[-12%] bottom-0 h-[46%]"
        style={{
          background: "radial-gradient(62% 100% at 50% 100%, var(--amb-glow), transparent 70%)",
          animation: "drift 28s ease-in-out infinite alternate",
          opacity: 0.5,
        }}
      />
      <div
        className="absolute inset-x-[-12%] bottom-[-6%] h-[34%]"
        style={{
          background: "radial-gradient(52% 100% at 38% 100%, var(--amb-glow), transparent 70%)",
          animation: "drift 37s ease-in-out infinite alternate-reverse",
          opacity: 0.34,
        }}
      />
    </div>
  );
}
