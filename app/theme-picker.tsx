"use client";

import { useEffect, useRef } from "react";
import { THEMES } from "./themes.mjs";

type ThemePickerProps = {
  theme: string;
  open: boolean;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (theme: string) => void;
};

export function ThemePicker({ theme, open, saving, onOpenChange, onSelect }: ThemePickerProps) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onOpenChange]);

  return (
    <div className="themePicker" ref={root}>
      <button ref={trigger} type="button" className={`themeTrigger ${open ? "active" : ""}`}
        aria-label="切换主题" title="切换主题" aria-expanded={open}
        onClick={() => onOpenChange(!open)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.4-3.4 1.5 1.5 0 0 1 1.1-2.6H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9Z" />
          <circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="15" cy="7.5" r="1" />
        </svg>
      </button>
      {open && <section className="themePopover" aria-label="主题颜色">
        <div className="themePopoverHead"><strong>主题颜色</strong><span>点选即保存</span></div>
        <div className="themeOptions" role="group" aria-label="选择主题">
          {THEMES.map((option) => (
            <button key={option.id} type="button" className="themeOption"
              aria-label={`使用${option.name}主题`} aria-pressed={theme === option.id}
              disabled={saving} onClick={() => onSelect(option.id)}>
              <span className="themeSwatch" data-theme={option.id} aria-hidden="true"><i /><i /><b>{theme === option.id ? "✓" : ""}</b></span>
              <span>{option.name}</span>
            </button>
          ))}
        </div>
      </section>}
    </div>
  );
}
