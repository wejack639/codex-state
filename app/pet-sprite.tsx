"use client";

import { useEffect, useRef, useState } from "react";

export type CodexPetState =
  | "idle"
  | "running"
  | "running-left"
  | "running-right"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "review";

type PetDescriptor = {
  id: string;
  displayName: string;
  spriteVersionNumber: 1 | 2;
  spritesheetPath: string;
  revision: string;
};

type PetApiResponse = {
  ok: boolean;
  pet?: PetDescriptor;
};

type LoadedPet = PetDescriptor & {
  rows: 9 | 11;
  spritesheetUrl: string;
};

type Frame = {
  columnIndex: number;
  rowIndex: number;
  frameDurationMs: number;
};

const PET_COLUMNS = 8;
const PET_ROWS = { 1: 9, 2: 11 } as const;
const IDLE_SPEED_MULTIPLIER = 6;
const PET_REFRESH_MS = 2_000;

const idleFrames: Frame[] = [
  { rowIndex: 0, columnIndex: 0, frameDurationMs: 280 },
  { rowIndex: 0, columnIndex: 1, frameDurationMs: 110 },
  { rowIndex: 0, columnIndex: 2, frameDurationMs: 110 },
  { rowIndex: 0, columnIndex: 3, frameDurationMs: 140 },
  { rowIndex: 0, columnIndex: 4, frameDurationMs: 140 },
  { rowIndex: 0, columnIndex: 5, frameDurationMs: 320 },
];

function rowFrames(rowIndex: number, count: number, durationMs: number, lastDurationMs: number) {
  return Array.from({ length: count }, (_, columnIndex) => ({
    rowIndex,
    columnIndex,
    frameDurationMs: columnIndex === count - 1 ? lastDurationMs : durationMs,
  }));
}

const animationFrames: Record<CodexPetState, Frame[]> = {
  idle: idleFrames,
  "running-right": rowFrames(1, 8, 120, 220),
  "running-left": rowFrames(2, 8, 120, 220),
  waving: rowFrames(3, 4, 140, 280),
  jumping: rowFrames(4, 5, 140, 280),
  failed: rowFrames(5, 8, 140, 240),
  waiting: rowFrames(6, 6, 150, 260),
  running: rowFrames(7, 6, 120, 220),
  review: rowFrames(8, 6, 150, 280),
};

function framePosition(frame: Frame, rows: number) {
  return `${frame.columnIndex / (PET_COLUMNS - 1) * 100}% ${frame.rowIndex / (rows - 1) * 100}%`;
}

function animationSequence(state: CodexPetState, reducedMotion: boolean) {
  const stateFrames = animationFrames[state];
  if (reducedMotion) return { frames: [stateFrames[0]], loopStartIndex: null };

  const slowIdleFrames = idleFrames.map((frame) => ({
    ...frame,
    frameDurationMs: frame.frameDurationMs * IDLE_SPEED_MULTIPLIER,
  }));
  if (state === "idle") return { frames: slowIdleFrames, loopStartIndex: 0 };

  const actionFrames = [...stateFrames, ...stateFrames, ...stateFrames];
  return {
    frames: [...actionFrames, ...slowIdleFrames],
    loopStartIndex: actionFrames.length,
  };
}

function isPetDescriptor(value: unknown): value is PetDescriptor {
  if (!value || typeof value !== "object") return false;
  const pet = value as Partial<PetDescriptor>;
  return (
    typeof pet.id === "string" &&
    typeof pet.displayName === "string" &&
    (pet.spriteVersionNumber === 1 || pet.spriteVersionNumber === 2) &&
    typeof pet.spritesheetPath === "string" &&
    typeof pet.revision === "string"
  );
}

function preloadSpritesheet(url: string, expectedRows: number) {
  return new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth !== 1536 || image.naturalHeight !== expectedRows * 208) {
        reject(new Error("宠物图集尺寸不符合 Codex 规范"));
        return;
      }
      resolve();
    };
    image.onerror = () => reject(new Error("宠物图集无法加载"));
    image.src = url;
  });
}

export function CodexPetSprite({
  state,
  transientState = null,
}: {
  state: CodexPetState;
  transientState?: CodexPetState | null;
}) {
  const spriteRef = useRef<HTMLSpanElement>(null);
  const [pet, setPet] = useState<LoadedPet | null>(null);
  const [hovered, setHovered] = useState(false);
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    let disposed = false;
    let activeRevision: string | null = null;
    let wakingTimer: number | null = null;

    const refreshPet = async () => {
      try {
        const response = await fetch("http://127.0.0.1:43991/api/pet", { cache: "no-store" });
        const data = await response.json() as PetApiResponse;
        if (!response.ok || !data.ok || !isPetDescriptor(data.pet)) {
          throw new Error("宠物清单无效");
        }
        if (data.pet.revision === activeRevision) return;

        const rows = PET_ROWS[data.pet.spriteVersionNumber];
        const spritesheetUrl = `/pet/${encodeURIComponent(data.pet.spritesheetPath)}?v=${encodeURIComponent(data.pet.revision)}`;
        await preloadSpritesheet(spritesheetUrl, rows);
        if (disposed) return;

        activeRevision = data.pet.revision;
        setPet({ ...data.pet, rows, spritesheetUrl });
        setWaking(true);
        if (wakingTimer !== null) window.clearTimeout(wakingTimer);
        wakingTimer = window.setTimeout(() => {
          if (!disposed) setWaking(false);
        }, 2_200);
      } catch {
        if (!disposed && activeRevision === null) setPet(null);
      }
    };

    void refreshPet();
    const refreshTimer = window.setInterval(refreshPet, PET_REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      if (wakingTimer !== null) window.clearTimeout(wakingTimer);
    };
  }, []);

  const effectiveState = transientState ?? (hovered ? "jumping" : waking ? "waving" : state);

  useEffect(() => {
    const sprite = spriteRef.current;
    if (!sprite || !pet) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const { frames, loopStartIndex } = animationSequence(effectiveState, reducedMotion);
    let frameIndex = 0;
    let timer: number | null = null;

    const showFrame = () => {
      const frame = frames[frameIndex];
      sprite.style.backgroundPosition = framePosition(frame, pet.rows);
      if (frames.length === 1) return;
      timer = window.setTimeout(() => {
        frameIndex += 1;
        if (frameIndex >= frames.length) {
          if (loopStartIndex === null) return;
          frameIndex = loopStartIndex;
        }
        showFrame();
      }, frame.frameDurationMs);
    };

    showFrame();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [effectiveState, pet]);

  if (!pet) {
    return <span className="petLogo petLogoFallback" role="img" aria-label="Codex State 宠物" />;
  }

  return (
    <span
      ref={spriteRef}
      className="petLogo codexPetSprite"
      role="img"
      aria-label={pet.displayName}
      data-codex-pet-id={pet.id}
      data-codex-pet-state={effectiveState}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{
        backgroundImage: `url("${pet.spritesheetUrl}")`,
        backgroundSize: `${PET_COLUMNS * 100}% ${pet.rows * 100}%`,
      }}
    />
  );
}
