import type { ReactElement } from "react";
import { useReducedMotion } from "motion/react";
import { motion } from "motion/react";

export function KineticTitle({
  text,
  className,
}: {
  text: string;
  className?: string | undefined;
}): ReactElement {
  const reduced = useReducedMotion();

  if (reduced) {
    return <span className={className}>{text}</span>;
  }

  const chars = [...text];

  return (
    <span className={className} aria-label={text} style={{ perspective: 600 }}>
      {chars.map((char, index) => (
        <motion.span
          key={index}
          aria-hidden="true"
          initial={{ opacity: 0, y: "0.42em", rotateX: -38 }}
          animate={{ opacity: 1, y: 0, rotateX: 0 }}
          transition={{
            delay: index * 0.022,
            type: "spring",
            stiffness: 220,
            damping: 26,
          }}
          style={{ display: "inline-block", transformOrigin: "50% 0%" }}
        >
          {char === " " ? " " : char}
        </motion.span>
      ))}
    </span>
  );
}
