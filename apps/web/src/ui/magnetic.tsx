import type { ComponentProps, ReactElement } from "react";
import { useRef } from "react";
import { motion, useReducedMotion, useSpring } from "motion/react";

export function MagneticButton({
  children,
  className,
  disabled,
  onClick,
  type,
}: ComponentProps<"button">): ReactElement {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLButtonElement>(null);
  const sx = useSpring(0, { stiffness: 260, damping: 22 });
  const sy = useSpring(0, { stiffness: 260, damping: 22 });

  if (reduced) {
    return (
      <button className={className} disabled={disabled} onClick={onClick} type={type}>
        {children}
      </button>
    );
  }

  return (
    <motion.button
      ref={ref}
      className={className}
      disabled={disabled}
      onClick={onClick}
      type={type}
      style={{ x: sx, y: sy }}
      onPointerMove={(e) => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        sx.set((e.clientX - (rect.left + rect.width / 2)) * (3 / (rect.width / 2)));
        sy.set((e.clientY - (rect.top + rect.height / 2)) * (3 / (rect.height / 2)));
      }}
      onPointerLeave={() => { sx.set(0); sy.set(0); }}
    >
      {children}
    </motion.button>
  );
}
