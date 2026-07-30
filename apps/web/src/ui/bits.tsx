import type { ReactElement, ReactNode } from "react";
import { useEffect } from "react";
import { motion } from "motion/react";
import { X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export function Chip({
  tone,
  icon: Icon,
  children,
}: {
  tone?: "volt" | "warn" | "danger" | undefined;
  icon?: LucideIcon | undefined;
  children: ReactNode;
}): ReactElement {
  const cls = tone === "volt" ? "chip chip-volt" : tone === "warn" ? "chip chip-warn" : tone === "danger" ? "chip chip-danger" : "chip";
  return (
    <span className={cls}>
      {Icon && <Icon size={11} strokeWidth={1.5} aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Panel({
  eyebrow,
  title,
  icon: Icon,
  children,
  className,
}: {
  eyebrow?: string | undefined;
  title?: string | undefined;
  icon?: LucideIcon | undefined;
  children: ReactNode;
  className?: string | undefined;
}): ReactElement {
  return (
    <section className={`section-panel${className ? " " + className : ""}`}>
      {(eyebrow ?? title ?? Icon) && (
        <header>
          {Icon && <Icon size={15} strokeWidth={1.5} aria-hidden="true" />}
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            {title && <h2>{title}</h2>}
          </div>
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({
  title,
  hint,
}: {
  title: string;
  hint?: string | undefined;
}): ReactElement {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
    </div>
  );
}

export function Loading({ label }: { label: string }): ReactElement {
  return (
    <div className="center-state">
      <span className="spinner" />
      {label}
    </div>
  );
}

export function Modal({
  title,
  eyebrow,
  onClose,
  children,
}: {
  title: string;
  eyebrow?: string | undefined;
  onClose: () => void;
  children: ReactNode;
}): ReactElement {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="modal"
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
      >
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2>{title}</h2>
        <button
          className="btn-icon modal-close-btn"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
        {children}
      </motion.div>
    </motion.div>
  );
}
