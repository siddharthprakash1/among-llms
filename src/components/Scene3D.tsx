"use client";

// The flagship 3D stage: a moonlit village clearing rendered with
// react-three-fiber. All geometry is procedural low-poly (no external assets).
// It is a PURE renderer of ReplayState — no game logic here. The camera is
// driven by the pure `directShot` director (see lib/director.ts). Loaded via
// next/dynamic (ssr:false) by the ReplayPlayer.

import { RefObject, useCallback, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { GameEvent } from "@/lib/engine/types";
import { Highlight, ReplayPhase, ReplaySeat } from "@/lib/replay";
import { directShot, plateScale, plateSizeAt, ringPositions, Vec3 } from "@/lib/director";
import { ROLE_META } from "@/lib/ui";

interface Scene3DProps {
  seats: ReplaySeat[];
  highlight: Highlight;
  phase: ReplayPhase;
  finished: boolean;
  showRole: boolean;
  playing: boolean;
  thinkingId?: number;
  /** Kind of the event on screen, for the director. */
  event?: GameEvent["kind"];
}

const TEAM_COLOR: Record<"good" | "evil" | "neutral", string> = {
  good: "#5cc8b0",
  evil: "#e0556b",
  neutral: "#d9a3ff",
};

// What the free camera (OrbitControls) circles and looks at.
const ORBIT_TARGET: Vec3 = [0, 0.6, 0];

// Height of a dead seat's nameplate: low enough to read as fallen, high enough that the
// kill close-up (aimed at 1.35 from 0.6) keeps the whole sideways plate in frame.
const DEAD_PLATE_Y = 1.1;

function CameraRig({
  seatPositions,
  phase,
  finished,
  highlight,
  event,
  playing,
  taken,
}: {
  seatPositions: Vec3[];
  phase: ReplayPhase;
  finished: boolean;
  highlight: Highlight;
  event?: GameEvent["kind"];
  playing: boolean;
  /** Set once the viewer drags or zooms the stage at the end of the game. */
  taken: RefObject<boolean>;
}) {
  const { camera } = useThree();
  const pos = useRef(new THREE.Vector3());
  const look = useRef(new THREE.Vector3(...ORBIT_TARGET));
  const filming = useRef(false);

  // Priority -0.5: after OrbitControls (-1), before the nameplates (0), so each plate is
  // placed with the camera this frame renders, not last frame's.
  useFrame((state, delta) => {
    // Paused mid-game, OrbitControls owns the camera. At the end the director keeps
    // filming the finale (playback has stopped) until the viewer grabs the stage.
    if (!playing && (!finished || taken.current)) {
      filming.current = false;
      return;
    }
    if (!filming.current) {
      // Take over from the free camera, which was looking at its orbit target, so the
      // view eases from there instead of snapping to the last shot's target.
      filming.current = true;
      pos.current.copy(camera.position);
      look.current.set(...ORBIT_TARGET);
    }
    const { width, height } = state.size;
    const shot = directShot({
      phase,
      finished,
      highlight,
      seatPositions,
      time: state.clock.elapsedTime,
      event,
      aspect: height > 0 ? width / height : undefined,
    });
    const k = 1 - Math.pow(0.001, delta); // frame-rate-independent smoothing
    // The rig keeps its own position: during the finale the controls are live and clamp
    // the camera each frame (a low close-up sits below their polar limit), and that must
    // not leak into the shot.
    pos.current.lerp(new THREE.Vector3(...shot.position), k * 0.9);
    camera.position.copy(pos.current);
    look.current.lerp(new THREE.Vector3(...shot.target), k);
    camera.lookAt(look.current);
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov += (shot.fov - cam.fov) * k;
    cam.updateProjectionMatrix();
  }, -0.5);

  return null;
}

function Pawn({
  seat,
  pos,
  highlight,
  showRole,
  thinking,
  plates,
}: {
  seat: ReplaySeat;
  pos: Vec3;
  highlight: Highlight;
  showRole: boolean;
  thinking: boolean;
  /** Nameplate size relative to the usual (the director's plateScale). */
  plates: number;
}) {
  const reveal = showRole || seat.revealed;
  const meta = ROLE_META[seat.role];
  const speaking = highlight.speakingId === seat.id;
  const killed = highlight.killId === seat.id || highlight.eliminatedId === seat.id;
  const saved = highlight.saveId === seat.id;
  const checked = highlight.checkId === seat.id;

  const bodyColor = !seat.alive
    ? "#5b5578"
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
  const plateY = seat.alive ? 1.75 : DEAD_PLATE_Y;

  // The nameplate shrinks with distance as drei's distanceFactor would, but is resized only
  // when its size crosses a 2% step (plateSizeAt): resized on every frame of a camera move,
  // its emoji were redrawn every frame. Written to the DOM directly, as drei does, so a
  // frame never re-renders React.
  const sizer = useRef<HTMLDivElement>(null);
  const drawn = useRef<{ el: HTMLDivElement | null; size: number }>({ el: null, size: 0 });
  const anchor = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    const el = sizer.current;
    if (!el) return;
    anchor.set(pos[0], plateY, pos[2]);
    const size = plateSizeAt(camera.position.distanceTo(anchor), (camera as THREE.PerspectiveCamera).fov);
    if (drawn.current.el === el && drawn.current.size === size) return;
    drawn.current = { el, size };
    el.style.transform = `scale(${size})`;
  });

  return (
    <group position={[pos[0], 0, pos[2]]}>
      <group position={[0, y, 0]} rotation={rotation}>
        {/* body */}
        <mesh position={[0, 0.45, 0]} castShadow>
          <cylinderGeometry args={[0.28, 0.34, 0.9, 12]} />
          <meshStandardMaterial
            color={bodyColor}
            emissive={emissive}
            emissiveIntensity={emissiveIntensity}
            roughness={0.7}
            transparent
            opacity={seat.alive ? 1 : 0.8}
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
            opacity={seat.alive ? 1 : 0.8}
          />
        </mesh>
      </group>
      {/* Floating nameplate / avatar. A dead seat's plate stays over the seat instead of
          falling with the body (always toward -x, up to 1.7 units off), so the close-up
          on a voted-out seat and the vote crane keep it in frame. */}
      <Html position={[0, plateY, 0]} center occlude={false} pointerEvents="none">
        <div ref={sizer}>
          {/* The badge sits outside the rotated nameplate so it stays upright on a dead seat.
              The vote's larger plates (plateScale) apply here, apart from the distance size,
              so the change eases in while the camera moves; it grows about its centre, which
              stays on the anchor. */}
          <div
            style={{
              textAlign: "center",
              position: "relative",
              transform: `scale(${plates})`,
              transition: "transform 0.6s ease",
            }}
          >
            {/* Out of flow, so the centred nameplate does not shift when the badge comes and goes. */}
            {thinking && (
              <div
                style={{
                  position: "absolute",
                  // Beside the avatar, not above it: in a close-up the space above the
                  // nameplate belongs to the phase banner.
                  top: 2,
                  left: "calc(50% + 18px)",
                  width: 22,
                  height: 22,
                  display: "grid",
                  placeItems: "center",
                  fontSize: 13,
                  lineHeight: 1,
                  borderRadius: 999,
                  background: "#0a0a12",
                  border: "1px solid #b48cff",
                  boxShadow: "0 0 10px -2px #b48cff",
                }}
              >
                💭
              </div>
            )}
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
          </div>
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
      <pointLight position={[0, 1.85, 0]} color="#ffbb55" intensity={9} distance={8} decay={2} />
    </group>
  );
}

function Environment({ phase }: { phase: ReplayPhase }) {
  const night = phase === "night" || phase === "pregame";
  const moonColor = night ? "#aebbff" : "#ffcf9a";
  const treeRing = useMemo<Vec3[]>(() => ringPositions(14, 9), []);
  const hutRing = useMemo<Vec3[]>(() => ringPositions(5, 11).map((p) => [p[0], 0, p[2]]), []);
  // Outside every director camera position (the widest close-up sits at radius 7.6),
  // so a lamp post never stands between the camera and the seat it is framing.
  const lanternRing = useMemo<Vec3[]>(() => ringPositions(4, 8.1).map((p) => [p[0], 0, p[2]]), []);

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
  thinkingId,
  event,
}: Scene3DProps) {
  const seatPositions = useMemo<Vec3[]>(() => ringPositions(seats.length, 4.2), [seats.length]);
  const plates = plateScale(event);

  // A ref, not state: only the rig's frame loop reads it, so grabbing the camera
  // never re-renders the scene. Every arrival at the end starts the finale afresh.
  const cameraTaken = useRef(false);
  useEffect(() => {
    if (finished) cameraTaken.current = false;
  }, [finished]);
  // Stable, so OrbitControls does not re-subscribe its listeners on every step.
  const takeCamera = useCallback(() => {
    cameraTaken.current = true;
  }, []);

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [0, 7.5, 9], fov: 42 }}
      // Out of flow, so the canvas never holds the stage open: the stage's height
      // follows the viewport and the canvas follows the stage, both ways.
      style={{ position: "absolute", inset: 0 }}
    >
      <Environment phase={phase} />
      {seats.map((seat, i) => (
        <Pawn
          key={seat.id}
          seat={seat}
          pos={seatPositions[i]}
          highlight={highlight}
          showRole={showRole}
          thinking={thinkingId === seat.id}
          plates={plates}
        />
      ))}
      <CameraRig
        seatPositions={seatPositions}
        phase={phase}
        finished={finished}
        highlight={highlight}
        event={event}
        playing={playing}
        taken={cameraTaken}
      />
      <OrbitControls
        enabled={!playing}
        onStart={takeCamera}
        enablePan={false}
        minDistance={4}
        maxDistance={16}
        maxPolarAngle={Math.PI / 2.1}
        target={ORBIT_TARGET}
      />
      <EffectComposer>
        <Bloom intensity={0.9} luminanceThreshold={0.6} luminanceSmoothing={0.3} mipmapBlur />
        <Vignette eskil={false} offset={0.25} darkness={0.85} />
      </EffectComposer>
    </Canvas>
  );
}
