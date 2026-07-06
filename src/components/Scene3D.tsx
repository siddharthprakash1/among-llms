"use client";

// The flagship 3D stage: a moonlit village clearing rendered with
// react-three-fiber. All geometry is procedural low-poly (no external assets).
// It is a PURE renderer of ReplayState — no game logic here. The camera is
// driven by the pure `directShot` director (see lib/director.ts). Loaded via
// next/dynamic (ssr:false) by the ReplayPlayer.

import { useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { Highlight, ReplayPhase, ReplaySeat } from "@/lib/replay";
import { directShot, ringPositions, Vec3 } from "@/lib/director";
import { ROLE_META } from "@/lib/ui";

interface Scene3DProps {
  seats: ReplaySeat[];
  highlight: Highlight;
  phase: ReplayPhase;
  finished: boolean;
  showRole: boolean;
  playing: boolean;
}

const TEAM_COLOR: Record<"good" | "evil" | "neutral", string> = {
  good: "#5cc8b0",
  evil: "#e0556b",
  neutral: "#d9a3ff",
};

function CameraRig({
  seatPositions,
  phase,
  finished,
  highlight,
  playing,
}: {
  seatPositions: Vec3[];
  phase: ReplayPhase;
  finished: boolean;
  highlight: Highlight;
  playing: boolean;
}) {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3(0, 0.6, 0));

  useFrame((state, delta) => {
    if (!playing) return; // OrbitControls owns the camera while paused
    const shot = directShot({
      phase,
      finished,
      highlight,
      seatPositions,
      time: state.clock.elapsedTime,
    });
    const k = 1 - Math.pow(0.001, delta); // frame-rate-independent smoothing
    camera.position.lerp(new THREE.Vector3(...shot.position), k * 0.9);
    look.current.lerp(new THREE.Vector3(...shot.target), k);
    camera.lookAt(look.current);
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov += (shot.fov - cam.fov) * k;
    cam.updateProjectionMatrix();
  });

  return null;
}

function Pawn({
  seat,
  pos,
  highlight,
  showRole,
}: {
  seat: ReplaySeat;
  pos: Vec3;
  highlight: Highlight;
  showRole: boolean;
}) {
  const reveal = showRole || seat.revealed;
  const meta = ROLE_META[seat.role];
  const speaking = highlight.speakingId === seat.id;
  const killed = highlight.killId === seat.id || highlight.eliminatedId === seat.id;
  const saved = highlight.saveId === seat.id;
  const checked = highlight.checkId === seat.id;

  const bodyColor = !seat.alive
    ? "#3a3550"
    : reveal
    ? TEAM_COLOR[meta.align]
    : "#8a7f9e";

  const emissive = speaking
    ? "#e7b94e"
    : killed
    ? "#e0556b"
    : saved
    ? "#5cc8b0"
    : checked
    ? "#8ea2ff"
    : "#000000";
  const emissiveIntensity = speaking ? 0.9 : killed || saved || checked ? 0.7 : 0;

  // dead pawns topple over
  const rotation: [number, number, number] = seat.alive ? [0, 0, 0] : [0, 0, Math.PI / 2.3];
  const y = seat.alive ? 0 : -0.15;

  return (
    <group position={[pos[0], y, pos[2]]} rotation={rotation}>
      {/* body */}
      <mesh position={[0, 0.45, 0]} castShadow>
        <cylinderGeometry args={[0.28, 0.34, 0.9, 12]} />
        <meshStandardMaterial
          color={bodyColor}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity}
          roughness={0.7}
          transparent
          opacity={seat.alive ? 1 : 0.55}
        />
      </mesh>
      {/* head */}
      <mesh position={[0, 1.05, 0]} castShadow>
        <sphereGeometry args={[0.22, 16, 16]} />
        <meshStandardMaterial
          color={bodyColor}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity * 0.6}
          roughness={0.6}
          transparent
          opacity={seat.alive ? 1 : 0.55}
        />
      </mesh>
      {/* floating nameplate / avatar */}
      <Html position={[0, 1.75, 0]} center distanceFactor={6} occlude={false} pointerEvents="none">
        <div
          style={{
            textAlign: "center",
            fontFamily: "Inter, sans-serif",
            transform: `rotate(${seat.alive ? 0 : 90}deg)`,
            opacity: seat.alive ? 1 : 0.6,
            userSelect: "none",
            width: 90,
          }}
        >
          <div style={{ fontSize: 30, lineHeight: 1, filter: seat.alive ? "none" : "grayscale(1)" }}>
            {seat.alive ? seat.avatar : "💀"}
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#ece9f5", textShadow: "0 1px 4px #000" }}>
            {seat.name}
          </div>
          {reveal && (
            <div style={{ fontSize: 11, color: "#9c98b8", textShadow: "0 1px 3px #000" }}>
              {meta.emoji} {meta.label}
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

function Lantern({ pos }: { pos: Vec3 }) {
  return (
    <group position={pos}>
      <mesh position={[0, 0.9, 0]}>
        <cylinderGeometry args={[0.05, 0.06, 1.8, 6]} />
        <meshStandardMaterial color="#2a2233" roughness={0.9} />
      </mesh>
      <mesh position={[0, 1.85, 0]}>
        <sphereGeometry args={[0.16, 12, 12]} />
        <meshStandardMaterial color="#ffcf6b" emissive="#ffbb44" emissiveIntensity={1.6} />
      </mesh>
      <pointLight position={[0, 1.85, 0]} color="#ffbb55" intensity={6} distance={6} decay={2} />
    </group>
  );
}

function Environment({ phase }: { phase: ReplayPhase }) {
  const night = phase === "night" || phase === "pregame";
  const moonColor = night ? "#aebbff" : "#ffcf9a";
  const treeRing = useMemo<Vec3[]>(() => ringPositions(14, 9), []);
  const hutRing = useMemo<Vec3[]>(() => ringPositions(5, 11).map((p) => [p[0], 0, p[2]]), []);
  const lanternRing = useMemo<Vec3[]>(() => ringPositions(4, 6).map((p) => [p[0], 0, p[2]]), []);

  return (
    <>
      <color attach="background" args={[night ? "#080b18" : "#140f1a"]} />
      <fog attach="fog" args={[night ? "#080b18" : "#140f1a", 10, 26]} />
      <ambientLight intensity={night ? 0.28 : 0.42} color={night ? "#8ea2ff" : "#ffd9a8"} />
      <directionalLight
        position={[6, 12, 4]}
        intensity={night ? 0.8 : 1.1}
        color={moonColor}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />

      {/* moon */}
      <mesh position={[-8, 9, -10]}>
        <sphereGeometry args={[1.6, 24, 24]} />
        <meshStandardMaterial color="#fdfbff" emissive={moonColor} emissiveIntensity={1.4} />
      </mesh>

      {/* ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <circleGeometry args={[16, 48]} />
        <meshStandardMaterial color={night ? "#12162b" : "#1d1622"} roughness={1} />
      </mesh>

      {/* round table */}
      <mesh position={[0, 0.3, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[2.6, 2.7, 0.5, 40]} />
        <meshStandardMaterial color="#463321" roughness={0.85} />
      </mesh>

      {/* silhouetted trees */}
      {treeRing.map((p, i) => (
        <mesh key={`t${i}`} position={[p[0], 1.4, p[2]]}>
          <coneGeometry args={[0.9, 3.4, 7]} />
          <meshStandardMaterial color="#0c1020" roughness={1} />
        </mesh>
      ))}
      {/* huts */}
      {hutRing.map((p, i) => (
        <group key={`h${i}`} position={[p[0], 0, p[2]]}>
          <mesh position={[0, 0.6, 0]}>
            <boxGeometry args={[1.6, 1.2, 1.4]} />
            <meshStandardMaterial color="#171225" roughness={1} />
          </mesh>
          <mesh position={[0, 1.5, 0]} rotation={[0, Math.PI / 4, 0]}>
            <coneGeometry args={[1.4, 1, 4]} />
            <meshStandardMaterial color="#0e0b18" roughness={1} />
          </mesh>
        </group>
      ))}
      {lanternRing.map((p, i) => (
        <Lantern key={`l${i}`} pos={p} />
      ))}
    </>
  );
}

export default function Scene3D({
  seats,
  highlight,
  phase,
  finished,
  showRole,
  playing,
}: Scene3DProps) {
  const seatPositions = useMemo<Vec3[]>(() => ringPositions(seats.length, 4.2), [seats.length]);

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [0, 7.5, 9], fov: 42 }}
      style={{ width: "100%", height: "100%" }}
    >
      <Environment phase={phase} />
      {seats.map((seat, i) => (
        <Pawn key={seat.id} seat={seat} pos={seatPositions[i]} highlight={highlight} showRole={showRole} />
      ))}
      <CameraRig
        seatPositions={seatPositions}
        phase={phase}
        finished={finished}
        highlight={highlight}
        playing={playing}
      />
      <OrbitControls
        enabled={!playing}
        enablePan={false}
        minDistance={4}
        maxDistance={16}
        maxPolarAngle={Math.PI / 2.1}
        target={[0, 0.6, 0]}
      />
      <EffectComposer>
        <Bloom intensity={0.9} luminanceThreshold={0.6} luminanceSmoothing={0.3} mipmapBlur />
        <Vignette eskil={false} offset={0.25} darkness={0.85} />
      </EffectComposer>
    </Canvas>
  );
}
